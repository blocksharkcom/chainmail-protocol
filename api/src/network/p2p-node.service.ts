import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import { Level } from 'level';
import { join } from 'path';
import { homedir } from 'os';
import { Identity } from '../crypto/interfaces/identity.interface';
import { ConnectionPoolService } from './connection-pool.service';
import { RateLimiterService } from './rate-limiter.service';

const DMAIL_DIR = join(homedir(), '.dmail');
const GLOBAL_MAIL_TOPIC = '/dmail/1.0.0/mail';
const FETCH_PROTOCOL = '/dmail/fetch/1.0.0';
const DHT_FETCH_PROTOCOL = '/dmail/storage/1.0.0/fetch';
const STORE_PROTOCOL = '/dmail/storage/1.0.0/store';

export interface MessageEnvelope {
  type?: 'sealed' | 'plain';
  to?: string;
  from?: string;
  routingToken?: string;
  payload?: unknown;
  encrypted?: unknown;
  timestamp: number;
  [key: string]: unknown;
}

export interface StoredMessage extends MessageEnvelope {
  receivedAt: number;
  read: boolean;
  dhtReplicationCount?: number;
}

export interface NodeInfo {
  peerId: string | undefined;
  address: string;
  peers: number;
  addresses: string[];
}

type MessageHandler = (envelope: MessageEnvelope) => void;

// Dynamic import helper for ESM modules
async function loadLibp2pModules() {
  const [
    { createLibp2p },
    { tcp },
    { noise },
    { yamux },
    { mdns },
    { gossipsub },
    { identify },
    { bootstrap },
    { pipe },
    lp,
    { multiaddr },
  ] = await Promise.all([
    import('libp2p'),
    import('@libp2p/tcp'),
    import('@chainsafe/libp2p-noise'),
    import('@chainsafe/libp2p-yamux'),
    import('@libp2p/mdns'),
    import('@chainsafe/libp2p-gossipsub'),
    import('@libp2p/identify'),
    import('@libp2p/bootstrap'),
    import('it-pipe'),
    import('it-length-prefixed'),
    import('@multiformats/multiaddr'),
  ]);

  return {
    createLibp2p,
    tcp,
    noise,
    yamux,
    mdns,
    gossipsub,
    identify,
    bootstrap,
    pipe,
    lp,
    multiaddr,
  };
}

@Injectable()
export class P2PNodeService implements OnModuleDestroy {
  private identity: Identity | null = null;
  private node: any = null;
  private db: Level<string, Record<string, unknown>> | null = null;
  private messageHandlers: Map<string, MessageHandler> = new Map();
  private isStarted = false;
  private libp2pModules: Awaited<ReturnType<typeof loadLibp2pModules>> | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly connectionPool: ConnectionPoolService,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /**
   * Initialize the P2P node with an identity
   */
  async initialize(identity: Identity): Promise<void> {
    this.identity = identity;

    const dbPath = join(DMAIL_DIR, 'messages', identity.address.slice(0, 16));
    this.db = new Level(dbPath, { valueEncoding: 'json' });

    // Pre-load ESM modules
    this.libp2pModules = await loadLibp2pModules();
  }

  /**
   * Start the P2P node
   */
  async start(port = 0): Promise<this> {
    if (!this.identity) {
      throw new Error('Identity not initialized');
    }

    if (!this.libp2pModules) {
      this.libp2pModules = await loadLibp2pModules();
    }

    const { createLibp2p, tcp, noise, yamux, mdns, gossipsub, identify, bootstrap } =
      this.libp2pModules;

    const bootstrapNodes = this.configService.get<string>('BOOTSTRAP_NODES');
    const bootstrapList = bootstrapNodes ? bootstrapNodes.split(',') : [];

    const peerDiscovery: unknown[] = [mdns()];
    if (bootstrapList.length > 0) {
      peerDiscovery.push(bootstrap({ list: bootstrapList }));
    }

    this.node = await createLibp2p({
      addresses: {
        listen: [`/ip4/0.0.0.0/tcp/${port || 0}`],
      },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery: peerDiscovery as any,
      services: {
        identify: identify() as any,
        pubsub: gossipsub({
          emitSelf: true,
          fallbackToFloodsub: true,
          floodPublish: true,
          allowPublishToZeroTopicPeers: true,
        }) as any,
      },
    });

    await this.node.start();

    // Initialize connection pool
    this.connectionPool.initialize(this.node);
    await this.connectionPool.start();

    // Subscribe to global mail topic
    (this.node.services.pubsub as any).subscribe(GLOBAL_MAIL_TOPIC);

    (this.node.services.pubsub as any).addEventListener('message', (evt: any) => {
      this.handleIncomingMessage(evt.detail);
    });

    this.isStarted = true;

    // Connect to relay hosts
    await this.connectToRelaysAndFetch();

    return this;
  }

  /**
   * Stop the P2P node
   */
  async stop(): Promise<void> {
    this.connectionPool.stop();

    if (this.node) {
      await this.node.stop();
      this.node = null;
    }

    if (this.db) {
      await this.db.close();
      this.db = null;
    }

    this.isStarted = false;
  }

  /**
   * Connect to configured relay hosts and fetch stored messages
   */
  private async connectToRelaysAndFetch(): Promise<void> {
    if (!this.libp2pModules) return;

    const { multiaddr } = this.libp2pModules;
    const relayHosts = this.configService.get<string>('RELAY_HOSTS');
    if (!relayHosts) return;

    const hosts = relayHosts.split(',');

    await new Promise((resolve) => setTimeout(resolve, 1000));

    for (const hostPort of hosts) {
      try {
        const [host, port] = hostPort.split(':');
        const ma = multiaddr(`/dns4/${host}/tcp/${port}`);

        const connection = await this.node!.dial(ma);

        try {
          await this.fetchFromPeer(connection.remotePeer);
        } catch {
          // Fetch failed
        }
      } catch {
        // Connection failed
      }
    }
  }

  /**
   * Fetch stored messages from connected relay nodes
   */
  async fetchStoredMessages(): Promise<void> {
    const peers = this.node?.getConnections() || [];
    if (peers.length === 0) return;

    await this.fetchFromAllPeers();
  }

  /**
   * Fetch stored messages from a specific peer
   */
  private async fetchFromPeer(peerId: any): Promise<void> {
    try {
      await this.fetchFromPeerDHT(peerId);
    } catch {
      await this.fetchFromPeerLegacy(peerId);
    }
  }

  /**
   * Fetch using DHT storage protocol
   */
  private async fetchFromPeerDHT(peerId: any): Promise<void> {
    if (!this.identity || !this.node || !this.libp2pModules) return;

    const { pipe, lp } = this.libp2pModules;
    const stream = await this.node.dialProtocol(peerId, DHT_FETCH_PROTOCOL);

    const request = JSON.stringify({
      action: 'fetch',
      recipient: this.identity.address,
      routingToken: this.generateRoutingToken(this.identity.address),
    });

    await pipe(
      [new TextEncoder().encode(request)],
      (source: any) => lp.encode(source),
      stream.sink,
    );

    let responseData = '';
    for await (const msg of lp.decode(stream.source as any)) {
      responseData = new TextDecoder().decode(msg.subarray());
      break;
    }

    const response = JSON.parse(responseData);

    if (response.error) {
      throw new Error(response.error);
    }

    if (response.messages && response.messages.length > 0) {
      for (const record of response.messages) {
        try {
          const data = Buffer.from(record.data, 'base64').toString();
          const envelope = JSON.parse(data) as MessageEnvelope;
          const messageId = this.getMessageId(envelope);

          await this.storeMessage(messageId, {
            ...envelope,
            dhtReplicationCount: record.replicationCount,
          });

          for (const handler of this.messageHandlers.values()) {
            handler(envelope);
          }
        } catch {
          // Failed to process stored message
        }
      }
    }
  }

  /**
   * Fetch using legacy protocol
   */
  private async fetchFromPeerLegacy(peerId: any): Promise<void> {
    if (!this.identity || !this.node || !this.libp2pModules) return;

    const { pipe, lp } = this.libp2pModules;
    const stream = await this.node.dialProtocol(peerId, FETCH_PROTOCOL);

    const request = JSON.stringify({ address: this.identity.address });
    await pipe(
      [new TextEncoder().encode(request)],
      (source: any) => lp.encode(source),
      stream.sink,
    );

    let responseData = '';
    for await (const msg of lp.decode(stream.source as any)) {
      responseData = new TextDecoder().decode(msg.subarray());
      break;
    }

    const response = JSON.parse(responseData);

    if (response.messages && response.messages.length > 0) {
      for (const msg of response.messages) {
        try {
          const data = Buffer.from(msg.data, 'base64').toString();
          const envelope = JSON.parse(data) as MessageEnvelope;
          const messageId = this.getMessageId(envelope);

          await this.storeMessage(messageId, envelope);

          for (const handler of this.messageHandlers.values()) {
            handler(envelope);
          }
        } catch {
          // Failed to process stored message
        }
      }
    }
  }

  /**
   * Fetch messages from ALL connected peers
   */
  private async fetchFromAllPeers(): Promise<void> {
    const peers = this.node?.getConnections() || [];
    if (peers.length === 0) return;

    const seenMessages = new Set<string>();

    for (const connection of peers) {
      try {
        const messages = await this.fetchMessagesFromPeer(connection.remotePeer);

        for (const msg of messages) {
          const id = msg.id || this.getMessageId(msg.envelope);
          if (!seenMessages.has(id)) {
            seenMessages.add(id);
            await this.storeMessage(id, msg.envelope);
            for (const handler of this.messageHandlers.values()) {
              handler(msg.envelope);
            }
          }
        }
      } catch {
        // Peer may not support fetch protocol
      }
    }
  }

  /**
   * Fetch messages from a peer without storing
   */
  private async fetchMessagesFromPeer(
    peerId: any,
  ): Promise<{ id?: string; envelope: MessageEnvelope; replicationCount?: number }[]> {
    const messages: { id?: string; envelope: MessageEnvelope; replicationCount?: number }[] = [];

    if (!this.identity || !this.node || !this.libp2pModules) return messages;

    const { pipe, lp } = this.libp2pModules;

    try {
      const stream = await this.node.dialProtocol(peerId, DHT_FETCH_PROTOCOL);

      const request = JSON.stringify({
        action: 'fetch',
        recipient: this.identity.address,
        routingToken: this.generateRoutingToken(this.identity.address),
      });

      await pipe(
        [new TextEncoder().encode(request)],
        (source: any) => lp.encode(source),
        stream.sink,
      );

      let responseData = '';
      for await (const msg of lp.decode(stream.source as any)) {
        responseData = new TextDecoder().decode(msg.subarray());
        break;
      }

      const response = JSON.parse(responseData);

      if (response.messages) {
        for (const record of response.messages) {
          const data = Buffer.from(record.data, 'base64').toString();
          const envelope = JSON.parse(data);
          messages.push({
            id: record.id,
            envelope,
            replicationCount: record.replicationCount,
          });
        }
      }
    } catch {
      // Try legacy protocol
      try {
        const stream = await this.node.dialProtocol(peerId, FETCH_PROTOCOL);
        const request = JSON.stringify({ address: this.identity.address });

        await pipe(
          [new TextEncoder().encode(request)],
          (source: any) => lp.encode(source),
          stream.sink,
        );

        let responseData = '';
        for await (const msg of lp.decode(stream.source as any)) {
          responseData = new TextDecoder().decode(msg.subarray());
          break;
        }

        const response = JSON.parse(responseData);
        if (response.messages) {
          for (const msg of response.messages) {
            const data = Buffer.from(msg.data, 'base64').toString();
            const envelope = JSON.parse(data);
            messages.push({ envelope });
          }
        }
      } catch {
        // Neither protocol supported
      }
    }

    return messages;
  }

  /**
   * Send a message
   */
  async sendMessage(envelope: MessageEnvelope): Promise<string> {
    if (!this.identity || !this.node || !this.db) {
      throw new Error('Node not initialized');
    }

    // Rate limiting check
    const rateResult = this.rateLimiter.checkAndRecord(this.identity.address);
    if (!rateResult.allowed) {
      throw new Error(`Rate limited: ${rateResult.reason}`);
    }

    // Publish to global topic
    const data = new TextEncoder().encode(JSON.stringify(envelope));
    await (this.node.services.pubsub as any).publish(GLOBAL_MAIL_TOPIC, data);

    const messageId = this.getMessageId(envelope);
    await this.db.put(`sent:${messageId}`, {
      ...envelope,
      sentAt: Date.now(),
    } as Record<string, unknown>);

    // Self-delivery
    if (envelope.to === this.identity.address) {
      await this.storeMessage(messageId, envelope);
    }

    // Direct store to relays
    await this.storeOnRelays(envelope);

    return messageId;
  }

  /**
   * Store message directly on connected relay nodes
   */
  private async storeOnRelays(envelope: MessageEnvelope): Promise<void> {
    if (!this.node || !this.libp2pModules) return;

    const { pipe, lp } = this.libp2pModules;
    const connections = this.node.getConnections();
    if (connections.length === 0) return;

    const storageKey =
      envelope.type === 'sealed' && envelope.routingToken
        ? envelope.routingToken
        : envelope.to;

    if (!storageKey) return;

    const base64Data = Buffer.from(JSON.stringify(envelope)).toString('base64');

    for (const connection of connections) {
      try {
        const stream = await this.node.dialProtocol(connection.remotePeer, STORE_PROTOCOL);

        const request = JSON.stringify({
          action: 'store',
          record: {
            recipient: storageKey,
            data: base64Data,
            timestamp: Date.now(),
          },
        });

        await pipe(
          [new TextEncoder().encode(request)],
          (source: any) => lp.encode(source),
          stream.sink,
        );

        for await (const msg of lp.decode(stream.source as any)) {
          const responseData = new TextDecoder().decode(msg.subarray());
          const response = JSON.parse(responseData);
          if (response.success) {
            this.connectionPool.recordRelaySuccess(connection.remotePeer.toString(), 0);
          }
          break;
        }
      } catch {
        this.connectionPool.recordRelayFailure(connection.remotePeer.toString());
      }
    }
  }

  /**
   * Handle incoming message
   */
  private async handleIncomingMessage(message: { data: Uint8Array }): Promise<void> {
    if (!this.identity || !this.db) return;

    try {
      const data = new TextDecoder().decode(message.data);
      const envelope = JSON.parse(data) as MessageEnvelope;

      let isForUs = false;

      if (envelope.type === 'sealed' && envelope.routingToken) {
        const myRoutingToken = this.generateRoutingToken(this.identity.address);
        isForUs = envelope.routingToken === myRoutingToken;
      } else if (envelope.to === this.identity.address) {
        isForUs = true;
      }

      if (isForUs) {
        const messageId = this.getMessageId(envelope);
        await this.storeMessage(messageId, envelope);

        for (const handler of this.messageHandlers.values()) {
          handler(envelope);
        }
      }
    } catch {
      // Failed to process incoming message
    }
  }

  /**
   * Generate routing token from address
   */
  generateRoutingToken(address: string): string {
    const addressBytes = new TextEncoder().encode(address);
    const token = hkdf(
      sha256,
      addressBytes,
      undefined,
      new TextEncoder().encode('dmail-routing-v2'),
      16,
    );
    return Buffer.from(token).toString('hex');
  }

  /**
   * Store a message
   */
  private async storeMessage(messageId: string, envelope: MessageEnvelope): Promise<void> {
    if (!this.db) return;

    await this.db.put(`inbox:${messageId}`, {
      ...envelope,
      receivedAt: Date.now(),
      read: false,
    } as Record<string, unknown>);
  }

  /**
   * Get message ID
   */
  getMessageId(envelope: MessageEnvelope): string {
    const data = JSON.stringify({
      routingToken: envelope.routingToken,
      payloadHash: envelope.payload
        ? sha256(new TextEncoder().encode(JSON.stringify(envelope.payload)))
        : envelope.encrypted
          ? sha256(new TextEncoder().encode(JSON.stringify(envelope.encrypted)))
          : null,
      timestamp: envelope.timestamp,
    });
    const hash = sha256(new TextEncoder().encode(data));
    return Buffer.from(hash).toString('hex').slice(0, 32);
  }

  /**
   * Get inbox messages
   */
  async getInbox(): Promise<StoredMessage[]> {
    if (!this.db) return [];

    await this.fetchStoredMessages();

    const messages: StoredMessage[] = [];
    for await (const [key, value] of this.db.iterator()) {
      if ((key as string).startsWith('inbox:')) {
        messages.push({ id: (key as string).slice(6), ...(value as StoredMessage) });
      }
    }
    return messages.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Get a specific message
   */
  async getMessage(messageId: string): Promise<StoredMessage | null> {
    if (!this.db) return null;

    try {
      return (await this.db.get(`inbox:${messageId}`)) as StoredMessage;
    } catch {
      return null;
    }
  }

  /**
   * Mark message as read
   */
  async markAsRead(messageId: string): Promise<void> {
    const msg = await this.getMessage(messageId);
    if (msg && this.db) {
      msg.read = true;
      await this.db.put(`inbox:${messageId}`, msg);
    }
  }

  /**
   * Delete a message
   */
  async deleteMessage(messageId: string): Promise<void> {
    if (!this.db) return;
    await this.db.del(`inbox:${messageId}`);
  }

  /**
   * Register a message handler
   */
  onMessage(id: string, handler: MessageHandler): () => void {
    this.messageHandlers.set(id, handler);
    return () => this.messageHandlers.delete(id);
  }

  /**
   * Get peer count
   */
  getPeerCount(): number {
    return this.node?.getConnections().length || 0;
  }

  /**
   * Get node info
   */
  getInfo(): NodeInfo {
    return {
      peerId: this.node?.peerId.toString(),
      address: this.identity?.address || '',
      peers: this.getPeerCount(),
      addresses: this.node?.getMultiaddrs().map((a: any) => a.toString()) || [],
    };
  }

  /**
   * Check if node is started
   */
  isNodeStarted(): boolean {
    return this.isStarted;
  }

  /**
   * Get the libp2p node instance
   */
  getNode(): any {
    return this.node;
  }
}
