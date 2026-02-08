/**
 * Secure Storage Module for dMail
 *
 * Encrypts all sensitive data at rest using a master key derived from:
 * - Wallet signature (primary)
 * - Local password (fallback)
 *
 * NEVER stores private keys in plaintext.
 */

import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { scrypt } from '@noble/hashes/scrypt';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import { randomBytes } from 'crypto';
import { Level } from 'level';
import { join } from 'path';
import { DMAIL_DIR } from './identity.js';

const SCRYPT_N = 2 ** 17; // CPU/memory cost
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;

/**
 * Derive encryption key from password using scrypt
 */
export function deriveKeyFromPassword(password, salt) {
  const passwordBytes = new TextEncoder().encode(password);
  return scrypt(passwordBytes, salt, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, dkLen: KEY_LENGTH });
}

/**
 * Derive encryption key from wallet signature
 */
export function deriveKeyFromSignature(signature) {
  const sigBytes = typeof signature === 'string'
    ? new TextEncoder().encode(signature)
    : signature;
  return hkdf(sha256, sigBytes, undefined, new TextEncoder().encode('dmail-storage-key-v1'), KEY_LENGTH);
}

/**
 * Encrypt data with authenticated encryption
 */
export function encryptData(plaintext, key) {
  const nonce = randomBytes(12);
  const cipher = chacha20poly1305(key, nonce);
  const data = typeof plaintext === 'string'
    ? new TextEncoder().encode(plaintext)
    : plaintext;
  const ciphertext = cipher.encrypt(data);

  // Return nonce + ciphertext
  const result = new Uint8Array(12 + ciphertext.length);
  result.set(nonce, 0);
  result.set(ciphertext, 12);
  return result;
}

/**
 * Decrypt data
 */
export function decryptData(encrypted, key) {
  const nonce = encrypted.slice(0, 12);
  const ciphertext = encrypted.slice(12);
  const cipher = chacha20poly1305(key, nonce);
  return cipher.decrypt(ciphertext);
}

/**
 * Secure key storage that encrypts private keys at rest
 */
export class SecureKeyStore {
  constructor(storageKey) {
    this.db = new Level(join(DMAIL_DIR, 'secure-keys'), { valueEncoding: 'buffer' });
    this.storageKey = storageKey;
    this.unlocked = false;
  }

  /**
   * Unlock the store with a derived key
   */
  unlock(key) {
    this.storageKey = key;
    this.unlocked = true;
  }

  /**
   * Lock the store (clear key from memory)
   */
  lock() {
    if (this.storageKey) {
      // Zero out the key in memory
      this.storageKey.fill(0);
    }
    this.storageKey = null;
    this.unlocked = false;
  }

  /**
   * Store encrypted private key
   */
  async storePrivateKey(name, privateKey) {
    if (!this.unlocked) {
      throw new Error('Key store is locked');
    }

    const encrypted = encryptData(privateKey, this.storageKey);
    await this.db.put(`key:${name}`, Buffer.from(encrypted));
  }

  /**
   * Retrieve and decrypt private key
   */
  async getPrivateKey(name) {
    if (!this.unlocked) {
      throw new Error('Key store is locked');
    }

    try {
      const encrypted = await this.db.get(`key:${name}`);
      return decryptData(new Uint8Array(encrypted), this.storageKey);
    } catch (e) {
      if (e.code === 'LEVEL_NOT_FOUND') return null;
      throw e;
    }
  }

  /**
   * Delete a key
   */
  async deletePrivateKey(name) {
    await this.db.del(`key:${name}`);
  }

  /**
   * List key names (not the keys themselves)
   */
  async listKeys() {
    const names = [];
    for await (const key of this.db.keys()) {
      if (key.startsWith('key:')) {
        names.push(key.slice(4));
      }
    }
    return names;
  }

  async close() {
    this.lock();
    await this.db.close();
  }
}

/**
 * Secure memory handling - zeros out sensitive data
 */
export function secureZero(buffer) {
  if (buffer instanceof Uint8Array || buffer instanceof Buffer) {
    buffer.fill(0);
  }
}

/**
 * Create a secure random token
 */
export function generateSecureToken(length = 32) {
  return randomBytes(length);
}

/**
 * Constant-time comparison to prevent timing attacks
 */
export function secureCompare(a, b) {
  if (a.length !== b.length) return false;

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}
