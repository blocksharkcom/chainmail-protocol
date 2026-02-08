/**
 * Cryptographic Identity System for dMail
 *
 * Your identity IS your keypair:
 * - Ed25519 for signing (proves you sent a message)
 * - X25519 for encryption (derived from Ed25519)
 *
 * Address format: dm1<base58-encoded-public-key>
 */

import { ed25519 } from '@noble/curves/ed25519';
import { x25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from 'crypto';
import { base58btc } from 'multiformats/bases/base58';
import { Level } from 'level';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, existsSync } from 'fs';

const DMAIL_DIR = join(homedir(), '.dmail');
const ADDRESS_PREFIX = 'dm1';

// Ensure dmail directory exists
if (!existsSync(DMAIL_DIR)) {
  mkdirSync(DMAIL_DIR, { recursive: true });
}

/**
 * Represents a dMail identity (keypair)
 */
export class Identity {
  constructor(privateKey, publicKey) {
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    this._address = null;
  }

  /**
   * Generate a new random identity
   */
  static generate() {
    const privateKey = randomBytes(32);
    const publicKey = ed25519.getPublicKey(privateKey);
    return new Identity(privateKey, publicKey);
  }

  /**
   * Load identity from private key bytes
   */
  static fromPrivateKey(privateKey) {
    const publicKey = ed25519.getPublicKey(privateKey);
    return new Identity(privateKey, publicKey);
  }

  /**
   * Get the dMail address for this identity
   * Format: dm1<base58-encoded-public-key>
   */
  get address() {
    if (!this._address) {
      const encoded = base58btc.encode(this.publicKey);
      // Remove the 'z' prefix that base58btc adds
      this._address = ADDRESS_PREFIX + encoded.slice(1);
    }
    return this._address;
  }

  /**
   * Get X25519 public key for encryption (derived from Ed25519)
   */
  get encryptionPublicKey() {
    // Convert Ed25519 private key to X25519
    // Use the scalar from the Ed25519 private key
    const hash = sha256(this.privateKey);
    hash[0] &= 248;
    hash[31] &= 127;
    hash[31] |= 64;
    return x25519.getPublicKey(hash.slice(0, 32));
  }

  /**
   * Get X25519 private key for encryption
   */
  get encryptionPrivateKey() {
    const hash = sha256(this.privateKey);
    hash[0] &= 248;
    hash[31] &= 127;
    hash[31] |= 64;
    return hash.slice(0, 32);
  }

  /**
   * Sign a message
   */
  sign(message) {
    const msgBytes = typeof message === 'string'
      ? new TextEncoder().encode(message)
      : message;
    return ed25519.sign(msgBytes, this.privateKey);
  }

  /**
   * Export identity to JSON (for backup)
   */
  toJSON() {
    return {
      privateKey: Buffer.from(this.privateKey).toString('hex'),
      publicKey: Buffer.from(this.publicKey).toString('hex'),
      address: this.address
    };
  }

  /**
   * Import identity from JSON
   */
  static fromJSON(json) {
    const privateKey = Buffer.from(json.privateKey, 'hex');
    const publicKey = Buffer.from(json.publicKey, 'hex');
    return new Identity(privateKey, publicKey);
  }
}

/**
 * Parse a dMail address to extract the public key
 */
export function addressToPublicKey(address) {
  if (!address.startsWith(ADDRESS_PREFIX)) {
    throw new Error(`Invalid dMail address: must start with ${ADDRESS_PREFIX}`);
  }
  const encoded = 'z' + address.slice(ADDRESS_PREFIX.length);
  return base58btc.decode(encoded);
}

/**
 * Verify a signature against a public key
 */
export function verifySignature(message, signature, publicKey) {
  const msgBytes = typeof message === 'string'
    ? new TextEncoder().encode(message)
    : message;
  return ed25519.verify(signature, msgBytes, publicKey);
}

/**
 * Get the encryption public key from a dMail address
 * Note: This requires the sender to include their encryption key in messages
 * or we need a separate key discovery mechanism
 */
export function deriveEncryptionKey(edPublicKey) {
  // This is a simplified derivation - in practice you'd want
  // the recipient to publish their X25519 key separately
  // For now, we'll include encryption keys in the message envelope
  return edPublicKey;
}

/**
 * Identity storage manager
 */
export class IdentityStore {
  constructor() {
    this.db = new Level(join(DMAIL_DIR, 'identity'), { valueEncoding: 'json' });
  }

  async saveIdentity(name, identity) {
    await this.db.put(`identity:${name}`, identity.toJSON());
    // Also store as default if it's the first one
    const existing = await this.listIdentities();
    if (existing.length === 0) {
      await this.db.put('default', name);
    }
  }

  async getIdentity(name) {
    try {
      const json = await this.db.get(`identity:${name}`);
      return Identity.fromJSON(json);
    } catch (e) {
      if (e.code === 'LEVEL_NOT_FOUND') return null;
      throw e;
    }
  }

  async getDefaultIdentity() {
    try {
      const defaultName = await this.db.get('default');
      return this.getIdentity(defaultName);
    } catch (e) {
      return null;
    }
  }

  async setDefault(name) {
    await this.db.put('default', name);
  }

  async listIdentities() {
    const identities = [];
    for await (const [key, value] of this.db.iterator()) {
      if (key.startsWith('identity:')) {
        identities.push({
          name: key.slice(9),
          address: value.address
        });
      }
    }
    return identities;
  }

  async close() {
    await this.db.close();
  }
}

export { DMAIL_DIR };
