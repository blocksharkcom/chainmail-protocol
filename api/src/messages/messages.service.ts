import { Injectable, OnModuleInit } from '@nestjs/common';
import { P2PNodeService, MessageEnvelope, StoredMessage } from '../network/p2p-node.service';
import { EncryptionService, SerializedEncryptedMessage } from '../crypto/encryption.service';
import { IdentityService } from '../crypto/identity.service';
import { IdentityStoreService } from '../crypto/identity-store.service';
import { Identity } from '../crypto/interfaces/identity.interface';
import { DHTStorageService, MessageRecord } from '../storage/dht-storage.service';
import { join } from 'path';
import { homedir } from 'os';
import { sha256 } from '@noble/hashes/sha256';

const DMAIL_DIR = join(homedir(), '.dmail');

export interface DecryptedMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  timestamp: number;
  receivedAt: number;
  read: boolean;
}

export interface SendResult {
  messageId: string;
  timestamp: number;
}

@Injectable()
export class MessagesService implements OnModuleInit {
  private currentIdentity: Identity | null = null;
  private localStorageInitialized = false;

  constructor(
    private readonly p2pNode: P2PNodeService,
    private readonly encryptionService: EncryptionService,
    private readonly identityService: IdentityService,
    private readonly identityStore: IdentityStoreService,
    private readonly dhtStorage: DHTStorageService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Load all identities on startup
    await this.identityStore.loadAllIdentities();
  }

  /**
   * Set the current identity for this service instance
   */
  async setIdentity(identity: Identity): Promise<void> {
    this.currentIdentity = identity;
    await this.initLocalStorage();
  }

  /**
   * Initialize local storage for when P2P is unavailable
   * Uses a shared storage path so all messages are accessible locally
   */
  private async initLocalStorage(): Promise<void> {
    if (this.localStorageInitialized) return;

    try {
      // Use a shared path for all users so messages can be delivered locally
      const dbPath = join(DMAIL_DIR, 'messages', 'shared');
      await this.dhtStorage.init({ dbPath });
      this.localStorageInitialized = true;
    } catch (err) {
      console.warn('Failed to initialize local storage:', (err as Error).message);
    }
  }

  /**
   * Check if P2P node is available
   */
  private isP2PAvailable(): boolean {
    return this.p2pNode.isNodeStarted();
  }

  /**
   * Generate a message ID from an envelope
   */
  private generateMessageId(envelope: MessageEnvelope): string {
    const data = JSON.stringify({
      from: envelope.from,
      to: envelope.to,
      encrypted: envelope.encrypted,
      timestamp: envelope.timestamp,
    });
    const hash = sha256(new TextEncoder().encode(data));
    return Buffer.from(hash).toString('hex').slice(0, 32);
  }

  /**
   * Get the current identity
   */
  getIdentity(): Identity | null {
    return this.currentIdentity;
  }

  /**
   * Send an encrypted message (legacy - uses currentIdentity)
   */
  async sendMessage(
    to: string,
    subject: string,
    body: string,
    recipientEncryptionKey: Uint8Array,
  ): Promise<SendResult> {
    if (!this.currentIdentity) {
      throw new Error('No identity set');
    }

    return this.sendMessageWithSender(
      this.currentIdentity.address,
      to,
      subject,
      body,
      recipientEncryptionKey,
    );
  }

  /**
   * Send an encrypted message with explicit sender address
   */
  async sendMessageWithSender(
    from: string,
    to: string,
    subject: string,
    body: string,
    recipientEncryptionKey: Uint8Array,
  ): Promise<SendResult> {
    const message = {
      subject,
      body,
      timestamp: Date.now(),
    };

    const encrypted = this.encryptionService.encryptJson(message, recipientEncryptionKey);

    const envelope: MessageEnvelope = {
      type: 'plain',
      from,
      to,
      encrypted,
      timestamp: Date.now(),
    };

    let messageId: string;

    // Try P2P first, fall back to local storage
    if (this.isP2PAvailable()) {
      messageId = await this.p2pNode.sendMessage(envelope);
    } else {
      // Store locally when P2P is unavailable
      await this.initLocalStorage();
      messageId = this.generateMessageId(envelope);

      // Store for recipient
      const envelopeData = Buffer.from(JSON.stringify(envelope)).toString('base64');
      await this.dhtStorage.store(to, envelopeData);

      // Store in sender's sent folder with plaintext subject/body for display
      const sentEnvelope = {
        ...envelope,
        plaintextSubject: subject,
        plaintextBody: body,
      };
      const sentKey = `sent:${from}`;
      const sentData = Buffer.from(JSON.stringify(sentEnvelope)).toString('base64');
      await this.dhtStorage.store(sentKey, sentData);

      console.log('Message stored locally (P2P unavailable):', messageId);
    }

    return {
      messageId,
      timestamp: envelope.timestamp,
    };
  }

  /**
   * Send a pre-encrypted message
   */
  async sendEncryptedMessage(
    to: string,
    encrypted: SerializedEncryptedMessage,
    routingToken?: string,
  ): Promise<SendResult> {
    if (!this.currentIdentity) {
      throw new Error('No identity set');
    }

    const envelope: MessageEnvelope = {
      type: routingToken ? 'sealed' : 'plain',
      from: this.currentIdentity.address,
      to,
      routingToken,
      encrypted,
      timestamp: Date.now(),
    };

    let messageId: string;

    if (this.isP2PAvailable()) {
      messageId = await this.p2pNode.sendMessage(envelope);
    } else {
      await this.initLocalStorage();
      messageId = this.generateMessageId(envelope);
      const envelopeData = Buffer.from(JSON.stringify(envelope)).toString('base64');
      await this.dhtStorage.store(to, envelopeData);
    }

    return {
      messageId,
      timestamp: envelope.timestamp,
    };
  }

  /**
   * Get inbox messages for a specific address
   * Falls back to currentIdentity if no address provided
   */
  async getInboxForAddress(address: string): Promise<StoredMessage[]> {
    await this.initLocalStorage();
    const records = await this.dhtStorage.getMessages(address);

    return records.map((record: MessageRecord) => {
      try {
        const envelope = JSON.parse(
          Buffer.from(record.data, 'base64').toString(),
        ) as MessageEnvelope;
        return {
          id: record.id,
          ...envelope,
          receivedAt: record.timestamp,
          read: false,
        } as StoredMessage;
      } catch {
        return null;
      }
    }).filter((msg): msg is StoredMessage => msg !== null);
  }

  /**
   * Get inbox messages
   */
  async getInbox(): Promise<StoredMessage[]> {
    if (this.isP2PAvailable()) {
      return this.p2pNode.getInbox();
    }

    // Use local storage when P2P unavailable
    if (!this.currentIdentity) return [];

    return this.getInboxForAddress(this.currentIdentity.address);
  }

  /**
   * Get sent messages for a specific address
   */
  async getSentForAddress(address: string): Promise<(StoredMessage & { plaintextSubject?: string; plaintextBody?: string })[]> {
    await this.initLocalStorage();
    const sentKey = `sent:${address}`;
    const records = await this.dhtStorage.getMessages(sentKey);

    return records.map((record: MessageRecord) => {
      try {
        const envelope = JSON.parse(
          Buffer.from(record.data, 'base64').toString(),
        ) as MessageEnvelope & { plaintextSubject?: string; plaintextBody?: string };
        return {
          id: record.id,
          ...envelope,
          receivedAt: record.timestamp,
          read: true, // Sent messages are always "read"
        } as StoredMessage & { plaintextSubject?: string; plaintextBody?: string };
      } catch {
        return null;
      }
    }).filter((msg): msg is (StoredMessage & { plaintextSubject?: string; plaintextBody?: string }) => msg !== null);
  }

  /**
   * Get a specific message
   */
  async getMessage(messageId: string): Promise<StoredMessage | null> {
    if (this.isP2PAvailable()) {
      return this.p2pNode.getMessage(messageId);
    }

    if (!this.currentIdentity) return null;

    await this.initLocalStorage();
    const record = await this.dhtStorage.getMessage(this.currentIdentity.address, messageId);
    if (!record) return null;

    try {
      const envelope = JSON.parse(
        Buffer.from(record.data, 'base64').toString(),
      ) as MessageEnvelope;
      return {
        id: record.id,
        ...envelope,
        receivedAt: record.timestamp,
        read: false,
      } as StoredMessage;
    } catch {
      return null;
    }
  }

  /**
   * Decrypt a message using the identity for a specific address
   */
  async decryptMessageForAddress(message: StoredMessage, address: string): Promise<DecryptedMessage | null> {
    // Try to get identity from store
    const identity = await this.identityStore.getIdentity(address);
    if (!identity) {
      console.warn(`No identity found for address: ${address}`);
      return null;
    }

    try {
      const encrypted = message.encrypted as SerializedEncryptedMessage;
      const decrypted = this.encryptionService.decryptJson<{
        subject: string;
        body: string;
        timestamp: number;
      }>(encrypted, identity.encryptionPrivateKey);

      return {
        id: (message as StoredMessage & { id?: string }).id || '',
        from: message.from || '',
        to: message.to || '',
        subject: decrypted.subject,
        body: decrypted.body,
        timestamp: message.timestamp,
        receivedAt: message.receivedAt,
        read: message.read,
      };
    } catch (err) {
      console.warn(`Failed to decrypt message for ${address}:`, (err as Error).message);
      return null;
    }
  }

  /**
   * Decrypt a message
   */
  decryptMessage(message: StoredMessage): DecryptedMessage | null {
    if (!this.currentIdentity) {
      throw new Error('No identity set');
    }

    try {
      const encrypted = message.encrypted as SerializedEncryptedMessage;
      const decrypted = this.encryptionService.decryptJson<{
        subject: string;
        body: string;
        timestamp: number;
      }>(encrypted, this.currentIdentity.encryptionPrivateKey);

      return {
        id: (message as StoredMessage & { id?: string }).id || '',
        from: message.from || '',
        to: message.to || '',
        subject: decrypted.subject,
        body: decrypted.body,
        timestamp: message.timestamp,
        receivedAt: message.receivedAt,
        read: message.read,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get the identity store service
   */
  getIdentityStore(): IdentityStoreService {
    return this.identityStore;
  }

  /**
   * Mark a message as read for a specific address
   */
  async markAsReadForAddress(address: string, messageId: string): Promise<void> {
    await this.initLocalStorage();
    await this.dhtStorage.markAsRead(address, messageId);

    if (this.isP2PAvailable()) {
      await this.p2pNode.markAsRead(messageId);
    }
  }

  /**
   * Mark a message as read
   */
  async markAsRead(messageId: string): Promise<void> {
    if (this.currentIdentity) {
      await this.markAsReadForAddress(this.currentIdentity.address, messageId);
    } else if (this.isP2PAvailable()) {
      await this.p2pNode.markAsRead(messageId);
    }
  }

  /**
   * Get read message IDs for an address
   */
  async getReadMessageIds(address: string): Promise<Set<string>> {
    await this.initLocalStorage();
    return this.dhtStorage.getReadMessageIds(address);
  }

  /**
   * Delete a message
   */
  async deleteMessage(messageId: string): Promise<void> {
    if (this.isP2PAvailable()) {
      await this.p2pNode.deleteMessage(messageId);
    } else if (this.currentIdentity) {
      await this.initLocalStorage();
      await this.dhtStorage.deleteMessage(this.currentIdentity.address, messageId);
    }
  }

  /**
   * Get node info
   */
  getNodeInfo(): { peerId: string | undefined; address: string; peers: number; addresses: string[] } {
    if (this.isP2PAvailable()) {
      return this.p2pNode.getInfo();
    }

    // Return local-only info when P2P is unavailable
    return {
      peerId: undefined,
      address: this.currentIdentity?.address || '',
      peers: 0,
      addresses: [],
    };
  }

  /**
   * Register message handler
   */
  onMessage(id: string, handler: (envelope: MessageEnvelope) => void): () => void {
    return this.p2pNode.onMessage(id, handler);
  }
}
