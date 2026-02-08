import { Injectable } from '@nestjs/common';
import { x25519 } from '@noble/curves/ed25519';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import { randomBytes } from 'crypto';

const INFO_ROOT_KEY = new TextEncoder().encode('dmail-root-key');
const INFO_CHAIN_KEY = new TextEncoder().encode('dmail-chain-key');
const INFO_MESSAGE_KEY = new TextEncoder().encode('dmail-message-key');
const MAX_SKIP = 100;

interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface MessageHeader {
  dhPublicKey: string;
  previousCounter: number;
  messageNumber: number;
}

export interface EncryptedRatchetMessage {
  header: MessageHeader;
  nonce: string;
  ciphertext: string;
}

export interface RatchetState {
  DHs: KeyPair | null;
  DHr: Uint8Array | null;
  RK: Uint8Array | null;
  CKs: Uint8Array | null;
  CKr: Uint8Array | null;
  Ns: number;
  Nr: number;
  PN: number;
  MKSKIPPED: Map<string, Uint8Array>;
}

export interface SerializedRatchetState {
  DHs: { privateKey: string; publicKey: string } | null;
  DHr: string | null;
  RK: string | null;
  CKs: string | null;
  CKr: string | null;
  Ns: number;
  Nr: number;
  PN: number;
  MKSKIPPED: [string, string][];
}

@Injectable()
export class DoubleRatchetService {
  /**
   * Generate a new key pair
   */
  private generateKeyPair(): KeyPair {
    const privateKey = randomBytes(32);
    const publicKey = x25519.getPublicKey(privateKey);
    return { privateKey, publicKey };
  }

  /**
   * Perform Diffie-Hellman key exchange
   */
  private dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
    return x25519.getSharedSecret(privateKey, publicKey);
  }

  /**
   * Root key KDF
   */
  private kdfRK(
    rootKey: Uint8Array,
    dhOutput: Uint8Array,
  ): { rootKey: Uint8Array; chainKey: Uint8Array } {
    const okm = hkdf(sha256, dhOutput, rootKey, INFO_ROOT_KEY, 64);
    return {
      rootKey: okm.slice(0, 32),
      chainKey: okm.slice(32, 64),
    };
  }

  /**
   * Chain key KDF
   */
  private kdfCK(
    chainKey: Uint8Array,
  ): { chainKey: Uint8Array; messageKey: Uint8Array } {
    const nextChainKey = hkdf(sha256, chainKey, undefined, INFO_CHAIN_KEY, 32);
    const messageKey = hkdf(sha256, chainKey, undefined, INFO_MESSAGE_KEY, 32);
    return { chainKey: nextChainKey, messageKey };
  }

  /**
   * Create initial state
   */
  createState(): RatchetState {
    return {
      DHs: null,
      DHr: null,
      RK: null,
      CKs: null,
      CKr: null,
      Ns: 0,
      Nr: 0,
      PN: 0,
      MKSKIPPED: new Map(),
    };
  }

  /**
   * Initialize as initiator (Alice)
   */
  initAsInitiator(
    state: RatchetState,
    sharedSecret: Uint8Array,
    remotePublicKey: Uint8Array,
  ): void {
    state.DHs = this.generateKeyPair();
    state.DHr = remotePublicKey;

    const dhResult = this.dh(state.DHs.privateKey, state.DHr);
    const { rootKey, chainKey } = this.kdfRK(sharedSecret, dhResult);

    state.RK = rootKey;
    state.CKs = chainKey;
    state.CKr = null;
    state.Ns = 0;
    state.Nr = 0;
    state.PN = 0;
  }

  /**
   * Initialize as responder (Bob)
   */
  initAsResponder(
    state: RatchetState,
    sharedSecret: Uint8Array,
    ourKeyPair: KeyPair,
  ): void {
    state.DHs = ourKeyPair;
    state.DHr = null;
    state.RK = sharedSecret;
    state.CKs = null;
    state.CKr = null;
    state.Ns = 0;
    state.Nr = 0;
    state.PN = 0;
  }

  /**
   * Encrypt a message
   */
  encrypt(state: RatchetState, plaintext: Uint8Array): EncryptedRatchetMessage {
    if (!state.CKs || !state.DHs) {
      throw new Error('Session not initialized for sending');
    }

    const { chainKey, messageKey } = this.kdfCK(state.CKs);
    state.CKs = chainKey;

    const header: MessageHeader = {
      dhPublicKey: Buffer.from(state.DHs.publicKey).toString('base64'),
      previousCounter: state.PN,
      messageNumber: state.Ns,
    };

    state.Ns++;

    const nonce = randomBytes(12);
    const cipher = chacha20poly1305(messageKey, nonce);
    const ciphertext = cipher.encrypt(plaintext);

    return {
      header,
      nonce: Buffer.from(nonce).toString('base64'),
      ciphertext: Buffer.from(ciphertext).toString('base64'),
    };
  }

  /**
   * Decrypt a message
   */
  decrypt(
    state: RatchetState,
    message: EncryptedRatchetMessage,
  ): Uint8Array {
    const headerPubKey = new Uint8Array(
      Buffer.from(message.header.dhPublicKey, 'base64'),
    );
    const nonce = new Uint8Array(Buffer.from(message.nonce, 'base64'));
    const ciphertext = new Uint8Array(Buffer.from(message.ciphertext, 'base64'));

    // Check for skipped message key
    const skipKey = `${message.header.dhPublicKey}:${message.header.messageNumber}`;
    if (state.MKSKIPPED.has(skipKey)) {
      const messageKey = state.MKSKIPPED.get(skipKey)!;
      state.MKSKIPPED.delete(skipKey);
      const cipher = chacha20poly1305(messageKey, nonce);
      return cipher.decrypt(ciphertext);
    }

    // Check if DH ratchet needed
    if (!state.DHr || !this.arraysEqual(headerPubKey, state.DHr)) {
      this.skipMessageKeys(state, message.header.previousCounter);
      this.dhRatchet(state, headerPubKey);
    }

    this.skipMessageKeys(state, message.header.messageNumber);

    if (!state.CKr) {
      throw new Error('No receiving chain key');
    }

    const { chainKey, messageKey } = this.kdfCK(state.CKr);
    state.CKr = chainKey;
    state.Nr++;

    const cipher = chacha20poly1305(messageKey, nonce);
    return cipher.decrypt(ciphertext);
  }

  /**
   * Perform DH ratchet step
   */
  private dhRatchet(state: RatchetState, theirPublicKey: Uint8Array): void {
    state.PN = state.Ns;
    state.Ns = 0;
    state.Nr = 0;
    state.DHr = theirPublicKey;

    if (!state.DHs || !state.RK) {
      throw new Error('Invalid state for DH ratchet');
    }

    const dhResult1 = this.dh(state.DHs.privateKey, state.DHr);
    const { rootKey: rk1, chainKey: ck1 } = this.kdfRK(state.RK, dhResult1);
    state.RK = rk1;
    state.CKr = ck1;

    state.DHs = this.generateKeyPair();

    const dhResult2 = this.dh(state.DHs.privateKey, state.DHr);
    const { rootKey: rk2, chainKey: ck2 } = this.kdfRK(state.RK, dhResult2);
    state.RK = rk2;
    state.CKs = ck2;
  }

  /**
   * Skip and store message keys
   */
  private skipMessageKeys(state: RatchetState, until: number): void {
    if (state.Nr + MAX_SKIP < until) {
      throw new Error('Too many skipped messages');
    }

    if (state.CKr && state.DHr) {
      while (state.Nr < until) {
        const { chainKey, messageKey } = this.kdfCK(state.CKr);
        state.CKr = chainKey;

        const skipKey = `${Buffer.from(state.DHr).toString('base64')}:${state.Nr}`;
        state.MKSKIPPED.set(skipKey, messageKey);

        state.Nr++;
      }
    }
  }

  /**
   * Check array equality
   */
  private arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /**
   * Serialize state for storage
   */
  serializeState(state: RatchetState): SerializedRatchetState {
    return {
      DHs: state.DHs
        ? {
            privateKey: Buffer.from(state.DHs.privateKey).toString('base64'),
            publicKey: Buffer.from(state.DHs.publicKey).toString('base64'),
          }
        : null,
      DHr: state.DHr ? Buffer.from(state.DHr).toString('base64') : null,
      RK: state.RK ? Buffer.from(state.RK).toString('base64') : null,
      CKs: state.CKs ? Buffer.from(state.CKs).toString('base64') : null,
      CKr: state.CKr ? Buffer.from(state.CKr).toString('base64') : null,
      Ns: state.Ns,
      Nr: state.Nr,
      PN: state.PN,
      MKSKIPPED: Array.from(state.MKSKIPPED.entries()).map(([k, v]) => [
        k,
        Buffer.from(v).toString('base64'),
      ]),
    };
  }

  /**
   * Deserialize state from storage
   */
  deserializeState(data: SerializedRatchetState): RatchetState {
    return {
      DHs: data.DHs
        ? {
            privateKey: new Uint8Array(Buffer.from(data.DHs.privateKey, 'base64')),
            publicKey: new Uint8Array(Buffer.from(data.DHs.publicKey, 'base64')),
          }
        : null,
      DHr: data.DHr ? new Uint8Array(Buffer.from(data.DHr, 'base64')) : null,
      RK: data.RK ? new Uint8Array(Buffer.from(data.RK, 'base64')) : null,
      CKs: data.CKs ? new Uint8Array(Buffer.from(data.CKs, 'base64')) : null,
      CKr: data.CKr ? new Uint8Array(Buffer.from(data.CKr, 'base64')) : null,
      Ns: data.Ns,
      Nr: data.Nr,
      PN: data.PN,
      MKSKIPPED: new Map(
        data.MKSKIPPED.map(([k, v]) => [k, new Uint8Array(Buffer.from(v, 'base64'))]),
      ),
    };
  }
}
