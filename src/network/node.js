/**
 * P2P Network Node for dMail
 *
 * Uses libp2p with floodsub for message pub/sub
 */

import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { mdns } from '@libp2p/mdns';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { bootstrap } from '@libp2p/bootstrap';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import { Level } from 'level';
import { join } from 'path';
import { pipe } from 'it-pipe';
import * as lp from 'it-length-prefixed';
import { DMAIL_DIR } from '../crypto/identity.js';
import { multiaddr } from '@multiformats/multiaddr';

// Bootstrap relay nodes (Docker internal network) - requires full multiaddr with peer ID
const BOOTSTRAP_NODES = process.env.BOOTSTRAP_NODES
  ? process.env.BOOTSTRAP_NODES.split(',')
  : [];

// Relay hosts to connect to (hostname:port format, will discover peer IDs dynamically)
const RELAY_HOSTS = process.env.RELAY_HOSTS
  ? process.env.RELAY_HOSTS.split(',')
  : [];

// Protocols for fetching stored messages from relays
const FETCH_PROTOCOL = '/dmail/fetch/1.0.0'; // Legacy
const DHT_FETCH_PROTOCOL = '/dmail/storage/1.0.0/fetch'; // DHT-based

// Single global topic for all messages (messages are encrypted, so this is safe)
const GLOBAL_MAIL_TOPIC = '/dmail/1.0.0/mail';

export class DMailNode {
  constructor(identity) {
    this.identity = identity;
    this.node = null;
    this.messageHandlers = new Map();
    // Use unique database path per identity to avoid conflicts when multiple users run on same server
    const dbPath = join(DMAIL_DIR, 'messages', identity.address.slice(0, 16));
    this.db = new Level(dbPath, { valueEncoding: 'json' });
  }

  async start(port = 0) {
    // Configure peer discovery
    const peerDiscovery = [mdns()];
    if (BOOTSTRAP_NODES.length > 0) {
      peerDiscovery.push(bootstrap({ list: BOOTSTRAP_NODES }));
    }

    this.node = await createLibp2p({
      addresses: {
        listen: [`/ip4/0.0.0.0/tcp/${port || 0}`]
      },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery,
      services: {
        identify: identify(),
        pubsub: gossipsub({
          emitSelf: true, // Important: receive our own messages
          gossipIncoming: true,
          fallbackToFloodsub: true,
          floodPublish: true,
          allowPublishToZeroPeers: true
        })
      }
    });

    await this.node.start();

    // Subscribe to the global mail topic (all messages go through this)
    this.node.services.pubsub.subscribe(GLOBAL_MAIL_TOPIC);
    console.log(`Subscribed to topic: ${GLOBAL_MAIL_TOPIC}`);

    this.node.services.pubsub.addEventListener('message', (evt) => {
      this.handleIncomingMessage(evt.detail);
    });

    // SECURITY: Don't log peer IDs or sensitive network info in production
    if (process.env.NODE_ENV === 'development') {
      this.node.addEventListener('peer:discovery', (evt) => {
        console.log('Peer discovered');
      });

      this.node.addEventListener('peer:connect', (evt) => {
        console.log('Peer connected');
      });
    }

    // Only log minimal startup info
    console.log('dMail node started');

    // Connect to relay hosts and fetch stored messages
    this.connectToRelaysAndFetch();

    return this;
  }

  /**
   * Connect to configured relay hosts and fetch stored messages
   */
  async connectToRelaysAndFetch() {
    if (RELAY_HOSTS.length === 0) {
      console.log('No relay hosts configured');
      return;
    }

    console.log(`Connecting to ${RELAY_HOSTS.length} relay hosts...`);

    // Give libp2p a moment to start
    await new Promise(resolve => setTimeout(resolve, 1000));

    for (const hostPort of RELAY_HOSTS) {
      try {
        const [host, port] = hostPort.split(':');
        const ma = multiaddr(`/dns4/${host}/tcp/${port}`);
        console.log(`Dialing relay: ${ma.toString()}`);

        // Dial the relay - libp2p will discover the peer ID
        const connection = await this.node.dial(ma);
        console.log(`Connected to relay: ${connection.remotePeer.toString().slice(0, 16)}...`);

        // Fetch stored messages from this relay
        try {
          await this.fetchFromPeer(connection.remotePeer);
        } catch (e) {
          console.log(`Fetch from relay failed: ${e.message}`);
        }
      } catch (e) {
        console.error(`Failed to connect to relay ${hostPort}: ${e.message}`);
      }
    }
  }

  /**
   * Fetch stored messages from connected relay nodes
   * Uses DHT-style fetch from all peers for redundancy
   */
  async fetchStoredMessages() {
    const peers = this.node.getConnections();
    if (peers.length === 0) {
      console.log('No relay peers connected, skipping fetch');
      return;
    }

    // Use DHT-style fetch from all peers
    await this.fetchFromAllPeers();
  }

  /**
   * Fetch stored messages from a specific peer
   * Tries DHT protocol first, falls back to legacy
   */
  async fetchFromPeer(peerId) {
    // Try DHT fetch protocol first
    try {
      await this.fetchFromPeerDHT(peerId);
      return;
    } catch (e) {
      console.log(`DHT fetch not available, trying legacy protocol...`);
    }

    // Fall back to legacy protocol
    await this.fetchFromPeerLegacy(peerId);
  }

  /**
   * Fetch using DHT storage protocol
   */
  async fetchFromPeerDHT(peerId) {
    const stream = await this.node.dialProtocol(peerId, DHT_FETCH_PROTOCOL);

    // Send fetch request with both address and routing token
    // Relay stores by routing token for sealed envelopes, by address for plain
    const request = JSON.stringify({
      action: 'fetch',
      recipient: this.identity.address,
      routingToken: this.generateRoutingToken(this.identity.address)
    });

    await pipe(
      [new TextEncoder().encode(request)],
      (source) => lp.encode(source),
      stream.sink
    );

    // Read response
    let responseData = '';
    for await (const msg of lp.decode(stream.source)) {
      responseData = new TextDecoder().decode(msg.subarray());
      break;
    }

    const response = JSON.parse(responseData);

    if (response.error) {
      throw new Error(response.error);
    }

    if (response.messages && response.messages.length > 0) {
      console.log(`Received ${response.messages.length} stored messages (DHT)`);

      for (const record of response.messages) {
        try {
          // Decode base64 data and parse envelope
          const data = Buffer.from(record.data, 'base64').toString();
          const envelope = JSON.parse(data);
          const messageId = this.getMessageId(envelope);

          // Store in inbox with replication info
          await this.storeMessage(messageId, {
            ...envelope,
            dhtReplicationCount: record.replicationCount
          });

          // Notify handlers
          for (const handler of this.messageHandlers.values()) {
            handler(envelope);
          }
        } catch (e) {
          console.error('Failed to process stored message:', e.message);
        }
      }
    }
  }

  /**
   * Fetch using legacy protocol (backward compatibility)
   */
  async fetchFromPeerLegacy(peerId) {
    const stream = await this.node.dialProtocol(peerId, FETCH_PROTOCOL);

    // Send our address
    const request = JSON.stringify({ address: this.identity.address });
    await pipe(
      [new TextEncoder().encode(request)],
      (source) => lp.encode(source),
      stream.sink
    );

    // Read response
    let responseData = '';
    for await (const msg of lp.decode(stream.source)) {
      responseData = new TextDecoder().decode(msg.subarray());
      break;
    }

    const response = JSON.parse(responseData);

    if (response.error) {
      console.error('Fetch error:', response.error);
      return;
    }

    if (response.messages && response.messages.length > 0) {
      console.log(`Received ${response.messages.length} stored messages (legacy)`);

      for (const msg of response.messages) {
        try {
          // Decode base64 data and parse envelope
          const data = Buffer.from(msg.data, 'base64').toString();
          const envelope = JSON.parse(data);
          const messageId = this.getMessageId(envelope);

          // Store in inbox
          await this.storeMessage(messageId, envelope);

          // Notify handlers
          for (const handler of this.messageHandlers.values()) {
            handler(envelope);
          }
        } catch (e) {
          console.error('Failed to process stored message:', e.message);
        }
      }
    }
  }

  /**
   * Fetch messages from ALL connected peers (DHT-style)
   * This ensures we get messages even if some relays are down
   */
  async fetchFromAllPeers() {
    const peers = this.node.getConnections();
    if (peers.length === 0) {
      console.log('No peers connected');
      return;
    }

    console.log(`Fetching from ${peers.length} peers...`);
    const seenMessages = new Set();

    for (const connection of peers) {
      try {
        // Temporarily collect messages before storing
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
      } catch (e) {
        // Peer may not support fetch protocol
      }
    }

    console.log(`Found ${seenMessages.size} unique messages from network`);
  }

  /**
   * Fetch messages from a peer without storing (for deduplication)
   */
  async fetchMessagesFromPeer(peerId) {
    const messages = [];

    try {
      const stream = await this.node.dialProtocol(peerId, DHT_FETCH_PROTOCOL);

      // Send both address and routing token for full coverage
      const request = JSON.stringify({
        action: 'fetch',
        recipient: this.identity.address,
        routingToken: this.generateRoutingToken(this.identity.address)
      });

      await pipe(
        [new TextEncoder().encode(request)],
        (source) => lp.encode(source),
        stream.sink
      );

      let responseData = '';
      for await (const msg of lp.decode(stream.source)) {
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
            replicationCount: record.replicationCount
          });
        }
      }
    } catch (e) {
      // Try legacy protocol
      try {
        const stream = await this.node.dialProtocol(peerId, FETCH_PROTOCOL);
        const request = JSON.stringify({ address: this.identity.address });

        await pipe(
          [new TextEncoder().encode(request)],
          (source) => lp.encode(source),
          stream.sink
        );

        let responseData = '';
        for await (const msg of lp.decode(stream.source)) {
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
      } catch (e2) {
        // Neither protocol supported
      }
    }

    return messages;
  }

  async stop() {
    if (this.node) {
      await this.node.stop();
      await this.db.close();
    }
  }

  getAddressTopic(address) {
    return `/dmail/1.0.0/inbox/${address}`;
  }

  async sendMessage(envelope) {
    // Use global topic - messages are encrypted so this is safe
    const data = new TextEncoder().encode(JSON.stringify(envelope));
    await this.node.services.pubsub.publish(GLOBAL_MAIL_TOPIC, data);

    const messageId = this.getMessageId(envelope);
    await this.db.put(`sent:${messageId}`, { ...envelope, sentAt: Date.now() });

    // Self-delivery: if sending to yourself, also store in inbox
    if (envelope.to === this.identity.address) {
      await this.storeMessage(messageId, envelope);
    }

    // Direct store to relays for reliable delivery (gossipsub mesh may not be formed yet)
    await this.storeOnRelays(envelope);

    // SECURITY: Don't log recipient addresses
    console.log('Message sent to global topic');
    return messageId;
  }

  /**
   * Store message directly on connected relay nodes
   * This ensures reliable delivery even when gossipsub mesh isn't formed
   */
  async storeOnRelays(envelope) {
    const connections = this.node.getConnections();
    if (connections.length === 0) {
      console.log('No relay connections for direct store');
      return;
    }

    // Get the storage key (routing token for sealed, address for plain)
    const storageKey = envelope.type === 'sealed' && envelope.routingToken
      ? envelope.routingToken
      : envelope.to;

    if (!storageKey) {
      console.log('No storage key for direct store');
      return;
    }

    const base64Data = Buffer.from(JSON.stringify(envelope)).toString('base64');
    const storeProtocol = '/dmail/storage/1.0.0/store';

    for (const connection of connections) {
      try {
        const stream = await this.node.dialProtocol(connection.remotePeer, storeProtocol);

        const request = JSON.stringify({
          action: 'store',
          record: {
            recipient: storageKey,
            data: base64Data,
            timestamp: Date.now()
          }
        });

        await pipe(
          [new TextEncoder().encode(request)],
          (source) => lp.encode(source),
          stream.sink
        );

        // Read response
        let responseData = '';
        for await (const msg of lp.decode(stream.source)) {
          responseData = new TextDecoder().decode(msg.subarray());
          break;
        }

        const response = JSON.parse(responseData);
        if (response.success) {
          console.log(`Direct store to relay: ${connection.remotePeer.toString().slice(0, 16)}...`);
        }
      } catch (e) {
        // Relay may not support store protocol
        console.log(`Direct store failed: ${e.message}`);
      }
    }
  }

  async handleIncomingMessage(message) {
    try {
      const data = new TextDecoder().decode(message.data);
      const envelope = JSON.parse(data);

      // Check if message is for us using routing token (sealed envelope) or direct address
      let isForUs = false;

      if (envelope.type === 'sealed' && envelope.routingToken) {
        // Sealed envelope - check routing token
        const myRoutingToken = this.generateRoutingToken(this.identity.address);
        isForUs = envelope.routingToken === myRoutingToken;
        console.log('Sealed envelope, routing token match:', isForUs);
      } else if (envelope.to === this.identity.address) {
        // Plain envelope - check direct address
        isForUs = true;
        console.log('Plain envelope for us');
      }

      if (isForUs) {
        const messageId = this.getMessageId(envelope);
        console.log('Storing message with ID:', messageId);
        await this.storeMessage(messageId, envelope);

        for (const handler of this.messageHandlers.values()) {
          handler(envelope);
        }
        console.log('Received and stored message for us');
      }
    } catch (e) {
      console.error('Failed to process incoming message:', e.message, e.stack);
    }
  }

  /**
   * Generate routing token from address (must match sealed-envelope.js implementation)
   */
  generateRoutingToken(address) {
    const addressBytes = new TextEncoder().encode(address);
    const token = hkdf(sha256, addressBytes, undefined, new TextEncoder().encode('dmail-routing-v2'), 16);
    return Buffer.from(token).toString('hex');
  }

  async storeMessage(messageId, envelope) {
    await this.db.put(`inbox:${messageId}`, {
      ...envelope,
      receivedAt: Date.now(),
      read: false
    });
  }

  getMessageId(envelope) {
    // SECURITY: Only use encrypted data for ID generation
    // Never include plaintext subject or other sensitive data
    const data = JSON.stringify({
      // Use routing token if available (sealed envelope)
      routingToken: envelope.routingToken,
      // Use encrypted payload hash
      payloadHash: envelope.payload
        ? sha256(new TextEncoder().encode(JSON.stringify(envelope.payload)))
        : envelope.encrypted
          ? sha256(new TextEncoder().encode(JSON.stringify(envelope.encrypted)))
          : null,
      timestamp: envelope.timestamp
    });
    const hash = sha256(new TextEncoder().encode(data));
    return Buffer.from(hash).toString('hex').slice(0, 32);
  }

  async getInbox() {
    // First, fetch any new messages from relays
    await this.fetchStoredMessages();

    // Then return all messages from local database
    const messages = [];
    for await (const [key, value] of this.db.iterator()) {
      if (key.startsWith('inbox:')) {
        messages.push({ id: key.slice(6), ...value });
      }
    }
    return messages.sort((a, b) => b.timestamp - a.timestamp);
  }

  async getMessage(messageId) {
    try {
      return await this.db.get(`inbox:${messageId}`);
    } catch {
      return null;
    }
  }

  async markAsRead(messageId) {
    const msg = await this.getMessage(messageId);
    if (msg) {
      msg.read = true;
      await this.db.put(`inbox:${messageId}`, msg);
    }
  }

  async deleteMessage(messageId) {
    await this.db.del(`inbox:${messageId}`);
  }

  onMessage(id, handler) {
    this.messageHandlers.set(id, handler);
    return () => this.messageHandlers.delete(id);
  }

  getPeerCount() {
    return this.node?.getConnections().length || 0;
  }

  getInfo() {
    return {
      peerId: this.node?.peerId.toString(),
      address: this.identity.address,
      peers: this.getPeerCount(),
      addresses: this.node?.getMultiaddrs().map(a => a.toString()) || []
    };
  }
}
