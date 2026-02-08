/**
 * dMail Relay Node
 *
 * A relay node that helps deliver messages across the network.
 * Relay nodes:
 * - Store messages for offline recipients using DHT
 * - Help with NAT traversal
 * - Earn DMAIL tokens for their service
 * - Replicate messages across multiple nodes for redundancy
 *
 * Anyone can run a relay node to help the network and earn rewards.
 */

import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { kadDHT } from '@libp2p/kad-dht';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { pipe } from 'it-pipe';
import * as lp from 'it-length-prefixed';
import {
  DHTMessageStorage,
  DHTCoordinator,
  MessageRecord,
  STORE_PROTOCOL,
  FETCH_PROTOCOL as DHT_FETCH_PROTOCOL,
  PROOF_PROTOCOL
} from '../storage/dht-storage.js';
import { DMailTokenClient } from '../blockchain/token.js';
import { ReputationRateLimiter } from './rate-limiter.js';

// Legacy protocol for backward compatibility
const FETCH_PROTOCOL = '/dmail/fetch/1.0.0';

// Single global topic for all messages (matches client node)
const GLOBAL_MAIL_TOPIC = '/dmail/1.0.0/mail';

const RELAY_DIR = join(homedir(), '.dmail-relay');

// Ensure relay directory exists
if (!existsSync(RELAY_DIR)) {
  mkdirSync(RELAY_DIR, { recursive: true });
}

/**
 * Relay Node Statistics
 */
class RelayStats {
  constructor(db) {
    this.db = db;
    this.messagesRelayed = 0;
    this.bytesRelayed = 0;
    this.peersServed = new Set();
    this.startTime = Date.now();
  }

  async load() {
    try {
      const stats = await this.db.get('stats');
      this.messagesRelayed = stats.messagesRelayed || 0;
      this.bytesRelayed = stats.bytesRelayed || 0;
    } catch (e) {
      // No existing stats
    }
  }

  async save() {
    await this.db.put('stats', {
      messagesRelayed: this.messagesRelayed,
      bytesRelayed: this.bytesRelayed,
      lastUpdated: Date.now()
    });
  }

  recordMessage(size) {
    this.messagesRelayed++;
    this.bytesRelayed += size;
  }

  recordPeer(peerId) {
    this.peersServed.add(peerId);
  }

  getStats() {
    const uptime = Date.now() - this.startTime;
    return {
      messagesRelayed: this.messagesRelayed,
      bytesRelayed: this.bytesRelayed,
      peersServed: this.peersServed.size,
      uptimeMs: uptime,
      uptimeHours: (uptime / 3600000).toFixed(2)
    };
  }
}

/**
 * Reward Calculator
 * Calculates DMAIL token rewards based on relay activity
 */
class RewardCalculator {
  constructor() {
    // Reward rates (in DMAIL tokens)
    this.RATE_PER_MESSAGE = 0.001;      // 0.001 DMAIL per message relayed
    this.RATE_PER_MB = 0.01;            // 0.01 DMAIL per MB relayed
    this.RATE_PER_HOUR_UPTIME = 0.1;    // 0.1 DMAIL per hour of uptime
    this.RATE_PER_UNIQUE_PEER = 0.005;  // 0.005 DMAIL per unique peer served
  }

  calculate(stats) {
    const messageReward = stats.messagesRelayed * this.RATE_PER_MESSAGE;
    const bandwidthReward = (stats.bytesRelayed / 1048576) * this.RATE_PER_MB;
    const uptimeReward = (stats.uptimeMs / 3600000) * this.RATE_PER_HOUR_UPTIME;
    const peerReward = stats.peersServed * this.RATE_PER_UNIQUE_PEER;

    return {
      messageReward,
      bandwidthReward,
      uptimeReward,
      peerReward,
      totalReward: messageReward + bandwidthReward + uptimeReward + peerReward
    };
  }
}

/**
 * dMail Relay Node
 */
export class RelayNode {
  constructor(options = {}) {
    this.port = options.port || 4001;
    this.wsPort = options.wsPort || 4002;
    this.walletAddress = options.walletAddress || null;
    this.walletPrivateKey = options.walletPrivateKey || null;
    this.replicationFactor = options.replicationFactor || 3;
    this.network = options.network || 'localhost';
    this.node = null;

    // DHT-based storage
    this.dhtStorage = new DHTMessageStorage({
      dbPath: join(RELAY_DIR, 'dht-messages'),
      replicationFactor: this.replicationFactor
    });

    // Token client for on-chain registration and rewards
    this.tokenClient = null;
    this.isRegisteredOnChain = false;

    // Rate limiter for spam protection
    this.rateLimiter = new ReputationRateLimiter({
      maxRequests: options.maxMessagesPerMinute || 30,
      windowMs: 60000,
      globalMaxRequests: options.globalMaxMessages || 5000,
      maxMessageSize: options.maxMessageSize || 1024 * 1024, // 1MB
      maxDailyStorage: options.maxDailyStorage || 50 * 1024 * 1024 // 50MB
    });

    // Stats database
    this.statsDb = null;
    this.stats = null;
    this.rewardCalculator = new RewardCalculator();
    this.dhtCoordinator = null;
  }

  async start() {
    // Initialize stats database
    const { Level } = await import('level');
    this.statsDb = new Level(join(RELAY_DIR, 'stats'), { valueEncoding: 'json' });
    this.stats = new RelayStats(this.statsDb);
    await this.stats.load();

    // Initialize DHT storage
    await this.dhtStorage.init();

    // Generate or load node identity
    let privateKey = await this.loadOrGenerateKey();

    this.node = await createLibp2p({
      addresses: {
        listen: [
          `/ip4/0.0.0.0/tcp/${this.port}`,
          `/ip4/0.0.0.0/tcp/${this.wsPort}/ws`
        ],
        announce: [
          // Add your public IP here for production
          // `/ip4/YOUR_PUBLIC_IP/tcp/${this.port}`,
          // `/ip4/YOUR_PUBLIC_IP/tcp/${this.wsPort}/ws`
        ]
      },
      transports: [
        tcp(),
        webSockets()
      ],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: {
        identify: identify(),
        ping: ping(),
        dht: kadDHT({
          clientMode: false, // Full DHT node
          validators: {
            dmail: async (key, value) => true
          },
          selectors: {
            dmail: (key, records) => 0
          }
        }),
        pubsub: gossipsub({
          emitSelf: false,
          gossipIncoming: true,
          fallbackToFloodsub: true,
          floodPublish: true,
          doPX: true,
          allowPublishToZeroPeers: true
        })
      }
    });

    // Track peer connections
    this.node.addEventListener('peer:connect', (evt) => {
      const peerId = evt.detail.toString();
      this.stats.recordPeer(peerId);
      console.log(`Peer connected: ${peerId.slice(0, 16)}...`);
    });

    await this.node.start();

    // Subscribe to pubsub AFTER node is started
    this.node.services.pubsub.addEventListener('message', (evt) => {
      this.handleMessage(evt.detail);
    });

    // Subscribe to the global dmail topic (must match client node topic)
    this.node.services.pubsub.subscribe(GLOBAL_MAIL_TOPIC);
    console.log(`Subscribed to topic: ${GLOBAL_MAIL_TOPIC}`);

    // Register the legacy fetch protocol handler (backward compatibility)
    await this.node.handle(FETCH_PROTOCOL, this.handleFetchRequest.bind(this));

    // Register DHT storage protocol handlers
    await this.node.handle(STORE_PROTOCOL, this.handleStoreRequest.bind(this));
    await this.node.handle(DHT_FETCH_PROTOCOL, this.handleDHTFetchRequest.bind(this));
    await this.node.handle(PROOF_PROTOCOL, this.handleProofRequest.bind(this));

    // Initialize DHT coordinator for replication
    this.dhtStorage.nodeId = this.node.peerId.toString();
    this.dhtCoordinator = new DHTCoordinator(this.node, this.dhtStorage, {
      replicationFactor: this.replicationFactor
    });

    // Save peer ID for consistent identity
    await this.savePeerId();

    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                   dMail Relay Node Started                    ║
╠═══════════════════════════════════════════════════════════════╣
║  Peer ID: ${this.node.peerId.toString().slice(0, 48)}...
║  TCP:     /ip4/0.0.0.0/tcp/${this.port}
║  WS:      /ip4/0.0.0.0/tcp/${this.wsPort}/ws
║  Wallet:  ${this.walletAddress || 'Not configured (rewards disabled)'}
╚═══════════════════════════════════════════════════════════════╝

Listening addresses:
${this.node.getMultiaddrs().map(a => '  ' + a.toString()).join('\n')}

Run this node 24/7 to earn DMAIL token rewards!
    `);

    // Start stats reporting
    this.startStatsReporting();

    // Initialize token client and register on-chain if configured
    await this.initializeTokenClient();

    return this;
  }

  /**
   * Initialize token client and register on-chain
   */
  async initializeTokenClient() {
    if (!this.walletPrivateKey) {
      console.log('No wallet private key configured - on-chain rewards disabled');
      console.log('To enable rewards, set WALLET_PRIVATE_KEY environment variable');
      return;
    }

    try {
      this.tokenClient = new DMailTokenClient({ network: this.network });
      await this.tokenClient.connect(this.walletPrivateKey);

      if (!this.tokenClient.isAvailable()) {
        console.log('Token contract not available on this network');
        return;
      }

      // Check if already registered
      const peerId = this.node.peerId.toString();
      const nodeInfo = await this.tokenClient.getNodeInfo();

      if (nodeInfo.isActive) {
        this.isRegisteredOnChain = true;
        console.log(`
┌─────────────────────────────────────────┐
│     On-Chain Registration: ACTIVE       │
├─────────────────────────────────────────┤
│ Staked: ${nodeInfo.stakedAmount.padStart(28)} DMAIL │
│ Pending Rewards: ${nodeInfo.pendingRewards.padStart(18)} DMAIL │
│ Total Claimed: ${nodeInfo.totalClaimed.padStart(20)} DMAIL │
└─────────────────────────────────────────┘
        `);
      } else {
        // Try to register
        console.log('Attempting on-chain registration...');
        try {
          const result = await this.tokenClient.registerRelayNode(peerId);
          this.isRegisteredOnChain = true;
          console.log(`
┌─────────────────────────────────────────┐
│   On-Chain Registration: SUCCESS        │
├─────────────────────────────────────────┤
│ TX: ${result.transactionHash.slice(0, 32)}...
│ Staked: ${result.stakedAmount} DMAIL
└─────────────────────────────────────────┘
          `);
        } catch (e) {
          console.log(`On-chain registration failed: ${e.message}`);
          console.log('Relay will operate without on-chain rewards');
        }
      }

      // Start auto-claim interval (every 24 hours)
      this.startAutoClaimRewards();

    } catch (e) {
      console.log(`Token client initialization failed: ${e.message}`);
    }
  }

  /**
   * Start automatic reward claiming
   */
  startAutoClaimRewards() {
    if (!this.tokenClient || !this.isRegisteredOnChain) return;

    // Claim rewards every 24 hours
    setInterval(async () => {
      try {
        const pending = await this.tokenClient.getPendingRewards();
        if (parseFloat(pending.formatted) > 0.1) { // Only claim if > 0.1 DMAIL
          console.log(`Auto-claiming ${pending.formatted} DMAIL rewards...`);
          const result = await this.tokenClient.claimRewards();
          console.log(`Rewards claimed! TX: ${result.transactionHash.slice(0, 16)}...`);
        }
      } catch (e) {
        console.log(`Auto-claim failed: ${e.message}`);
      }
    }, 24 * 60 * 60 * 1000); // 24 hours
  }

  /**
   * Manually claim rewards
   */
  async claimRewards() {
    if (!this.tokenClient || !this.isRegisteredOnChain) {
      throw new Error('Not registered on-chain');
    }

    return await this.tokenClient.claimRewards();
  }

  /**
   * Get on-chain node info
   */
  async getOnChainInfo() {
    if (!this.tokenClient) {
      return { registered: false };
    }

    try {
      const nodeInfo = await this.tokenClient.getNodeInfo();
      const pending = await this.tokenClient.getPendingRewards();
      return {
        registered: this.isRegisteredOnChain,
        ...nodeInfo,
        pendingRewards: pending.formatted
      };
    } catch (e) {
      return { registered: false, error: e.message };
    }
  }

  async loadOrGenerateKey() {
    const keyPath = join(RELAY_DIR, 'node-key.json');
    if (existsSync(keyPath)) {
      return JSON.parse(readFileSync(keyPath, 'utf8'));
    }
    const key = randomBytes(32).toString('hex');
    writeFileSync(keyPath, JSON.stringify(key));
    return key;
  }

  async savePeerId() {
    const peerIdPath = join(RELAY_DIR, 'peer-id.txt');
    writeFileSync(peerIdPath, this.node.peerId.toString());
  }

  async handleMessage(message) {
    const topic = message.topic;
    const data = message.data;
    const size = data.length;

    // Parse the envelope to extract sender for rate limiting
    let envelope;
    try {
      envelope = JSON.parse(new TextDecoder().decode(data));
    } catch (e) {
      console.error('Failed to parse message envelope:', e.message);
      return;
    }

    // Get sender identifier for rate limiting
    const senderId = envelope.from || message.from?.toString() || 'unknown';

    // Check rate limits
    const rateCheck = this.rateLimiter.checkAndRecord(senderId, size);
    if (!rateCheck.allowed) {
      console.log(`Rate limited: ${senderId.slice(0, 16)}... - ${rateCheck.reason}`);
      return;
    }

    // Record stats
    this.stats.recordMessage(size);

    try {

      // Store message for offline delivery using DHT
      // For sealed envelopes, use routingToken as the storage key
      // For plain envelopes, use the 'to' field
      let storageKey = null;

      if (envelope.type === 'sealed' && envelope.routingToken) {
        // Sealed envelope - store by routing token (privacy-preserving)
        storageKey = envelope.routingToken;
        console.log(`Sealed envelope received, storing by routing token: ${storageKey.slice(0, 16)}...`);
      } else if (envelope.to) {
        // Plain envelope - store by recipient address
        storageKey = envelope.to;
        console.log(`Plain envelope received for ${envelope.to.slice(0, 16)}...`);
      }

      if (storageKey) {
        await this.storeWithReplication(storageKey, data);
        console.log(`Stored message (${size} bytes)`);
      } else {
        console.log(`Relayed message on ${topic} (${size} bytes) - no recipient/routing token found`);
      }
    } catch (e) {
      console.error('Message handling error:', e.message);
    }
  }

  /**
   * Store message with DHT replication
   */
  async storeWithReplication(recipient, data) {
    const base64Data = Buffer.from(data).toString('base64');

    // Store locally in DHT storage
    const record = await this.dhtStorage.store(recipient, base64Data);

    // Replicate to other nodes using DHT coordinator
    if (this.dhtCoordinator) {
      try {
        await this.dhtCoordinator.storeWithReplication(recipient, base64Data);
        console.log(`Message replicated to ${this.replicationFactor} nodes`);
      } catch (e) {
        console.log(`Replication partially failed: ${e.message}`);
      }
    }

    return record;
  }

  /**
   * Get stored messages from DHT storage
   */
  async getStoredMessages(recipient) {
    const records = await this.dhtStorage.getMessages(recipient);
    return records.map(r => ({
      key: `${r.recipient}:${r.id}`,
      recipient: r.recipient,
      data: r.data,
      timestamp: r.timestamp,
      expires: r.expires,
      replicationCount: r.replicationCount
    }));
  }

  /**
   * Delete a stored message
   */
  async deleteStoredMessage(key) {
    const [recipient, messageId] = key.split(':');
    await this.dhtStorage.deleteMessage(recipient, messageId);
  }

  /**
   * Handle DHT store requests from other nodes
   */
  async handleStoreRequest({ stream }) {
    try {
      let requestData = '';
      for await (const msg of lp.decode(stream.source)) {
        requestData = new TextDecoder().decode(msg.subarray());
        break;
      }

      const request = JSON.parse(requestData);

      if (request.action === 'store' && request.record) {
        // Store the replicated record
        const record = MessageRecord.fromJSON(request.record);
        await this.dhtStorage.storeRecord(record);

        this.stats.recordMessage(record.data.length);

        await pipe(
          [new TextEncoder().encode(JSON.stringify({ success: true, id: record.id }))],
          (source) => lp.encode(source),
          stream.sink
        );
      } else {
        await pipe(
          [new TextEncoder().encode(JSON.stringify({ error: 'Invalid request' }))],
          (source) => lp.encode(source),
          stream.sink
        );
      }
    } catch (error) {
      console.error('Store request error:', error.message);
      try {
        await pipe(
          [new TextEncoder().encode(JSON.stringify({ error: 'Store failed' }))],
          (source) => lp.encode(source),
          stream.sink
        );
      } catch (e) {
        // Stream closed
      }
    }
  }

  /**
   * Handle DHT fetch requests from other nodes
   */
  async handleDHTFetchRequest({ stream }) {
    try {
      let requestData = '';
      for await (const msg of lp.decode(stream.source)) {
        requestData = new TextDecoder().decode(msg.subarray());
        break;
      }

      const request = JSON.parse(requestData);

      if (request.action === 'fetch' && (request.recipient || request.routingToken)) {
        // Fetch messages stored by both address (plain envelope) and routing token (sealed envelope)
        const allRecords = [];
        const seenIds = new Set();

        // Fetch by recipient address (for plain envelopes)
        if (request.recipient) {
          const byAddress = await this.dhtStorage.getMessages(request.recipient);
          for (const r of byAddress) {
            if (!seenIds.has(r.id)) {
              seenIds.add(r.id);
              allRecords.push(r);
            }
          }
        }

        // Fetch by routing token (for sealed envelopes)
        if (request.routingToken) {
          const byToken = await this.dhtStorage.getMessages(request.routingToken);
          for (const r of byToken) {
            if (!seenIds.has(r.id)) {
              seenIds.add(r.id);
              allRecords.push(r);
            }
          }
        }

        console.log(`DHT fetch: found ${allRecords.length} messages for recipient`);

        await pipe(
          [new TextEncoder().encode(JSON.stringify({
            messages: allRecords.map(r => r.toJSON())
          }))],
          (source) => lp.encode(source),
          stream.sink
        );
      } else {
        await pipe(
          [new TextEncoder().encode(JSON.stringify({ error: 'Invalid request' }))],
          (source) => lp.encode(source),
          stream.sink
        );
      }
    } catch (error) {
      console.error('DHT fetch error:', error.message);
      try {
        await pipe(
          [new TextEncoder().encode(JSON.stringify({ error: 'Fetch failed' }))],
          (source) => lp.encode(source),
          stream.sink
        );
      } catch (e) {
        // Stream closed
      }
    }
  }

  /**
   * Handle storage proof requests
   */
  async handleProofRequest({ stream }) {
    try {
      let requestData = '';
      for await (const msg of lp.decode(stream.source)) {
        requestData = new TextDecoder().decode(msg.subarray());
        break;
      }

      const request = JSON.parse(requestData);

      if (request.action === 'verify' && request.recipient && request.messageId) {
        const record = await this.dhtStorage.getMessage(request.recipient, request.messageId);

        if (record) {
          const proofResult = await this.dhtStorage.verifyProofs(record);
          await pipe(
            [new TextEncoder().encode(JSON.stringify({
              exists: true,
              replicationCount: record.replicationCount,
              proofs: proofResult
            }))],
            (source) => lp.encode(source),
            stream.sink
          );
        } else {
          await pipe(
            [new TextEncoder().encode(JSON.stringify({ exists: false }))],
            (source) => lp.encode(source),
            stream.sink
          );
        }
      } else {
        await pipe(
          [new TextEncoder().encode(JSON.stringify({ error: 'Invalid request' }))],
          (source) => lp.encode(source),
          stream.sink
        );
      }
    } catch (error) {
      console.error('Proof request error:', error.message);
      try {
        await pipe(
          [new TextEncoder().encode(JSON.stringify({ error: 'Proof failed' }))],
          (source) => lp.encode(source),
          stream.sink
        );
      } catch (e) {
        // Stream closed
      }
    }
  }

  /**
   * Handle incoming fetch requests from clients
   * Protocol: client sends their dMail address, relay responds with stored messages
   */
  async handleFetchRequest({ stream }) {
    try {
      // Read the request (recipient address)
      let requestData = '';
      for await (const msg of lp.decode(stream.source)) {
        requestData = new TextDecoder().decode(msg.subarray());
        break; // Only need first message
      }

      const request = JSON.parse(requestData);
      const { address } = request;

      if (!address) {
        await pipe(
          [new TextEncoder().encode(JSON.stringify({ error: 'No address provided' }))],
          (source) => lp.encode(source),
          stream.sink
        );
        return;
      }

      // Get stored messages for this address
      const messages = await this.getStoredMessages(address);
      console.log(`Fetch request for ${address.slice(0, 16)}...: ${messages.length} messages`);

      // Send response with messages
      const response = JSON.stringify({
        messages: messages.map(m => ({
          data: m.data,
          timestamp: m.timestamp
        }))
      });

      await pipe(
        [new TextEncoder().encode(response)],
        (source) => lp.encode(source),
        stream.sink
      );

      // Delete delivered messages
      for (const msg of messages) {
        await this.deleteStoredMessage(msg.key);
      }

      this.stats.recordMessage(messages.length);
    } catch (error) {
      console.error('Fetch request error:', error.message);
      try {
        await pipe(
          [new TextEncoder().encode(JSON.stringify({ error: 'Fetch failed' }))],
          (source) => lp.encode(source),
          stream.sink
        );
      } catch (e) {
        // Stream may be closed
      }
    }
  }

  startStatsReporting() {
    // Report stats every 5 minutes
    setInterval(async () => {
      await this.stats.save();
      const stats = this.stats.getStats();
      const rewards = this.rewardCalculator.calculate(stats);

      console.log(`
┌─────────────────────────────────────────┐
│           Relay Node Stats              │
├─────────────────────────────────────────┤
│ Messages Relayed: ${stats.messagesRelayed.toString().padStart(18)} │
│ Data Relayed:     ${(stats.bytesRelayed / 1024).toFixed(2).padStart(15)} KB │
│ Peers Served:     ${stats.peersServed.toString().padStart(18)} │
│ Uptime:           ${stats.uptimeHours.padStart(15)} hrs │
├─────────────────────────────────────────┤
│ Estimated Rewards: ${rewards.totalReward.toFixed(4).padStart(14)} DMAIL │
└─────────────────────────────────────────┘
      `);
    }, 300000); // 5 minutes
  }

  async stop() {
    await this.stats.save();
    if (this.rateLimiter) {
      this.rateLimiter.stop();
    }
    if (this.node) {
      await this.node.stop();
    }
    if (this.statsDb) {
      await this.statsDb.close();
    }
    await this.dhtStorage.close();
  }

  async getInfo() {
    const storageStats = await this.dhtStorage.getStats();
    const onChainInfo = await this.getOnChainInfo();

    return {
      peerId: this.node?.peerId.toString(),
      multiaddrs: this.node?.getMultiaddrs().map(a => a.toString()) || [],
      stats: this.stats.getStats(),
      rewards: this.rewardCalculator.calculate(this.stats.getStats()),
      storage: {
        ...storageStats,
        replicationFactor: this.replicationFactor
      },
      onChain: onChainInfo
    };
  }
}

// CLI entry point
if (process.argv[1].endsWith('relay-node.js')) {
  const port = parseInt(process.env.PORT || '4001');
  const wsPort = parseInt(process.env.WS_PORT || '4002');
  const wallet = process.env.WALLET_ADDRESS;
  const walletPrivateKey = process.env.WALLET_PRIVATE_KEY;
  const network = process.env.NETWORK || 'localhost';

  const relay = new RelayNode({
    port,
    wsPort,
    walletAddress: wallet,
    walletPrivateKey,
    network
  });

  relay.start().catch(console.error);

  process.on('SIGINT', async () => {
    console.log('\nShutting down relay node...');
    await relay.stop();
    process.exit(0);
  });
}

export { RelayStats, RewardCalculator };
