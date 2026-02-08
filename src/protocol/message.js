/**
 * Message Protocol for dMail
 *
 * Defines the message envelope format that includes:
 * - Encrypted content
 * - Sender signature
 * - Proof of work
 * - Optional blockchain timestamp reference
 */

import { sha256 } from '@noble/hashes/sha256';
import {
  encryptMessage,
  decryptMessage,
  serializeEncrypted,
  deserializeEncrypted
} from '../crypto/encryption.js';
import {
  addressToPublicKey,
  verifySignature
} from '../crypto/identity.js';
import {
  computeProofOfWork,
  verifyProofOfWork,
  DEFAULT_DIFFICULTY
} from '../crypto/pow.js';

const PROTOCOL_VERSION = '1.0.0';

/**
 * Create a message envelope
 */
export class MessageBuilder {
  constructor(identity) {
    this.identity = identity;
    this.message = {
      version: PROTOCOL_VERSION,
      from: identity.address,
      fromEncryptionKey: Buffer.from(identity.encryptionPublicKey).toString('base64'),
      to: null,
      subject: '',
      body: '',
      attachments: [],
      timestamp: Date.now(),
      replyTo: null,
      threadId: null
    };
  }

  to(address) {
    this.message.to = address;
    return this;
  }

  subject(subject) {
    this.message.subject = subject;
    return this;
  }

  body(body) {
    this.message.body = body;
    return this;
  }

  attachment(attachment) {
    this.message.attachments.push(attachment);
    return this;
  }

  replyTo(messageId) {
    this.message.replyTo = messageId;
    return this;
  }

  thread(threadId) {
    this.message.threadId = threadId;
    return this;
  }

  /**
   * Build and encrypt the message
   */
  async build(recipientEncryptionKey = null) {
    if (!this.message.to) {
      throw new Error('Recipient address required');
    }

    // Get recipient's encryption key
    let recipientKey = recipientEncryptionKey;
    if (!recipientKey) {
      // Try to derive from address (this is simplified - in practice
      // you'd look this up from DHT or blockchain)
      try {
        recipientKey = addressToPublicKey(this.message.to);
      } catch (e) {
        throw new Error('Recipient encryption key required');
      }
    }

    // Serialize the plaintext message
    const plaintext = new TextEncoder().encode(JSON.stringify({
      subject: this.message.subject,
      body: this.message.body,
      attachments: this.message.attachments,
      replyTo: this.message.replyTo,
      threadId: this.message.threadId
    }));

    // Encrypt the message
    const encrypted = encryptMessage(
      plaintext,
      this.identity.encryptionPrivateKey,
      recipientKey
    );

    // Create the envelope (unencrypted metadata + encrypted content)
    const envelope = {
      version: PROTOCOL_VERSION,
      from: this.message.from,
      fromEncryptionKey: this.message.fromEncryptionKey,
      to: this.message.to,
      timestamp: this.message.timestamp,
      encrypted: serializeEncrypted(encrypted)
    };

    // Hash the envelope for signing and PoW
    const envelopeHash = this.hashEnvelope(envelope);

    // Sign the envelope
    const signature = this.identity.sign(envelopeHash);
    envelope.signature = Buffer.from(signature).toString('base64');

    // Compute proof of work
    console.log('Computing proof of work...');
    const pow = computeProofOfWork(
      Buffer.from(envelopeHash).toString('hex'),
      DEFAULT_DIFFICULTY
    );
    envelope.pow = pow;

    return envelope;
  }

  hashEnvelope(envelope) {
    const data = JSON.stringify({
      version: envelope.version,
      from: envelope.from,
      to: envelope.to,
      timestamp: envelope.timestamp,
      encrypted: envelope.encrypted
    });
    return sha256(new TextEncoder().encode(data));
  }
}

/**
 * Parse and decrypt a received message
 */
export class MessageParser {
  constructor(identity) {
    this.identity = identity;
  }

  /**
   * Parse and validate a message envelope
   */
  async parse(envelope) {
    // Verify version
    if (!envelope.version || !envelope.version.startsWith('1.')) {
      throw new Error('Unsupported protocol version');
    }

    // Verify this message is for us
    if (envelope.to !== this.identity.address) {
      throw new Error('Message not addressed to this identity');
    }

    // Verify proof of work
    const envelopeHash = this.hashEnvelope(envelope);
    const hashHex = Buffer.from(envelopeHash).toString('hex');

    if (!verifyProofOfWork(hashHex, envelope.pow)) {
      throw new Error('Invalid proof of work');
    }

    // Verify signature
    const senderPublicKey = addressToPublicKey(envelope.from);
    const signature = new Uint8Array(Buffer.from(envelope.signature, 'base64'));

    if (!verifySignature(envelopeHash, signature, senderPublicKey)) {
      throw new Error('Invalid signature');
    }

    // Decrypt the message
    const encrypted = deserializeEncrypted(envelope.encrypted);
    const plaintext = decryptMessage(encrypted, this.identity.encryptionPrivateKey);
    const content = JSON.parse(new TextDecoder().decode(plaintext));

    return {
      id: this.getMessageId(envelope),
      from: envelope.from,
      to: envelope.to,
      timestamp: envelope.timestamp,
      subject: content.subject,
      body: content.body,
      attachments: content.attachments || [],
      replyTo: content.replyTo,
      threadId: content.threadId,
      verified: true
    };
  }

  hashEnvelope(envelope) {
    const data = JSON.stringify({
      version: envelope.version,
      from: envelope.from,
      to: envelope.to,
      timestamp: envelope.timestamp,
      encrypted: envelope.encrypted
    });
    return sha256(new TextEncoder().encode(data));
  }

  getMessageId(envelope) {
    const hash = this.hashEnvelope(envelope);
    return Buffer.from(hash).toString('hex').slice(0, 32);
  }
}

/**
 * Create a new message
 */
export function createMessage(identity) {
  return new MessageBuilder(identity);
}

/**
 * Parse a received message
 */
export function parseMessage(identity, envelope) {
  const parser = new MessageParser(identity);
  return parser.parse(envelope);
}

export { PROTOCOL_VERSION };
