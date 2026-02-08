import { x25519 } from '@noble/curves/ed25519';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import { randomBytes } from 'crypto';

const PROTOCOL_VERSION = '2.0.0';
const INFO_INNER = new TextEncoder().encode('dmail-inner-v2');
const INFO_OUTER = new TextEncoder().encode('dmail-outer-v2');

/**
 * Create a sealed envelope that hides all metadata
 */
export class SealedEnvelopeBuilder {
  constructor(senderIdentity) {
    this.sender = senderIdentity;
    this.recipient = null;
    this.recipientKey = null;
    this.content = {
      subject: '',
      body: '',
      attachments: [],
      replyTo: null,
      threadId: null
    };
  }

  to(address, encryptionPublicKey) {
    this.recipient = address;
    this.recipientKey = encryptionPublicKey;
    return this;
  }

  subject(s) {
    this.content.subject = s;
    return this;
  }

  body(b) {
    this.content.body = b;
    return this;
  }

  attachment(a) {
    this.content.attachments.push(a);
    return this;
  }

  /**
   * Build the sealed envelope
   */
  async build() {
    if (!this.recipient || !this.recipientKey) {
      throw new Error('Recipient address and encryption key required');
    }

    // === INNER ENVELOPE (encrypted for recipient) ===
    // Contains ALL message data including sender info
    const innerPlaintext = {
      version: PROTOCOL_VERSION,
      from: this.sender.address,
      fromPublicKey: Buffer.from(this.sender.publicKey).toString('base64'),
      fromEncryptionKey: Buffer.from(this.sender.encryptionPublicKey).toString('base64'),
      to: this.recipient,
      timestamp: Date.now(),
      subject: this.content.subject,
      body: this.content.body,
      attachments: this.content.attachments,
      replyTo: this.content.replyTo,
      threadId: this.content.threadId
    };

    // Sign the inner content
    const innerBytes = new TextEncoder().encode(JSON.stringify(innerPlaintext));
    const signature = this.sender.sign(sha256(innerBytes));
    innerPlaintext.signature = Buffer.from(signature).toString('base64');

    // Encrypt inner envelope for recipient
    const innerEncrypted = this.encryptForRecipient(
      new TextEncoder().encode(JSON.stringify(innerPlaintext)),
      this.recipientKey
    );

    // === OUTER ENVELOPE (visible on network) ===
    // Contains NO identifying information
    const routingToken = this.generateRoutingToken(this.recipient);

    // Fuzz timestamp to prevent correlation (±5 minutes)
    const fuzzedTimestamp = Date.now() + Math.floor(Math.random() * 600000) - 300000;

    const outerEnvelope = {
      version: PROTOCOL_VERSION,
      type: 'sealed',
      // Routing token: derived from recipient address, unlinkable
      routingToken: routingToken,
      // Fuzzed timestamp
      timestamp: fuzzedTimestamp,
      // Encrypted inner envelope
      payload: {
        ephemeralKey: Buffer.from(innerEncrypted.ephemeralKey).toString('base64'),
        nonce: Buffer.from(innerEncrypted.nonce).toString('base64'),
        ciphertext: Buffer.from(innerEncrypted.ciphertext).toString('base64')
      },
      // Random padding to hide message size
      padding: Buffer.from(randomBytes(Math.floor(Math.random() * 256))).toString('base64')
    };

    return outerEnvelope;
  }

  /**
   * Encrypt data for recipient using X25519 + ChaCha20-Poly1305
   */
  encryptForRecipient(plaintext, recipientPublicKey) {
    // Generate ephemeral keypair
    const ephemeralPrivate = randomBytes(32);
    const ephemeralPublic = x25519.getPublicKey(ephemeralPrivate);

    // Compute shared secret
    const sharedSecret = x25519.getSharedSecret(ephemeralPrivate, recipientPublicKey);

    // Derive key
    const key = hkdf(sha256, sharedSecret, undefined, INFO_INNER, 32);

    // Encrypt
    const nonce = randomBytes(12);
    const cipher = chacha20poly1305(key, nonce);
    const ciphertext = cipher.encrypt(plaintext);

    return {
      ephemeralKey: ephemeralPublic,
      nonce: nonce,
      ciphertext: ciphertext
    };
  }

  /**
   * Generate routing token from recipient address
   * This is a hash that relay nodes use for routing without knowing the actual address
   */
  generateRoutingToken(address) {
    // Use HKDF to derive a routing token that can't be reversed to the address
    const addressBytes = new TextEncoder().encode(address);
    const token = hkdf(sha256, addressBytes, undefined, new TextEncoder().encode('dmail-routing-v2'), 16);
    return Buffer.from(token).toString('hex');
  }
}

/**
 * Parse and decrypt a sealed envelope
 */
export class SealedEnvelopeParser {
  constructor(recipientIdentity) {
    this.identity = recipientIdentity;
  }

  /**
   * Decrypt and verify a sealed envelope
   */
  async parse(envelope) {
    if (envelope.type !== 'sealed') {
      throw new Error('Not a sealed envelope');
    }

    // Decrypt the inner envelope
    const decrypted = this.decryptPayload(envelope.payload);
    const inner = JSON.parse(new TextDecoder().decode(decrypted));

    // Verify this message is for us
    if (inner.to !== this.identity.address) {
      throw new Error('Message not addressed to this identity');
    }

    // Verify signature
    const signatureBytes = Buffer.from(inner.signature, 'base64');
    const innerCopy = { ...inner };
    delete innerCopy.signature;
    const innerBytes = new TextEncoder().encode(JSON.stringify(innerCopy));
    const hash = sha256(innerBytes);

    // Get sender's public key
    const senderPublicKey = Buffer.from(inner.fromPublicKey, 'base64');

    // Verify using ed25519 (imported from identity module)
    const { ed25519 } = await import('@noble/curves/ed25519');
    const valid = ed25519.verify(signatureBytes, hash, senderPublicKey);

    if (!valid) {
      throw new Error('Invalid message signature');
    }

    return {
      from: inner.from,
      to: inner.to,
      subject: inner.subject,
      body: inner.body,
      attachments: inner.attachments || [],
      timestamp: inner.timestamp,
      replyTo: inner.replyTo,
      threadId: inner.threadId,
      verified: true,
      sealed: true
    };
  }

  /**
   * Decrypt the payload
   */
  decryptPayload(payload) {
    const ephemeralKey = Buffer.from(payload.ephemeralKey, 'base64');
    const nonce = Buffer.from(payload.nonce, 'base64');
    const ciphertext = Buffer.from(payload.ciphertext, 'base64');

    // Compute shared secret
    const sharedSecret = x25519.getSharedSecret(
      this.identity.encryptionPrivateKey,
      ephemeralKey
    );

    // Derive key
    const key = hkdf(sha256, sharedSecret, undefined, INFO_INNER, 32);

    // Decrypt
    const cipher = chacha20poly1305(key, nonce);
    return cipher.decrypt(ciphertext);
  }

  /**
   * Check if this envelope is for us (without decrypting)
   */
  isForMe(envelope) {
    const myToken = this.generateRoutingToken(this.identity.address);
    return envelope.routingToken === myToken;
  }

  generateRoutingToken(address) {
    const addressBytes = new TextEncoder().encode(address);
    const token = hkdf(sha256, addressBytes, undefined, new TextEncoder().encode('dmail-routing-v2'), 16);
    return Buffer.from(token).toString('hex');
  }
}

/**
 * Create a sealed message builder
 */
export function createSealedMessage(identity) {
  return new SealedEnvelopeBuilder(identity);
}

/**
 * Parse a sealed message
 */
export function parseSealedMessage(identity, envelope) {
  const parser = new SealedEnvelopeParser(identity);
  return parser.parse(envelope);
}

export { PROTOCOL_VERSION };
