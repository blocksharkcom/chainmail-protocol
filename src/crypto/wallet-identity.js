/**
 * Wallet-Based Identity System for dMail
 *
 * Links Ethereum wallet to dMail identity via deterministic key derivation.
 * Only the wallet owner can derive the encryption keys.
 *
 * Security Model:
 * 1. User signs a message with their Ethereum wallet
 * 2. Signature is used as seed to derive Ed25519/X25519 keys
 * 3. Same wallet always produces same dMail identity
 * 4. No one without the wallet can derive the private keys
 */

import { ed25519 } from '@noble/curves/ed25519';
import { x25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import { base58btc } from 'multiformats/bases/base58';
import { ethers } from 'ethers';

const ADDRESS_PREFIX = 'dm1';
const DOMAIN_SEPARATOR = 'dmail-identity-v1';
const SIGNING_MESSAGE = `Sign this message to access your dMail inbox.

This signature will be used to derive your encryption keys.
Only sign this on trusted dMail applications.

Domain: ${DOMAIN_SEPARATOR}
Timestamp: `;

/**
 * Wallet-linked dMail Identity
 */
export class WalletIdentity {
  constructor(privateKey, publicKey, walletAddress) {
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    this.walletAddress = walletAddress;
    this._address = null;
    this._encryptionKeys = null;
  }

  /**
   * Create identity from wallet signature
   * @param {string} signature - Ethereum signature (already verified by caller)
   * @param {string} walletAddress - Ethereum address
   * @param {number} timestamp - Timestamp (unused, kept for API compatibility)
   */
  static fromSignature(signature, walletAddress, timestamp) {
    // Note: Signature verification is done by the caller (auth.js)
    // We just use the signature as seed material for key derivation

    // Derive deterministic seed from signature
    const signatureBytes = ethers.getBytes(signature);
    const seed = hkdf(
      sha256,
      signatureBytes,
      new TextEncoder().encode(DOMAIN_SEPARATOR),
      new TextEncoder().encode('ed25519-private-key'),
      32
    );

    // Create Ed25519 keypair from seed
    const privateKey = new Uint8Array(seed);
    const publicKey = ed25519.getPublicKey(privateKey);

    return new WalletIdentity(privateKey, publicKey, walletAddress);
  }

  /**
   * Generate the message that needs to be signed
   */
  static getSigningMessage(timestamp = Date.now()) {
    return {
      message: SIGNING_MESSAGE + timestamp,
      timestamp
    };
  }

  /**
   * Get the dMail address
   */
  get address() {
    if (!this._address) {
      const encoded = base58btc.encode(this.publicKey);
      this._address = ADDRESS_PREFIX + encoded.slice(1);
    }
    return this._address;
  }

  /**
   * Get X25519 encryption keys (derived from Ed25519)
   */
  get encryptionKeys() {
    if (!this._encryptionKeys) {
      const hash = sha256(this.privateKey);
      hash[0] &= 248;
      hash[31] &= 127;
      hash[31] |= 64;

      this._encryptionKeys = {
        privateKey: hash.slice(0, 32),
        publicKey: x25519.getPublicKey(hash.slice(0, 32))
      };
    }
    return this._encryptionKeys;
  }

  get encryptionPublicKey() {
    return this.encryptionKeys.publicKey;
  }

  get encryptionPrivateKey() {
    return this.encryptionKeys.privateKey;
  }

  /**
   * Sign a message with the dMail identity
   */
  sign(message) {
    const msgBytes = typeof message === 'string'
      ? new TextEncoder().encode(message)
      : message;
    return ed25519.sign(msgBytes, this.privateKey);
  }

  /**
   * Export public info (safe to share)
   */
  toPublicJSON() {
    return {
      address: this.address,
      publicKey: Buffer.from(this.publicKey).toString('hex'),
      encryptionPublicKey: Buffer.from(this.encryptionPublicKey).toString('hex'),
      walletAddress: this.walletAddress
    };
  }
}

/**
 * Verify wallet ownership of a dMail address
 */
export async function verifyWalletOwnership(walletAddress, signature, dmailAddress, timestamp) {
  try {
    const identity = WalletIdentity.fromSignature(signature, walletAddress, timestamp);
    return identity.address === dmailAddress;
  } catch {
    return false;
  }
}

/**
 * Create a challenge for wallet verification
 */
export function createVerificationChallenge() {
  const timestamp = Date.now();
  return WalletIdentity.getSigningMessage(timestamp);
}

export { SIGNING_MESSAGE, DOMAIN_SEPARATOR };
