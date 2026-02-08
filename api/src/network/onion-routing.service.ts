import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { x25519 } from '@noble/curves/ed25519';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import { randomBytes } from 'crypto';

const INFO_ONION = new TextEncoder().encode('dmail-onion-v1');
const DEFAULT_HOP_COUNT = 3;

export interface OnionLayerData {
  nextHop: string;
  payload: EncryptedLayerData;
  isExit: boolean;
}

export interface EncryptedLayerData {
  ephemeralPublicKey: string;
  nonce: string;
  ciphertext: string;
}

export interface OnionPacketData {
  version: number;
  encryptedPayload: EncryptedLayerData;
  circuitId: string;
  timestamp: number;
}

export interface RelayInfo {
  peerId: string;
  publicKey: Uint8Array;
  multiaddr: string;
  score: number;
}

export interface RouteResult {
  packet: OnionPacketData;
  entryNode: RelayInfo;
  route: string[];
}

export interface ProcessResult {
  type: 'forward' | 'exit' | 'error';
  nextHop?: string;
  nextHopPeerId?: string;
  packet?: OnionPacketData;
  isExit?: boolean;
  destination?: string;
  message?: Uint8Array;
  error?: string;
}

export interface CircuitInfo {
  prevHop: string;
  timestamp: number;
}

@Injectable()
export class OnionRoutingService implements OnModuleDestroy {
  private hopCount: number;
  private knownRelays: Map<string, RelayInfo> = new Map();
  private privateKey: Uint8Array | null = null;
  private peerId: string | null = null;
  private circuits: Map<string, CircuitInfo> = new Map();
  private cleanupInterval: NodeJS.Timeout;
  private sendFunction: ((multiaddr: string, packet: OnionPacketData) => Promise<void>) | null = null;

  constructor() {
    this.hopCount = DEFAULT_HOP_COUNT;
    this.cleanupInterval = setInterval(() => this.cleanupCircuits(), 60000);
  }

  onModuleDestroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  /**
   * Initialize the router with node keys
   */
  initialize(privateKey: Uint8Array, peerId: string): void {
    this.privateKey = privateKey;
    this.peerId = peerId;
  }

  /**
   * Set the send function for routing packets
   */
  setSendFunction(fn: (multiaddr: string, packet: OnionPacketData) => Promise<void>): void {
    this.sendFunction = fn;
  }

  /**
   * Register a known relay node
   */
  registerRelay(peerId: string, publicKey: Uint8Array | string, multiaddr: string, score = 100): void {
    this.knownRelays.set(peerId, {
      peerId,
      publicKey: typeof publicKey === 'string'
        ? new Uint8Array(Buffer.from(publicKey, 'base64'))
        : publicKey,
      multiaddr,
      score,
    });
  }

  /**
   * Select relay nodes for a route
   */
  selectRelays(count = DEFAULT_HOP_COUNT, excludePeers: string[] = []): RelayInfo[] {
    const available = Array.from(this.knownRelays.values())
      .filter((r) => !excludePeers.includes(r.peerId))
      .sort((a, b) => b.score - a.score);

    if (available.length < count) {
      throw new Error(`Not enough relays available: need ${count}, have ${available.length}`);
    }

    const selected: RelayInfo[] = [];
    const remaining = [...available];

    for (let i = 0; i < count; i++) {
      const totalScore = remaining.reduce((sum, r) => sum + r.score, 0);
      let random = Math.random() * totalScore;

      for (let j = 0; j < remaining.length; j++) {
        random -= remaining[j].score;
        if (random <= 0) {
          selected.push(remaining[j]);
          remaining.splice(j, 1);
          break;
        }
      }
    }

    return selected;
  }

  /**
   * Encrypt a layer with X25519 + ChaCha20-Poly1305
   */
  private encryptLayer(plaintext: Uint8Array, recipientPublicKey: Uint8Array): EncryptedLayerData {
    const ephemeralPrivate = randomBytes(32);
    const ephemeralPublic = x25519.getPublicKey(ephemeralPrivate);

    const sharedSecret = x25519.getSharedSecret(ephemeralPrivate, recipientPublicKey);
    const encryptionKey = hkdf(sha256, sharedSecret, undefined, INFO_ONION, 32);

    const nonce = randomBytes(12);
    const cipher = chacha20poly1305(encryptionKey, nonce);
    const ciphertext = cipher.encrypt(plaintext);

    return {
      ephemeralPublicKey: Buffer.from(ephemeralPublic).toString('base64'),
      nonce: Buffer.from(nonce).toString('base64'),
      ciphertext: Buffer.from(ciphertext).toString('base64'),
    };
  }

  /**
   * Decrypt a layer with X25519 + ChaCha20-Poly1305
   */
  private decryptLayer(encrypted: EncryptedLayerData, recipientPrivateKey: Uint8Array): Uint8Array {
    const ephemeralPublic = new Uint8Array(Buffer.from(encrypted.ephemeralPublicKey, 'base64'));
    const nonce = new Uint8Array(Buffer.from(encrypted.nonce, 'base64'));
    const ciphertext = new Uint8Array(Buffer.from(encrypted.ciphertext, 'base64'));

    const sharedSecret = x25519.getSharedSecret(recipientPrivateKey, ephemeralPublic);
    const encryptionKey = hkdf(sha256, sharedSecret, undefined, INFO_ONION, 32);

    const cipher = chacha20poly1305(encryptionKey, nonce);
    return cipher.decrypt(ciphertext);
  }

  /**
   * Build an onion route to a destination
   */
  buildRoute(
    message: Uint8Array,
    destinationAddress: string,
    destinationPublicKey: Uint8Array,
    excludePeers: string[] = [],
  ): RouteResult {
    const relays = this.selectRelays(this.hopCount, excludePeers);

    // Build layers from inside out
    let currentPayload = {
      type: 'final',
      destination: destinationAddress,
      message: Buffer.from(message).toString('base64'),
    };

    // Encrypt for final destination
    let encrypted = this.encryptLayer(
      new TextEncoder().encode(JSON.stringify(currentPayload)),
      destinationPublicKey,
    );

    // Build intermediate layers (from exit node to entry node)
    for (let i = relays.length - 1; i >= 0; i--) {
      const relay = relays[i];
      const isExit = i === relays.length - 1;

      const layer = {
        type: 'relay',
        nextHop: isExit ? destinationAddress : relays[i + 1].multiaddr,
        nextHopPeerId: isExit ? null : relays[i + 1].peerId,
        isExit,
        payload: encrypted,
      };

      encrypted = this.encryptLayer(
        new TextEncoder().encode(JSON.stringify(layer)),
        relay.publicKey,
      );
    }

    const packet: OnionPacketData = {
      version: 1,
      encryptedPayload: encrypted,
      circuitId: randomBytes(16).toString('hex'),
      timestamp: Date.now(),
    };

    return {
      packet,
      entryNode: relays[0],
      route: relays.map((r) => r.peerId),
    };
  }

  /**
   * Process an incoming onion packet
   */
  processPacket(packet: OnionPacketData, fromPeer: string): ProcessResult {
    if (!this.privateKey) {
      return { type: 'error', error: 'Router not initialized' };
    }

    try {
      const decrypted = this.decryptLayer(packet.encryptedPayload, this.privateKey);
      const layer = JSON.parse(new TextDecoder().decode(decrypted));

      // Track circuit for potential replies
      this.circuits.set(packet.circuitId, {
        prevHop: fromPeer,
        timestamp: Date.now(),
      });

      if (layer.type === 'final') {
        return {
          type: 'exit',
          destination: layer.destination,
          message: new Uint8Array(Buffer.from(layer.message, 'base64')),
        };
      } else if (layer.type === 'relay') {
        const nextPacket: OnionPacketData = {
          version: packet.version,
          encryptedPayload: layer.payload,
          circuitId: packet.circuitId,
          timestamp: packet.timestamp,
        };

        return {
          type: 'forward',
          nextHop: layer.nextHop,
          nextHopPeerId: layer.nextHopPeerId,
          packet: nextPacket,
          isExit: layer.isExit,
        };
      }

      return { type: 'error', error: 'Unknown layer type' };
    } catch (e) {
      return { type: 'error', error: (e as Error).message };
    }
  }

  /**
   * Clean up old circuit entries
   */
  private cleanupCircuits(): void {
    const now = Date.now();
    const maxAge = 10 * 60 * 1000;

    for (const [circuitId, info] of this.circuits.entries()) {
      if (now - info.timestamp > maxAge) {
        this.circuits.delete(circuitId);
      }
    }
  }

  /**
   * Send an anonymous message
   */
  async sendAnonymous(
    message: Uint8Array | string,
    destinationAddress: string,
    destinationPublicKey: Uint8Array | string,
  ): Promise<{ circuitId: string; hops: number; entryNode: string }> {
    const messageBytes = typeof message === 'string'
      ? new TextEncoder().encode(message)
      : message;

    const destPubKey = typeof destinationPublicKey === 'string'
      ? new Uint8Array(Buffer.from(destinationPublicKey, 'base64'))
      : destinationPublicKey;

    const { packet, entryNode, route } = this.buildRoute(
      messageBytes,
      destinationAddress,
      destPubKey,
    );

    if (this.sendFunction) {
      await this.sendFunction(entryNode.multiaddr, packet);
    }

    return {
      circuitId: packet.circuitId,
      hops: route.length,
      entryNode: entryNode.peerId,
    };
  }

  /**
   * Get number of available relays
   */
  getRelayCount(): number {
    return this.knownRelays.size;
  }

  /**
   * Check if we have enough relays for anonymous routing
   */
  canSendAnonymous(): boolean {
    return this.knownRelays.size >= this.hopCount;
  }

  /**
   * Update relay score
   */
  updateRelayScore(peerId: string, scoreDelta: number): void {
    const relay = this.knownRelays.get(peerId);
    if (relay) {
      relay.score = Math.max(0, Math.min(100, relay.score + scoreDelta));
    }
  }
}
