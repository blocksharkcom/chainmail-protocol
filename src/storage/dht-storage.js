/**
 * DHT-Based Message Storage for dMail
 *
 * Stores messages across the network using a distributed hash table.
 * Messages are stored by recipient address hash and replicated across K nodes.
 *
 * Key features:
 * - Messages stored by recipient address hash
 * - Replication factor K (default 3) for redundancy
 * - Storage proofs for verification
 * - Automatic expiration and cleanup
 */

import { sha256 } from '@noble/hashes/sha256';
import { Level } from 'level';
import { randomBytes } from 'crypto';

// Storage configuration
const DEFAULT_REPLICATION_FACTOR = 3;
const MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const STORAGE_PREFIX = '/dmail/storage/1.0.0';

/**
 * Generate a DHT key for a recipient address
 * @param {string} address - The dMail address
 * @returns {Uint8Array} - The DHT key
 */
export function addressToKey(address) {
  const data = new TextEncoder().encode(`dmail:inbox:${address}`);
  return sha256(data);
}

/**
 * Generate a unique message key
 * @param {string} recipient - Recipient address
 * @param {string} messageId - Message ID
 * @returns {string} - Unique storage key
 */
export function messageKey(recipient, messageId) {
  return `${recipient}:${messageId}`;
}

/**
 * Storage Proof - proves a node is storing a message
 */
export class StorageProof {
  constructor(nodeId, messageHash, timestamp, signature) {
    this.nodeId = nodeId;
    this.messageHash = messageHash;
    this.timestamp = timestamp;
    this.signature = signature;
  }

  /**
   * Create a storage proof for a message
   * @param {string} nodeId - The storing node's ID
   * @param {Uint8Array} messageData - The message data
   * @param {Function} signFn - Signing function
   * @returns {StorageProof}
   */
  static async create(nodeId, messageData, signFn) {
    const messageHash = Buffer.from(sha256(messageData)).toString('hex');
    const timestamp = Date.now();
    const proofData = `${nodeId}:${messageHash}:${timestamp}`;
    const signature = await signFn(new TextEncoder().encode(proofData));

    return new StorageProof(nodeId, messageHash, timestamp, Buffer.from(signature).toString('hex'));
  }

  /**
   * Verify a storage proof
   * @param {Uint8Array} messageData - The message data to verify against
   * @param {Function} verifyFn - Verification function
   * @returns {boolean}
   */
  async verify(messageData, verifyFn) {
    const expectedHash = Buffer.from(sha256(messageData)).toString('hex');
    if (this.messageHash !== expectedHash) {
      return false;
    }

    const proofData = `${this.nodeId}:${this.messageHash}:${this.timestamp}`;
    return verifyFn(
      new TextEncoder().encode(proofData),
      Buffer.from(this.signature, 'hex')
    );
  }

  toJSON() {
    return {
      nodeId: this.nodeId,
      messageHash: this.messageHash,
      timestamp: this.timestamp,
      signature: this.signature
    };
  }

  static fromJSON(json) {
    return new StorageProof(json.nodeId, json.messageHash, json.timestamp, json.signature);
  }
}

/**
 * Message Record - wrapper for stored messages with metadata
 */
export class MessageRecord {
  constructor(options) {
    this.id = options.id || randomBytes(16).toString('hex');
    this.recipient = options.recipient;
    this.data = options.data; // Base64 encoded message
    this.timestamp = options.timestamp || Date.now();
    this.expires = options.expires || (Date.now() + MESSAGE_TTL_MS);
    this.storageProofs = options.storageProofs || [];
    this.replicationCount = options.replicationCount || 0;
  }

  isExpired() {
    return Date.now() > this.expires;
  }

  addProof(proof) {
    this.storageProofs.push(proof);
    this.replicationCount = this.storageProofs.length;
  }

  toJSON() {
    return {
      id: this.id,
      recipient: this.recipient,
      data: this.data,
      timestamp: this.timestamp,
      expires: this.expires,
      storageProofs: this.storageProofs.map(p => p.toJSON ? p.toJSON() : p),
      replicationCount: this.replicationCount
    };
  }

  static fromJSON(json) {
    return new MessageRecord({
      ...json,
      storageProofs: (json.storageProofs || []).map(p => StorageProof.fromJSON(p))
    });
  }
}

/**
 * DHT Storage Protocol Handler
 * Handles storage requests from other nodes
 */
export const STORE_PROTOCOL = `${STORAGE_PREFIX}/store`;
export const FETCH_PROTOCOL = `${STORAGE_PREFIX}/fetch`;
export const PROOF_PROTOCOL = `${STORAGE_PREFIX}/proof`;

/**
 * DHT Message Storage
 * Main class for distributed message storage
 */
export class DHTMessageStorage {
  constructor(options = {}) {
    this.db = options.db || null;
    this.dbPath = options.dbPath;
    this.replicationFactor = options.replicationFactor || DEFAULT_REPLICATION_FACTOR;
    this.nodeId = options.nodeId || null;
    this.signFn = options.signFn || null;
    this.verifyFn = options.verifyFn || null;
  }

  async init() {
    if (!this.db && this.dbPath) {
      this.db = new Level(this.dbPath, { valueEncoding: 'json' });
    }

    // Clean up expired messages on startup
    await this.cleanupExpired();

    // Start periodic cleanup
    this.cleanupInterval = setInterval(() => this.cleanupExpired(), 3600000); // Every hour
  }

  async close() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    if (this.db) {
      await this.db.close();
    }
  }

  /**
   * Store a message for a recipient
   * @param {string} recipient - Recipient dMail address
   * @param {string} data - Base64 encoded message data
   * @returns {MessageRecord}
   */
  async store(recipient, data) {
    const record = new MessageRecord({
      recipient,
      data,
      timestamp: Date.now()
    });

    // Create storage proof if we have signing capability
    if (this.nodeId && this.signFn) {
      const proof = await StorageProof.create(
        this.nodeId,
        Buffer.from(data, 'base64'),
        this.signFn
      );
      record.addProof(proof);
    }

    const key = messageKey(recipient, record.id);
    await this.db.put(key, record.toJSON());

    console.log(`Stored message ${record.id.slice(0, 8)}... for ${recipient.slice(0, 16)}...`);
    return record;
  }

  /**
   * Store a message record (used for replication)
   * @param {MessageRecord} record - The message record to store
   */
  async storeRecord(record) {
    // Add our own storage proof
    if (this.nodeId && this.signFn) {
      const proof = await StorageProof.create(
        this.nodeId,
        Buffer.from(record.data, 'base64'),
        this.signFn
      );
      record.addProof(proof);
    }

    const key = messageKey(record.recipient, record.id);
    await this.db.put(key, record.toJSON());

    console.log(`Replicated message ${record.id.slice(0, 8)}... (proof #${record.replicationCount})`);
  }

  /**
   * Get all messages for a recipient
   * @param {string} recipient - Recipient dMail address
   * @returns {MessageRecord[]}
   */
  async getMessages(recipient) {
    const messages = [];
    const prefix = `${recipient}:`;

    for await (const [key, value] of this.db.iterator()) {
      if (key.startsWith(prefix)) {
        const record = MessageRecord.fromJSON(value);
        if (!record.isExpired()) {
          messages.push(record);
        }
      }
    }

    return messages.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Get a specific message
   * @param {string} recipient - Recipient address
   * @param {string} messageId - Message ID
   * @returns {MessageRecord|null}
   */
  async getMessage(recipient, messageId) {
    const key = messageKey(recipient, messageId);
    try {
      const data = await this.db.get(key);
      const record = MessageRecord.fromJSON(data);
      return record.isExpired() ? null : record;
    } catch (e) {
      return null;
    }
  }

  /**
   * Delete a message (after delivery confirmation)
   * @param {string} recipient - Recipient address
   * @param {string} messageId - Message ID
   */
  async deleteMessage(recipient, messageId) {
    const key = messageKey(recipient, messageId);
    try {
      await this.db.del(key);
      console.log(`Deleted message ${messageId.slice(0, 8)}...`);
    } catch (e) {
      // May already be deleted
    }
  }

  /**
   * Delete multiple messages
   * @param {string} recipient - Recipient address
   * @param {string[]} messageIds - Message IDs to delete
   */
  async deleteMessages(recipient, messageIds) {
    for (const id of messageIds) {
      await this.deleteMessage(recipient, id);
    }
  }

  /**
   * Get storage statistics
   */
  async getStats() {
    let messageCount = 0;
    let totalSize = 0;
    const recipientCounts = new Map();

    for await (const [key, value] of this.db.iterator()) {
      messageCount++;
      totalSize += JSON.stringify(value).length;

      const recipient = key.split(':')[0];
      recipientCounts.set(recipient, (recipientCounts.get(recipient) || 0) + 1);
    }

    return {
      messageCount,
      totalSizeBytes: totalSize,
      uniqueRecipients: recipientCounts.size,
      avgMessagesPerRecipient: messageCount / (recipientCounts.size || 1)
    };
  }

  /**
   * Clean up expired messages
   */
  async cleanupExpired() {
    const toDelete = [];

    for await (const [key, value] of this.db.iterator()) {
      const record = MessageRecord.fromJSON(value);
      if (record.isExpired()) {
        toDelete.push(key);
      }
    }

    for (const key of toDelete) {
      await this.db.del(key);
    }

    if (toDelete.length > 0) {
      console.log(`Cleaned up ${toDelete.length} expired messages`);
    }

    return toDelete.length;
  }

  /**
   * Verify storage proofs for a message
   * @param {MessageRecord} record - The message record
   * @returns {{valid: number, invalid: number}}
   */
  async verifyProofs(record) {
    let valid = 0;
    let invalid = 0;

    for (const proof of record.storageProofs) {
      try {
        // Note: Full verification requires the verifier for each node
        // For now, we just check the hash matches
        const messageData = Buffer.from(record.data, 'base64');
        const expectedHash = Buffer.from(sha256(messageData)).toString('hex');

        if (proof.messageHash === expectedHash) {
          valid++;
        } else {
          invalid++;
        }
      } catch (e) {
        invalid++;
      }
    }

    return { valid, invalid };
  }
}

/**
 * DHT Coordinator
 * Coordinates storage across multiple nodes using libp2p DHT
 */
export class DHTCoordinator {
  constructor(node, storage, options = {}) {
    this.node = node; // libp2p node
    this.storage = storage;
    this.replicationFactor = options.replicationFactor || DEFAULT_REPLICATION_FACTOR;
  }

  /**
   * Find nodes responsible for storing messages for an address
   * @param {string} address - The dMail address
   * @returns {string[]} - Peer IDs of responsible nodes
   */
  async findStorageNodes(address) {
    const key = addressToKey(address);
    const nodes = [];

    try {
      // Use DHT to find K closest nodes to this key
      const dht = this.node.services.dht;
      if (dht) {
        for await (const event of dht.findPeer(key, { timeout: 10000 })) {
          if (event.name === 'PEER_RESPONSE') {
            nodes.push(event.peer.id.toString());
            if (nodes.length >= this.replicationFactor) break;
          }
        }
      }
    } catch (e) {
      // DHT query failed, return connected peers instead
      const connections = this.node.getConnections();
      for (const conn of connections.slice(0, this.replicationFactor)) {
        nodes.push(conn.remotePeer.toString());
      }
    }

    return nodes;
  }

  /**
   * Store a message with replication
   * @param {string} recipient - Recipient address
   * @param {string} data - Message data (base64)
   * @returns {MessageRecord}
   */
  async storeWithReplication(recipient, data) {
    // Store locally first
    const record = await this.storage.store(recipient, data);

    // Find nodes to replicate to
    const targetNodes = await this.findStorageNodes(recipient);
    console.log(`Replicating to ${targetNodes.length} nodes...`);

    // Replicate to other nodes
    for (const peerId of targetNodes) {
      try {
        await this.replicateTo(peerId, record);
      } catch (e) {
        console.log(`Replication to ${peerId.slice(0, 16)}... failed: ${e.message}`);
      }
    }

    return record;
  }

  /**
   * Replicate a message to a specific peer
   * @param {string} peerId - Target peer ID
   * @param {MessageRecord} record - Message record to replicate
   */
  async replicateTo(peerId, record) {
    const { pipe } = await import('it-pipe');
    const lp = await import('it-length-prefixed');

    const stream = await this.node.dialProtocol(peerId, STORE_PROTOCOL);

    const request = JSON.stringify({
      action: 'store',
      record: record.toJSON()
    });

    await pipe(
      [new TextEncoder().encode(request)],
      (source) => lp.encode(source),
      stream.sink
    );

    // Read response
    let response;
    for await (const msg of lp.decode(stream.source)) {
      response = JSON.parse(new TextDecoder().decode(msg.subarray()));
      break;
    }

    if (response?.error) {
      throw new Error(response.error);
    }

    console.log(`Replicated to ${peerId.slice(0, 16)}...`);
  }

  /**
   * Fetch messages from the network for a recipient
   * @param {string} recipient - Recipient address
   * @returns {MessageRecord[]}
   */
  async fetchFromNetwork(recipient) {
    const allMessages = new Map();

    // Get local messages first
    const localMessages = await this.storage.getMessages(recipient);
    for (const msg of localMessages) {
      allMessages.set(msg.id, msg);
    }

    // Find nodes that might have messages
    const targetNodes = await this.findStorageNodes(recipient);

    // Fetch from each node
    for (const peerId of targetNodes) {
      try {
        const messages = await this.fetchFrom(peerId, recipient);
        for (const msg of messages) {
          // Prefer records with more storage proofs
          const existing = allMessages.get(msg.id);
          if (!existing || msg.replicationCount > existing.replicationCount) {
            allMessages.set(msg.id, msg);
          }
        }
      } catch (e) {
        console.log(`Fetch from ${peerId.slice(0, 16)}... failed: ${e.message}`);
      }
    }

    return Array.from(allMessages.values());
  }

  /**
   * Fetch messages from a specific peer
   * @param {string} peerId - Target peer ID
   * @param {string} recipient - Recipient address
   * @returns {MessageRecord[]}
   */
  async fetchFrom(peerId, recipient) {
    const { pipe } = await import('it-pipe');
    const lp = await import('it-length-prefixed');

    const stream = await this.node.dialProtocol(peerId, FETCH_PROTOCOL);

    const request = JSON.stringify({
      action: 'fetch',
      recipient
    });

    await pipe(
      [new TextEncoder().encode(request)],
      (source) => lp.encode(source),
      stream.sink
    );

    // Read response
    let response;
    for await (const msg of lp.decode(stream.source)) {
      response = JSON.parse(new TextDecoder().decode(msg.subarray()));
      break;
    }

    if (response?.error) {
      throw new Error(response.error);
    }

    return (response?.messages || []).map(m => MessageRecord.fromJSON(m));
  }
}

export default DHTMessageStorage;
