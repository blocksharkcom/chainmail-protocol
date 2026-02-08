/**
 * Double Ratchet Protocol Implementation for dMail
 *
 * Provides forward secrecy and break-in recovery for messaging.
 * Based on the Signal Protocol's Double Ratchet algorithm.
 *
 * Key features:
 * - Forward secrecy: Past messages can't be decrypted if keys are compromised
 * - Break-in recovery: Future messages become secure after key compromise
 * - Per-message keys: Each message uses a unique encryption key
 *
 * Components:
 * - DH Ratchet: Performs X25519 key exchanges on each message turn
 * - Symmetric Ratchet: Derives chain keys for consecutive messages
 * - KDF Chain: HKDF-based key derivation function
 */

import { x25519 } from '@noble/curves/ed25519';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import { randomBytes } from 'crypto';

// Constants
const INFO_ROOT_KEY = new TextEncoder().encode('dmail-root-key');
const INFO_CHAIN_KEY = new TextEncoder().encode('dmail-chain-key');
const INFO_MESSAGE_KEY = new TextEncoder().encode('dmail-message-key');
const MAX_SKIP = 100; // Maximum number of message keys to store for out-of-order delivery

/**
 * KDF (Key Derivation Function) for the ratchet
 */
function kdfRK(rootKey, dhOutput) {
  // Derive new root key and chain key from DH output
  const okm = hkdf(sha256, dhOutput, rootKey, INFO_ROOT_KEY, 64);
  return {
    rootKey: okm.slice(0, 32),
    chainKey: okm.slice(32, 64)
  };
}

/**
 * Symmetric KDF for chain key advancement
 */
function kdfCK(chainKey) {
  // Derive new chain key and message key
  const nextChainKey = hkdf(sha256, chainKey, undefined, INFO_CHAIN_KEY, 32);
  const messageKey = hkdf(sha256, chainKey, undefined, INFO_MESSAGE_KEY, 32);
  return { chainKey: nextChainKey, messageKey };
}

/**
 * Generate a new X25519 key pair
 */
function generateKeyPair() {
  const privateKey = randomBytes(32);
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

/**
 * Perform X25519 Diffie-Hellman
 */
function dh(privateKey, publicKey) {
  return x25519.getSharedSecret(privateKey, publicKey);
}

/**
 * Encrypt with ChaCha20-Poly1305
 */
function encrypt(key, plaintext, associatedData = new Uint8Array()) {
  const nonce = randomBytes(12);
  const cipher = chacha20poly1305(key, nonce, associatedData);
  const ciphertext = cipher.encrypt(plaintext);
  return { nonce, ciphertext };
}

/**
 * Decrypt with ChaCha20-Poly1305
 */
function decrypt(key, nonce, ciphertext, associatedData = new Uint8Array()) {
  const cipher = chacha20poly1305(key, nonce, associatedData);
  return cipher.decrypt(ciphertext);
}

/**
 * Message Header
 */
export class MessageHeader {
  constructor(dhPublicKey, previousCounter, messageNumber) {
    this.dhPublicKey = dhPublicKey;
    this.previousCounter = previousCounter;
    this.messageNumber = messageNumber;
  }

  serialize() {
    return {
      dh: Buffer.from(this.dhPublicKey).toString('base64'),
      pn: this.previousCounter,
      n: this.messageNumber
    };
  }

  static deserialize(data) {
    return new MessageHeader(
      new Uint8Array(Buffer.from(data.dh, 'base64')),
      data.pn,
      data.n
    );
  }
}

/**
 * Double Ratchet Session State
 */
export class DoubleRatchetState {
  constructor() {
    // DH ratchet key pair
    this.DHs = null; // Our current DH key pair
    this.DHr = null; // Remote party's current DH public key

    // Root key
    this.RK = null;

    // Chain keys
    this.CKs = null; // Sending chain key
    this.CKr = null; // Receiving chain key

    // Message counters
    this.Ns = 0; // Sending message number
    this.Nr = 0; // Receiving message number
    this.PN = 0; // Previous sending chain message number

    // Skipped message keys for out-of-order delivery
    this.MKSKIPPED = new Map(); // Map<"pubkey:n", messageKey>
  }

  /**
   * Serialize state for storage
   */
  serialize() {
    return {
      DHs: this.DHs ? {
        privateKey: Buffer.from(this.DHs.privateKey).toString('base64'),
        publicKey: Buffer.from(this.DHs.publicKey).toString('base64')
      } : null,
      DHr: this.DHr ? Buffer.from(this.DHr).toString('base64') : null,
      RK: this.RK ? Buffer.from(this.RK).toString('base64') : null,
      CKs: this.CKs ? Buffer.from(this.CKs).toString('base64') : null,
      CKr: this.CKr ? Buffer.from(this.CKr).toString('base64') : null,
      Ns: this.Ns,
      Nr: this.Nr,
      PN: this.PN,
      MKSKIPPED: Array.from(this.MKSKIPPED.entries()).map(([k, v]) => [k, Buffer.from(v).toString('base64')])
    };
  }

  /**
   * Deserialize state from storage
   */
  static deserialize(data) {
    const state = new DoubleRatchetState();

    if (data.DHs) {
      state.DHs = {
        privateKey: new Uint8Array(Buffer.from(data.DHs.privateKey, 'base64')),
        publicKey: new Uint8Array(Buffer.from(data.DHs.publicKey, 'base64'))
      };
    }

    state.DHr = data.DHr ? new Uint8Array(Buffer.from(data.DHr, 'base64')) : null;
    state.RK = data.RK ? new Uint8Array(Buffer.from(data.RK, 'base64')) : null;
    state.CKs = data.CKs ? new Uint8Array(Buffer.from(data.CKs, 'base64')) : null;
    state.CKr = data.CKr ? new Uint8Array(Buffer.from(data.CKr, 'base64')) : null;
    state.Ns = data.Ns;
    state.Nr = data.Nr;
    state.PN = data.PN;
    state.MKSKIPPED = new Map(
      data.MKSKIPPED.map(([k, v]) => [k, new Uint8Array(Buffer.from(v, 'base64'))])
    );

    return state;
  }
}

/**
 * Double Ratchet Session
 */
export class DoubleRatchetSession {
  constructor(state = new DoubleRatchetState()) {
    this.state = state;
  }

  /**
   * Initialize session as the initiator (Alice)
   * @param {Uint8Array} sharedSecret - The shared secret from X3DH
   * @param {Uint8Array} remotePublicKey - Bob's signed pre-key public key
   */
  initAsInitiator(sharedSecret, remotePublicKey) {
    this.state.DHs = generateKeyPair();
    this.state.DHr = remotePublicKey;

    const dhResult = dh(this.state.DHs.privateKey, this.state.DHr);
    const { rootKey, chainKey } = kdfRK(sharedSecret, dhResult);

    this.state.RK = rootKey;
    this.state.CKs = chainKey;
    this.state.CKr = null;
    this.state.Ns = 0;
    this.state.Nr = 0;
    this.state.PN = 0;
  }

  /**
   * Initialize session as the responder (Bob)
   * @param {Uint8Array} sharedSecret - The shared secret from X3DH
   * @param {Object} ourKeyPair - Our signed pre-key pair
   */
  initAsResponder(sharedSecret, ourKeyPair) {
    this.state.DHs = ourKeyPair;
    this.state.DHr = null;
    this.state.RK = sharedSecret;
    this.state.CKs = null;
    this.state.CKr = null;
    this.state.Ns = 0;
    this.state.Nr = 0;
    this.state.PN = 0;
  }

  /**
   * Encrypt a message
   * @param {Uint8Array} plaintext - Message to encrypt
   * @param {Uint8Array} associatedData - Associated data for AEAD
   * @returns {{header: MessageHeader, ciphertext: Object}}
   */
  encrypt(plaintext, associatedData = new Uint8Array()) {
    // Derive message key from sending chain
    const { chainKey, messageKey } = kdfCK(this.state.CKs);
    this.state.CKs = chainKey;

    // Create header
    const header = new MessageHeader(
      this.state.DHs.publicKey,
      this.state.PN,
      this.state.Ns
    );

    this.state.Ns++;

    // Encrypt message
    const { nonce, ciphertext } = encrypt(messageKey, plaintext, associatedData);

    return {
      header,
      nonce: Buffer.from(nonce).toString('base64'),
      ciphertext: Buffer.from(ciphertext).toString('base64')
    };
  }

  /**
   * Decrypt a message
   * @param {MessageHeader} header - Message header
   * @param {string} nonceB64 - Base64 encoded nonce
   * @param {string} ciphertextB64 - Base64 encoded ciphertext
   * @param {Uint8Array} associatedData - Associated data for AEAD
   * @returns {Uint8Array} - Decrypted plaintext
   */
  decrypt(header, nonceB64, ciphertextB64, associatedData = new Uint8Array()) {
    const nonce = new Uint8Array(Buffer.from(nonceB64, 'base64'));
    const ciphertext = new Uint8Array(Buffer.from(ciphertextB64, 'base64'));

    // Try to find skipped message key
    const skipKey = `${Buffer.from(header.dhPublicKey).toString('base64')}:${header.messageNumber}`;
    if (this.state.MKSKIPPED.has(skipKey)) {
      const messageKey = this.state.MKSKIPPED.get(skipKey);
      this.state.MKSKIPPED.delete(skipKey);
      return decrypt(messageKey, nonce, ciphertext, associatedData);
    }

    // Check if we need to perform DH ratchet
    if (!this.state.DHr || !this.arraysEqual(header.dhPublicKey, this.state.DHr)) {
      // Skip any missed messages in current chain
      this.skipMessageKeys(header.previousCounter);
      // Perform DH ratchet step
      this.dhRatchet(header.dhPublicKey);
    }

    // Skip any missed messages
    this.skipMessageKeys(header.messageNumber);

    // Derive message key
    const { chainKey, messageKey } = kdfCK(this.state.CKr);
    this.state.CKr = chainKey;
    this.state.Nr++;

    return decrypt(messageKey, nonce, ciphertext, associatedData);
  }

  /**
   * Perform DH ratchet step
   */
  dhRatchet(theirPublicKey) {
    this.state.PN = this.state.Ns;
    this.state.Ns = 0;
    this.state.Nr = 0;
    this.state.DHr = theirPublicKey;

    // Derive new receiving chain
    const dhResult1 = dh(this.state.DHs.privateKey, this.state.DHr);
    const { rootKey: rk1, chainKey: ck1 } = kdfRK(this.state.RK, dhResult1);
    this.state.RK = rk1;
    this.state.CKr = ck1;

    // Generate new DH key pair
    this.state.DHs = generateKeyPair();

    // Derive new sending chain
    const dhResult2 = dh(this.state.DHs.privateKey, this.state.DHr);
    const { rootKey: rk2, chainKey: ck2 } = kdfRK(this.state.RK, dhResult2);
    this.state.RK = rk2;
    this.state.CKs = ck2;
  }

  /**
   * Skip and store message keys for out-of-order delivery
   */
  skipMessageKeys(until) {
    if (this.state.Nr + MAX_SKIP < until) {
      throw new Error('Too many skipped messages');
    }

    if (this.state.CKr) {
      while (this.state.Nr < until) {
        const { chainKey, messageKey } = kdfCK(this.state.CKr);
        this.state.CKr = chainKey;

        const skipKey = `${Buffer.from(this.state.DHr).toString('base64')}:${this.state.Nr}`;
        this.state.MKSKIPPED.set(skipKey, messageKey);

        this.state.Nr++;
      }
    }
  }

  /**
   * Check if two arrays are equal
   */
  arraysEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /**
   * Serialize session for storage
   */
  serialize() {
    return this.state.serialize();
  }

  /**
   * Deserialize session from storage
   */
  static deserialize(data) {
    return new DoubleRatchetSession(DoubleRatchetState.deserialize(data));
  }
}

/**
 * Session Manager
 * Manages Double Ratchet sessions for multiple contacts
 */
export class SessionManager {
  constructor(db = null) {
    this.db = db;
    this.sessions = new Map(); // remoteAddress -> DoubleRatchetSession
  }

  /**
   * Get or create a session for a remote address
   */
  async getSession(remoteAddress) {
    if (this.sessions.has(remoteAddress)) {
      return this.sessions.get(remoteAddress);
    }

    // Try to load from database
    if (this.db) {
      try {
        const data = await this.db.get(`session:${remoteAddress}`);
        const session = DoubleRatchetSession.deserialize(data);
        this.sessions.set(remoteAddress, session);
        return session;
      } catch (e) {
        // No existing session
      }
    }

    return null;
  }

  /**
   * Create a new session as initiator
   */
  async createSessionAsInitiator(remoteAddress, sharedSecret, remotePublicKey) {
    const session = new DoubleRatchetSession();
    session.initAsInitiator(sharedSecret, remotePublicKey);
    this.sessions.set(remoteAddress, session);
    await this.saveSession(remoteAddress);
    return session;
  }

  /**
   * Create a new session as responder
   */
  async createSessionAsResponder(remoteAddress, sharedSecret, ourKeyPair) {
    const session = new DoubleRatchetSession();
    session.initAsResponder(sharedSecret, ourKeyPair);
    this.sessions.set(remoteAddress, session);
    await this.saveSession(remoteAddress);
    return session;
  }

  /**
   * Save a session to database
   */
  async saveSession(remoteAddress) {
    if (!this.db) return;

    const session = this.sessions.get(remoteAddress);
    if (session) {
      await this.db.put(`session:${remoteAddress}`, session.serialize());
    }
  }

  /**
   * Delete a session
   */
  async deleteSession(remoteAddress) {
    this.sessions.delete(remoteAddress);
    if (this.db) {
      try {
        await this.db.del(`session:${remoteAddress}`);
      } catch (e) {
        // Session might not exist
      }
    }
  }

  /**
   * List all sessions
   */
  listSessions() {
    return Array.from(this.sessions.keys());
  }
}

export default DoubleRatchetSession;
