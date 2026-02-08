import { Injectable } from '@nestjs/common';
import { ed25519 } from '@noble/curves/ed25519';
import { x25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bech32 } from '@scure/base';
import { randomBytes } from 'crypto';
import {
  Identity,
  SerializedIdentity,
  PublicIdentity,
} from './interfaces/identity.interface';

const ADDRESS_PREFIX = 'dm';

@Injectable()
export class IdentityService {
  /**
   * Generate a new identity with Ed25519 signing keys and X25519 encryption keys
   */
  generate(): Identity {
    // Generate Ed25519 signing key pair
    const privateKey = ed25519.utils.randomPrivateKey();
    const publicKey = ed25519.getPublicKey(privateKey);

    // Generate X25519 encryption key pair
    const encryptionPrivateKey = randomBytes(32);
    const encryptionPublicKey = x25519.getPublicKey(encryptionPrivateKey);

    // Generate routing token for sealed envelopes
    const routingToken = randomBytes(16).toString('hex');

    // Derive address from public key
    const address = this.deriveAddress(publicKey);

    return {
      address,
      publicKey,
      privateKey,
      encryptionPublicKey,
      encryptionPrivateKey,
      routingToken,
      createdAt: Date.now(),
    };
  }

  /**
   * Derive a dMail address from a public key
   * Format: dm1<bech32 encoded hash of public key>
   */
  deriveAddress(publicKey: Uint8Array): string {
    const hash = sha256(publicKey);
    const words = bech32.toWords(hash.slice(0, 20));
    return bech32.encode(ADDRESS_PREFIX, words);
  }

  /**
   * Sign a message with the identity's private key
   */
  sign(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
    return ed25519.sign(message, privateKey);
  }

  /**
   * Verify a signature
   */
  verify(
    message: Uint8Array,
    signature: Uint8Array,
    publicKey: Uint8Array,
  ): boolean {
    try {
      return ed25519.verify(signature, message, publicKey);
    } catch {
      return false;
    }
  }

  /**
   * Serialize an identity for storage
   */
  serialize(identity: Identity): SerializedIdentity {
    return {
      address: identity.address,
      publicKey: Buffer.from(identity.publicKey).toString('base64'),
      privateKey: Buffer.from(identity.privateKey).toString('base64'),
      encryptionPublicKey: Buffer.from(identity.encryptionPublicKey).toString(
        'base64',
      ),
      encryptionPrivateKey: Buffer.from(identity.encryptionPrivateKey).toString(
        'base64',
      ),
      routingToken: identity.routingToken,
      createdAt: identity.createdAt,
    };
  }

  /**
   * Deserialize an identity from storage
   */
  deserialize(data: SerializedIdentity): Identity {
    return {
      address: data.address,
      publicKey: new Uint8Array(Buffer.from(data.publicKey, 'base64')),
      privateKey: new Uint8Array(Buffer.from(data.privateKey, 'base64')),
      encryptionPublicKey: new Uint8Array(
        Buffer.from(data.encryptionPublicKey, 'base64'),
      ),
      encryptionPrivateKey: new Uint8Array(
        Buffer.from(data.encryptionPrivateKey, 'base64'),
      ),
      routingToken: data.routingToken,
      createdAt: data.createdAt,
    };
  }

  /**
   * Get public identity info (safe to share)
   */
  getPublicIdentity(identity: Identity): PublicIdentity {
    return {
      address: identity.address,
      publicKey: Buffer.from(identity.publicKey).toString('base64'),
      encryptionPublicKey: Buffer.from(identity.encryptionPublicKey).toString(
        'base64',
      ),
    };
  }

  /**
   * Validate a dMail address format
   */
  isValidAddress(address: string): boolean {
    try {
      const { prefix } = bech32.decode(address as `${string}1${string}`);
      return prefix === ADDRESS_PREFIX;
    } catch {
      return false;
    }
  }
}
