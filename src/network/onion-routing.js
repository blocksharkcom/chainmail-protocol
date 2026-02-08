/**
 * Onion Routing for dMail
 *
 * Provides anonymous message routing through multiple relay nodes.
 * Inspired by Tor's onion routing protocol.
 *
 * Key features:
 * - Multi-layer encryption (like an onion)
 * - Each relay only knows the previous and next hop
 * - Final destination is hidden from intermediate nodes
 * - Sender anonymity through multiple hops
 *
 * Route structure:
 * Sender -> Relay1 -> Relay2 -> Relay3 -> Recipient
 *
 * Each layer is encrypted with the corresponding relay's public key.
 */

import { x25519 } from '@noble/curves/ed25519';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import { randomBytes } from 'crypto';

const INFO_ONION = new TextEncoder().encode('dmail-onion-v1');
const DEFAULT_HOP_COUNT = 3;

/**
 * Onion Layer - represents one hop in the route
 */
export class OnionLayer {
  constructor(options = {}) {
    this.nextHop = options.nextHop; // Next node's address/multiaddr
    this.nextHopPublicKey = options.nextHopPublicKey; // Next node's public key
    this.payload = options.payload; // Encrypted inner layer or final message
    this.isExit = options.isExit || false; // Is this the exit node?
  }

  /**
   * Serialize for transmission
   */
  serialize() {
    return {
      nextHop: this.nextHop,
      payload: this.payload,
      isExit: this.isExit
    };
  }

  /**
   * Deserialize from transmission
   */
  static deserialize(data) {
    return new OnionLayer({
      nextHop: data.nextHop,
      payload: data.payload,
      isExit: data.isExit
    });
  }
}

/**
 * Encrypt a layer with X25519 + ChaCha20-Poly1305
 */
function encryptLayer(plaintext, recipientPublicKey) {
  // Generate ephemeral key pair
  const ephemeralPrivate = randomBytes(32);
  const ephemeralPublic = x25519.getPublicKey(ephemeralPrivate);

  // Derive shared secret
  const sharedSecret = x25519.getSharedSecret(ephemeralPrivate, recipientPublicKey);

  // Derive encryption key
  const encryptionKey = hkdf(sha256, sharedSecret, undefined, INFO_ONION, 32);

  // Generate nonce
  const nonce = randomBytes(12);

  // Encrypt
  const cipher = chacha20poly1305(encryptionKey, nonce);
  const ciphertext = cipher.encrypt(plaintext);

  return {
    ephemeralPublicKey: Buffer.from(ephemeralPublic).toString('base64'),
    nonce: Buffer.from(nonce).toString('base64'),
    ciphertext: Buffer.from(ciphertext).toString('base64')
  };
}

/**
 * Decrypt a layer with X25519 + ChaCha20-Poly1305
 */
function decryptLayer(encrypted, recipientPrivateKey) {
  const ephemeralPublic = new Uint8Array(Buffer.from(encrypted.ephemeralPublicKey, 'base64'));
  const nonce = new Uint8Array(Buffer.from(encrypted.nonce, 'base64'));
  const ciphertext = new Uint8Array(Buffer.from(encrypted.ciphertext, 'base64'));

  // Derive shared secret
  const sharedSecret = x25519.getSharedSecret(recipientPrivateKey, ephemeralPublic);

  // Derive encryption key
  const encryptionKey = hkdf(sha256, sharedSecret, undefined, INFO_ONION, 32);

  // Decrypt
  const cipher = chacha20poly1305(encryptionKey, nonce);
  return cipher.decrypt(ciphertext);
}

/**
 * Onion Packet - the complete onion-encrypted message
 */
export class OnionPacket {
  constructor(options = {}) {
    this.version = options.version || 1;
    this.encryptedPayload = options.encryptedPayload; // Outermost encrypted layer
    this.circuitId = options.circuitId || randomBytes(16).toString('hex');
    this.timestamp = options.timestamp || Date.now();
  }

  /**
   * Serialize for transmission
   */
  serialize() {
    return {
      version: this.version,
      encryptedPayload: this.encryptedPayload,
      circuitId: this.circuitId,
      timestamp: this.timestamp
    };
  }

  /**
   * Deserialize from transmission
   */
  static deserialize(data) {
    return new OnionPacket({
      version: data.version,
      encryptedPayload: data.encryptedPayload,
      circuitId: data.circuitId,
      timestamp: data.timestamp
    });
  }
}

/**
 * Route Builder - builds onion routes through the network
 */
export class OnionRouteBuilder {
  constructor(options = {}) {
    this.hopCount = options.hopCount || DEFAULT_HOP_COUNT;
    this.knownRelays = new Map(); // peerId -> {publicKey, multiaddr, score}
  }

  /**
   * Register a known relay node
   */
  registerRelay(peerId, publicKey, multiaddr, score = 100) {
    this.knownRelays.set(peerId, {
      peerId,
      publicKey: typeof publicKey === 'string'
        ? new Uint8Array(Buffer.from(publicKey, 'base64'))
        : publicKey,
      multiaddr,
      score
    });
  }

  /**
   * Select relay nodes for a route
   * Selects diverse nodes with good scores
   */
  selectRelays(count = DEFAULT_HOP_COUNT, excludePeers = []) {
    const available = Array.from(this.knownRelays.values())
      .filter(r => !excludePeers.includes(r.peerId))
      .sort((a, b) => b.score - a.score);

    if (available.length < count) {
      throw new Error(`Not enough relays available: need ${count}, have ${available.length}`);
    }

    // Select with weighted randomness
    const selected = [];
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
   * Build an onion route to a destination
   * @param {Uint8Array} message - The message to send
   * @param {string} destinationAddress - The recipient's dMail address
   * @param {Uint8Array} destinationPublicKey - The recipient's encryption public key
   * @param {string[]} excludePeers - Peers to exclude from route
   */
  buildRoute(message, destinationAddress, destinationPublicKey, excludePeers = []) {
    // Select relay nodes
    const relays = this.selectRelays(this.hopCount, excludePeers);

    // Build layers from inside out
    // Innermost layer contains the actual message
    let currentPayload = {
      type: 'final',
      destination: destinationAddress,
      message: Buffer.from(message).toString('base64')
    };

    // Encrypt for final destination
    let encrypted = encryptLayer(
      new TextEncoder().encode(JSON.stringify(currentPayload)),
      destinationPublicKey
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
        payload: encrypted
      };

      encrypted = encryptLayer(
        new TextEncoder().encode(JSON.stringify(layer)),
        relay.publicKey
      );
    }

    // Create onion packet
    const packet = new OnionPacket({
      encryptedPayload: encrypted
    });

    return {
      packet,
      entryNode: relays[0],
      route: relays.map(r => r.peerId)
    };
  }
}

/**
 * Onion Router - handles onion routing at a relay node
 */
export class OnionRouter {
  constructor(options = {}) {
    this.privateKey = options.privateKey; // Node's X25519 private key
    this.peerId = options.peerId;

    // Circuit tracking for reply routing
    this.circuits = new Map(); // circuitId -> {prevHop, timestamp}

    // Clean up old circuits periodically
    this.cleanupInterval = setInterval(() => this.cleanupCircuits(), 60000);
  }

  /**
   * Process an incoming onion packet
   * @returns {{type: string, nextHop?: string, payload?: object, message?: Uint8Array}}
   */
  processPacket(packet, fromPeer) {
    try {
      // Decrypt our layer
      const decrypted = decryptLayer(packet.encryptedPayload, this.privateKey);
      const layer = JSON.parse(new TextDecoder().decode(decrypted));

      // Track circuit for potential replies
      this.circuits.set(packet.circuitId, {
        prevHop: fromPeer,
        timestamp: Date.now()
      });

      if (layer.type === 'final') {
        // This is the exit node - deliver to final destination
        return {
          type: 'exit',
          destination: layer.destination,
          message: new Uint8Array(Buffer.from(layer.message, 'base64'))
        };
      } else if (layer.type === 'relay') {
        // Forward to next hop
        const nextPacket = new OnionPacket({
          encryptedPayload: layer.payload,
          circuitId: packet.circuitId,
          timestamp: packet.timestamp
        });

        return {
          type: 'forward',
          nextHop: layer.nextHop,
          nextHopPeerId: layer.nextHopPeerId,
          packet: nextPacket,
          isExit: layer.isExit
        };
      }

      throw new Error('Unknown layer type');
    } catch (e) {
      console.error('Failed to process onion packet:', e.message);
      return { type: 'error', error: e.message };
    }
  }

  /**
   * Clean up old circuit entries
   */
  cleanupCircuits() {
    const now = Date.now();
    const maxAge = 10 * 60 * 1000; // 10 minutes

    for (const [circuitId, info] of this.circuits.entries()) {
      if (now - info.timestamp > maxAge) {
        this.circuits.delete(circuitId);
      }
    }
  }

  /**
   * Stop the router
   */
  stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

/**
 * Anonymous Message Sender
 * High-level API for sending anonymous messages
 */
export class AnonymousMessageSender {
  constructor(options = {}) {
    this.routeBuilder = new OnionRouteBuilder(options);
    this.sendFunction = options.sendFunction; // Function to send packet to entry node
    this.hopCount = options.hopCount || DEFAULT_HOP_COUNT;
  }

  /**
   * Register known relays
   */
  addRelay(peerId, publicKey, multiaddr, score = 100) {
    this.routeBuilder.registerRelay(peerId, publicKey, multiaddr, score);
  }

  /**
   * Send an anonymous message
   * @param {Uint8Array|string} message - Message content
   * @param {string} destinationAddress - Recipient's dMail address
   * @param {Uint8Array|string} destinationPublicKey - Recipient's encryption key
   */
  async sendAnonymous(message, destinationAddress, destinationPublicKey) {
    const messageBytes = typeof message === 'string'
      ? new TextEncoder().encode(message)
      : message;

    const destPubKey = typeof destinationPublicKey === 'string'
      ? new Uint8Array(Buffer.from(destinationPublicKey, 'base64'))
      : destinationPublicKey;

    // Build onion route
    const { packet, entryNode, route } = this.routeBuilder.buildRoute(
      messageBytes,
      destinationAddress,
      destPubKey
    );

    console.log(`Sending anonymous message via ${route.length} hops`);

    // Send to entry node
    if (this.sendFunction) {
      await this.sendFunction(entryNode.multiaddr, packet.serialize());
    }

    return {
      circuitId: packet.circuitId,
      hops: route.length,
      entryNode: entryNode.peerId
    };
  }

  /**
   * Get number of available relays
   */
  getRelayCount() {
    return this.routeBuilder.knownRelays.size;
  }

  /**
   * Check if we have enough relays for anonymous routing
   */
  canSendAnonymous() {
    return this.routeBuilder.knownRelays.size >= this.hopCount;
  }
}

export default {
  OnionPacket,
  OnionLayer,
  OnionRouteBuilder,
  OnionRouter,
  AnonymousMessageSender
};
