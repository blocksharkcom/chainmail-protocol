import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { sha256 } from '@noble/hashes/sha256';
import { Level } from 'level';
import { randomBytes } from 'crypto';

const DEFAULT_REPLICATION_FACTOR = 3;
const MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface StorageProofData {
  nodeId: string;
  messageHash: string;
  timestamp: number;
  signature: string;
}

export interface MessageRecordData {
  id: string;
  recipient: string;
  data: string;
  timestamp: number;
  expires: number;
  storageProofs: StorageProofData[];
  replicationCount: number;
}

export interface StorageStats {
  messageCount: number;
  totalSizeBytes: number;
  uniqueRecipients: number;
  avgMessagesPerRecipient: number;
}

export class StorageProof {
  nodeId: string;
  messageHash: string;
  timestamp: number;
  signature: string;

  constructor(nodeId: string, messageHash: string, timestamp: number, signature: string) {
    this.nodeId = nodeId;
    this.messageHash = messageHash;
    this.timestamp = timestamp;
    this.signature = signature;
  }

  static async create(
    nodeId: string,
    messageData: Uint8Array,
    signFn: (data: Uint8Array) => Promise<Uint8Array>,
  ): Promise<StorageProof> {
    const messageHash = Buffer.from(sha256(messageData)).toString('hex');
    const timestamp = Date.now();
    const proofData = `${nodeId}:${messageHash}:${timestamp}`;
    const signature = await signFn(new TextEncoder().encode(proofData));

    return new StorageProof(nodeId, messageHash, timestamp, Buffer.from(signature).toString('hex'));
  }

  async verify(
    messageData: Uint8Array,
    verifyFn: (data: Uint8Array, sig: Uint8Array) => Promise<boolean>,
  ): Promise<boolean> {
    const expectedHash = Buffer.from(sha256(messageData)).toString('hex');
    if (this.messageHash !== expectedHash) {
      return false;
    }

    const proofData = `${this.nodeId}:${this.messageHash}:${this.timestamp}`;
    return verifyFn(new TextEncoder().encode(proofData), Buffer.from(this.signature, 'hex'));
  }

  toJSON(): StorageProofData {
    return {
      nodeId: this.nodeId,
      messageHash: this.messageHash,
      timestamp: this.timestamp,
      signature: this.signature,
    };
  }

  static fromJSON(json: StorageProofData): StorageProof {
    return new StorageProof(json.nodeId, json.messageHash, json.timestamp, json.signature);
  }
}

export class MessageRecord {
  id: string;
  recipient: string;
  data: string;
  timestamp: number;
  expires: number;
  storageProofs: StorageProof[];
  replicationCount: number;

  constructor(options: Partial<MessageRecordData> & { recipient: string; data: string }) {
    this.id = options.id || randomBytes(16).toString('hex');
    this.recipient = options.recipient;
    this.data = options.data;
    this.timestamp = options.timestamp || Date.now();
    this.expires = options.expires || Date.now() + MESSAGE_TTL_MS;
    this.storageProofs = (options.storageProofs || []).map((p) =>
      p instanceof StorageProof ? p : StorageProof.fromJSON(p),
    );
    this.replicationCount = options.replicationCount || 0;
  }

  isExpired(): boolean {
    return Date.now() > this.expires;
  }

  addProof(proof: StorageProof): void {
    this.storageProofs.push(proof);
    this.replicationCount = this.storageProofs.length;
  }

  toJSON(): MessageRecordData {
    return {
      id: this.id,
      recipient: this.recipient,
      data: this.data,
      timestamp: this.timestamp,
      expires: this.expires,
      storageProofs: this.storageProofs.map((p) => p.toJSON()),
      replicationCount: this.replicationCount,
    };
  }

  static fromJSON(json: MessageRecordData): MessageRecord {
    return new MessageRecord({
      ...json,
      storageProofs: (json.storageProofs || []).map((p) => StorageProof.fromJSON(p)),
    });
  }
}

@Injectable()
export class DHTStorageService implements OnModuleDestroy {
  private db: Level<string, MessageRecordData> | null = null;
  private dbPath: string | null = null;
  private replicationFactor = DEFAULT_REPLICATION_FACTOR;
  private nodeId: string | null = null;
  private signFn: ((data: Uint8Array) => Promise<Uint8Array>) | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  /**
   * Initialize the storage service
   */
  async init(options: {
    dbPath: string;
    nodeId?: string;
    signFn?: (data: Uint8Array) => Promise<Uint8Array>;
    replicationFactor?: number;
  }): Promise<void> {
    this.dbPath = options.dbPath;
    this.nodeId = options.nodeId || null;
    this.signFn = options.signFn || null;
    this.replicationFactor = options.replicationFactor || DEFAULT_REPLICATION_FACTOR;

    this.db = new Level(this.dbPath, { valueEncoding: 'json' });

    await this.cleanupExpired();
    this.cleanupInterval = setInterval(() => this.cleanupExpired(), 3600000);
  }

  /**
   * Close the storage service
   */
  async close(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }

  /**
   * Generate a DHT key for a recipient address
   */
  addressToKey(address: string): Uint8Array {
    const data = new TextEncoder().encode(`dmail:inbox:${address}`);
    return sha256(data);
  }

  /**
   * Generate a unique message key
   */
  messageKey(recipient: string, messageId: string): string {
    return `${recipient}:${messageId}`;
  }

  /**
   * Store a message for a recipient
   */
  async store(recipient: string, data: string): Promise<MessageRecord> {
    if (!this.db) {
      throw new Error('Storage not initialized');
    }

    const record = new MessageRecord({
      recipient,
      data,
      timestamp: Date.now(),
    });

    if (this.nodeId && this.signFn) {
      const proof = await StorageProof.create(
        this.nodeId,
        Buffer.from(data, 'base64'),
        this.signFn,
      );
      record.addProof(proof);
    }

    const key = this.messageKey(recipient, record.id);
    await this.db.put(key, record.toJSON());

    return record;
  }

  /**
   * Store a message record (used for replication)
   */
  async storeRecord(record: MessageRecord): Promise<void> {
    if (!this.db) {
      throw new Error('Storage not initialized');
    }

    if (this.nodeId && this.signFn) {
      const proof = await StorageProof.create(
        this.nodeId,
        Buffer.from(record.data, 'base64'),
        this.signFn,
      );
      record.addProof(proof);
    }

    const key = this.messageKey(record.recipient, record.id);
    await this.db.put(key, record.toJSON());
  }

  /**
   * Get all messages for a recipient
   */
  async getMessages(recipient: string): Promise<MessageRecord[]> {
    if (!this.db) {
      throw new Error('Storage not initialized');
    }

    const messages: MessageRecord[] = [];
    const prefix = `${recipient}:`;

    for await (const [key, value] of this.db.iterator()) {
      if ((key as string).startsWith(prefix)) {
        const record = MessageRecord.fromJSON(value as MessageRecordData);
        if (!record.isExpired()) {
          messages.push(record);
        }
      }
    }

    return messages.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Get a specific message
   */
  async getMessage(recipient: string, messageId: string): Promise<MessageRecord | null> {
    if (!this.db) {
      throw new Error('Storage not initialized');
    }

    const key = this.messageKey(recipient, messageId);
    try {
      const data = await this.db.get(key);
      const record = MessageRecord.fromJSON(data as MessageRecordData);
      return record.isExpired() ? null : record;
    } catch {
      return null;
    }
  }

  /**
   * Delete a message
   */
  async deleteMessage(recipient: string, messageId: string): Promise<void> {
    if (!this.db) return;

    const key = this.messageKey(recipient, messageId);
    try {
      await this.db.del(key);
    } catch {
      // May already be deleted
    }
  }

  /**
   * Delete multiple messages
   */
  async deleteMessages(recipient: string, messageIds: string[]): Promise<void> {
    for (const id of messageIds) {
      await this.deleteMessage(recipient, id);
    }
  }

  /**
   * Mark a message as read for a specific user
   */
  async markAsRead(userAddress: string, messageId: string): Promise<void> {
    if (!this.db) {
      throw new Error('Storage not initialized');
    }

    const key = `read:${userAddress}:${messageId}`;
    await this.db.put(key, { read: true, timestamp: Date.now() } as any);
  }

  /**
   * Check if a message is read for a specific user
   */
  async isRead(userAddress: string, messageId: string): Promise<boolean> {
    if (!this.db) {
      return false;
    }

    const key = `read:${userAddress}:${messageId}`;
    try {
      await this.db.get(key);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get all read message IDs for a user
   */
  async getReadMessageIds(userAddress: string): Promise<Set<string>> {
    if (!this.db) {
      return new Set();
    }

    const readIds = new Set<string>();
    const prefix = `read:${userAddress}:`;

    for await (const [key] of this.db.iterator()) {
      if ((key as string).startsWith(prefix)) {
        const messageId = (key as string).slice(prefix.length);
        readIds.add(messageId);
      }
    }

    return readIds;
  }

  /**
   * Get storage statistics
   */
  async getStats(): Promise<StorageStats> {
    if (!this.db) {
      throw new Error('Storage not initialized');
    }

    let messageCount = 0;
    let totalSize = 0;
    const recipientCounts = new Map<string, number>();

    for await (const [key, value] of this.db.iterator()) {
      messageCount++;
      totalSize += JSON.stringify(value).length;

      const recipient = (key as string).split(':')[0];
      recipientCounts.set(recipient, (recipientCounts.get(recipient) || 0) + 1);
    }

    return {
      messageCount,
      totalSizeBytes: totalSize,
      uniqueRecipients: recipientCounts.size,
      avgMessagesPerRecipient: messageCount / (recipientCounts.size || 1),
    };
  }

  /**
   * Clean up expired messages
   */
  async cleanupExpired(): Promise<number> {
    if (!this.db) return 0;

    const toDelete: string[] = [];

    for await (const [key, value] of this.db.iterator()) {
      const record = MessageRecord.fromJSON(value as MessageRecordData);
      if (record.isExpired()) {
        toDelete.push(key as string);
      }
    }

    for (const key of toDelete) {
      await this.db.del(key);
    }

    return toDelete.length;
  }

  /**
   * Verify storage proofs for a message
   */
  async verifyProofs(record: MessageRecord): Promise<{ valid: number; invalid: number }> {
    let valid = 0;
    let invalid = 0;

    for (const proof of record.storageProofs) {
      try {
        const messageData = Buffer.from(record.data, 'base64');
        const expectedHash = Buffer.from(sha256(messageData)).toString('hex');

        if (proof.messageHash === expectedHash) {
          valid++;
        } else {
          invalid++;
        }
      } catch {
        invalid++;
      }
    }

    return { valid, invalid };
  }

  /**
   * Get replication factor
   */
  getReplicationFactor(): number {
    return this.replicationFactor;
  }
}
