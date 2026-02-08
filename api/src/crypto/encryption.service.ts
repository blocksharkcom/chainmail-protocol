import { Injectable } from '@nestjs/common';
import { x25519 } from '@noble/curves/ed25519';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import { randomBytes } from 'crypto';

const INFO = new TextEncoder().encode('dmail-encryption-v1');

export interface EncryptedMessage {
  ephemeralPublicKey: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

export interface SerializedEncryptedMessage {
  ephemeralPublicKey: string;
  nonce: string;
  ciphertext: string;
}

@Injectable()
export class EncryptionService {
  /**
   * Encrypt a message for a recipient
   * Uses X25519 ECDH + HKDF + ChaCha20-Poly1305
   */
  encrypt(plaintext: Uint8Array, recipientPublicKey: Uint8Array): EncryptedMessage {
    // Generate ephemeral key pair
    const ephemeralPrivate = randomBytes(32);
    const ephemeralPublic = x25519.getPublicKey(ephemeralPrivate);

    // Perform ECDH
    const sharedSecret = x25519.getSharedSecret(ephemeralPrivate, recipientPublicKey);

    // Derive encryption key using HKDF
    const encryptionKey = hkdf(sha256, sharedSecret, undefined, INFO, 32);

    // Generate nonce
    const nonce = randomBytes(12);

    // Encrypt with ChaCha20-Poly1305
    const cipher = chacha20poly1305(encryptionKey, nonce);
    const ciphertext = cipher.encrypt(plaintext);

    return {
      ephemeralPublicKey: ephemeralPublic,
      nonce,
      ciphertext,
    };
  }

  /**
   * Decrypt a message
   */
  decrypt(encrypted: EncryptedMessage, recipientPrivateKey: Uint8Array): Uint8Array {
    const { ephemeralPublicKey, nonce, ciphertext } = encrypted;

    // Perform ECDH
    const sharedSecret = x25519.getSharedSecret(recipientPrivateKey, ephemeralPublicKey);

    // Derive encryption key using HKDF
    const encryptionKey = hkdf(sha256, sharedSecret, undefined, INFO, 32);

    // Decrypt with ChaCha20-Poly1305
    const cipher = chacha20poly1305(encryptionKey, nonce);
    return cipher.decrypt(ciphertext);
  }

  /**
   * Serialize encrypted message for transmission
   */
  serialize(encrypted: EncryptedMessage): SerializedEncryptedMessage {
    return {
      ephemeralPublicKey: Buffer.from(encrypted.ephemeralPublicKey).toString('base64'),
      nonce: Buffer.from(encrypted.nonce).toString('base64'),
      ciphertext: Buffer.from(encrypted.ciphertext).toString('base64'),
    };
  }

  /**
   * Deserialize encrypted message from transmission
   */
  deserialize(serialized: SerializedEncryptedMessage): EncryptedMessage {
    return {
      ephemeralPublicKey: new Uint8Array(Buffer.from(serialized.ephemeralPublicKey, 'base64')),
      nonce: new Uint8Array(Buffer.from(serialized.nonce, 'base64')),
      ciphertext: new Uint8Array(Buffer.from(serialized.ciphertext, 'base64')),
    };
  }

  /**
   * Encrypt a string message
   */
  encryptString(message: string, recipientPublicKey: Uint8Array): SerializedEncryptedMessage {
    const plaintext = new TextEncoder().encode(message);
    const encrypted = this.encrypt(plaintext, recipientPublicKey);
    return this.serialize(encrypted);
  }

  /**
   * Decrypt to a string message
   */
  decryptString(serialized: SerializedEncryptedMessage, recipientPrivateKey: Uint8Array): string {
    const encrypted = this.deserialize(serialized);
    const plaintext = this.decrypt(encrypted, recipientPrivateKey);
    return new TextDecoder().decode(plaintext);
  }

  /**
   * Encrypt JSON object
   */
  encryptJson<T>(data: T, recipientPublicKey: Uint8Array): SerializedEncryptedMessage {
    return this.encryptString(JSON.stringify(data), recipientPublicKey);
  }

  /**
   * Decrypt to JSON object
   */
  decryptJson<T>(serialized: SerializedEncryptedMessage, recipientPrivateKey: Uint8Array): T {
    const jsonString = this.decryptString(serialized, recipientPrivateKey);
    return JSON.parse(jsonString) as T;
  }
}
