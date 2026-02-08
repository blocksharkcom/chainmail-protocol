import { x25519 } from '@noble/curves/ed25519';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import { randomBytes } from 'crypto';

const INFO = new TextEncoder().encode('dmail-encryption-v1');

export function encryptMessage(plaintext, senderPrivateKey, recipientPublicKey) {
  const ephemeralPrivate = randomBytes(32);
  const ephemeralPublic = x25519.getPublicKey(ephemeralPrivate);
  const sharedSecret = x25519.getSharedSecret(ephemeralPrivate, recipientPublicKey);
  const encryptionKey = hkdf(sha256, sharedSecret, undefined, INFO, 32);
  const nonce = randomBytes(12);
  const cipher = chacha20poly1305(encryptionKey, nonce);
  const ciphertext = cipher.encrypt(plaintext);

  return {
    ephemeralPublicKey: ephemeralPublic,
    nonce: nonce,
    ciphertext: ciphertext
  };
}

export function decryptMessage(encrypted, recipientPrivateKey) {
  const { ephemeralPublicKey, nonce, ciphertext } = encrypted;
  const sharedSecret = x25519.getSharedSecret(recipientPrivateKey, ephemeralPublicKey);
  const encryptionKey = hkdf(sha256, sharedSecret, undefined, INFO, 32);
  const cipher = chacha20poly1305(encryptionKey, nonce);
  return cipher.decrypt(ciphertext);
}

export function serializeEncrypted(encrypted) {
  return {
    ephemeralPublicKey: Buffer.from(encrypted.ephemeralPublicKey).toString('base64'),
    nonce: Buffer.from(encrypted.nonce).toString('base64'),
    ciphertext: Buffer.from(encrypted.ciphertext).toString('base64')
  };
}

export function deserializeEncrypted(serialized) {
  return {
    ephemeralPublicKey: new Uint8Array(Buffer.from(serialized.ephemeralPublicKey, 'base64')),
    nonce: new Uint8Array(Buffer.from(serialized.nonce, 'base64')),
    ciphertext: new Uint8Array(Buffer.from(serialized.ciphertext, 'base64'))
  };
}
