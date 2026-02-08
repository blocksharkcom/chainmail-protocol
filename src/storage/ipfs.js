/**
 * IPFS Integration for dMail
 *
 * SECURITY: All content is encrypted BEFORE upload to IPFS.
 * IPFS is public - anyone can retrieve content by CID.
 * By encrypting first, only the intended recipient can decrypt.
 *
 * Provides decentralized storage for:
 * - Large message bodies (encrypted)
 * - Attachments (encrypted)
 * - Full encrypted messages (with CID anchored on-chain)
 */

import { sha256 } from '@noble/hashes/sha256';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { base58btc } from 'multiformats/bases/base58';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { randomBytes } from 'crypto';

// IPFS gateway endpoints
const IPFS_GATEWAYS = [
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
  'https://gateway.pinata.cloud/ipfs/'
];

// Pinning services (require API keys)
const PINNING_SERVICES = {
  pinata: {
    endpoint: 'https://api.pinata.cloud/pinning/pinFileToIPFS',
    name: 'Pinata'
  },
  web3storage: {
    endpoint: 'https://api.web3.storage/upload',
    name: 'Web3.Storage'
  },
  infura: {
    endpoint: 'https://ipfs.infura.io:5001/api/v0/add',
    name: 'Infura'
  }
};

/**
 * IPFS Storage Client
 */
export class IPFSStorage {
  constructor(options = {}) {
    this.gateway = options.gateway || IPFS_GATEWAYS[0];
    this.localNode = options.localNode || null; // e.g., 'http://127.0.0.1:5001'
    this.pinataApiKey = options.pinataApiKey || null;
    this.pinataSecretKey = options.pinataSecretKey || null;
    this.web3StorageToken = options.web3StorageToken || null;
  }

  /**
   * Upload content to IPFS
   */
  async upload(content, options = {}) {
    const data = typeof content === 'string'
      ? new TextEncoder().encode(content)
      : content;

    // If we have a local node, use it
    if (this.localNode) {
      return this.uploadToLocalNode(data, options);
    }

    // Otherwise, try pinning services
    if (this.pinataApiKey) {
      return this.uploadToPinata(data, options);
    }

    if (this.web3StorageToken) {
      return this.uploadToWeb3Storage(data, options);
    }

    // Fallback: compute CID locally (content won't be available until pinned)
    const cid = await this.computeCID(data);
    console.warn('No IPFS upload service configured. CID computed locally but content not uploaded.');
    return { cid, uploaded: false };
  }

  /**
   * Upload to local IPFS node
   */
  async uploadToLocalNode(data, options = {}) {
    const formData = new FormData();
    formData.append('file', new Blob([data]), options.filename || 'file');

    const response = await fetch(`${this.localNode}/api/v0/add?pin=true`, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      throw new Error(`IPFS upload failed: ${response.statusText}`);
    }

    const result = await response.json();
    return {
      cid: result.Hash,
      size: result.Size,
      uploaded: true,
      pinned: true
    };
  }

  /**
   * Upload to Pinata
   */
  async uploadToPinata(data, options = {}) {
    const formData = new FormData();
    formData.append('file', new Blob([data]), options.filename || 'file');

    if (options.name) {
      formData.append('pinataMetadata', JSON.stringify({ name: options.name }));
    }

    const response = await fetch(PINNING_SERVICES.pinata.endpoint, {
      method: 'POST',
      headers: {
        'pinata_api_key': this.pinataApiKey,
        'pinata_secret_api_key': this.pinataSecretKey
      },
      body: formData
    });

    if (!response.ok) {
      throw new Error(`Pinata upload failed: ${response.statusText}`);
    }

    const result = await response.json();
    return {
      cid: result.IpfsHash,
      size: result.PinSize,
      uploaded: true,
      pinned: true
    };
  }

  /**
   * Upload to Web3.Storage
   */
  async uploadToWeb3Storage(data, options = {}) {
    const response = await fetch(PINNING_SERVICES.web3storage.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.web3StorageToken}`,
        'Content-Type': 'application/octet-stream'
      },
      body: data
    });

    if (!response.ok) {
      throw new Error(`Web3.Storage upload failed: ${response.statusText}`);
    }

    const result = await response.json();
    return {
      cid: result.cid,
      uploaded: true,
      pinned: true
    };
  }

  /**
   * Download content from IPFS
   */
  async download(cid) {
    // Try gateways in order until one works
    for (const gateway of IPFS_GATEWAYS) {
      try {
        const response = await fetch(`${gateway}${cid}`, {
          signal: AbortSignal.timeout(30000)
        });

        if (response.ok) {
          return new Uint8Array(await response.arrayBuffer());
        }
      } catch (e) {
        // Try next gateway
        continue;
      }
    }

    // Try local node if available
    if (this.localNode) {
      const response = await fetch(`${this.localNode}/api/v0/cat?arg=${cid}`, {
        method: 'POST'
      });

      if (response.ok) {
        return new Uint8Array(await response.arrayBuffer());
      }
    }

    throw new Error(`Failed to download from IPFS: ${cid}`);
  }

  /**
   * Compute CID for content without uploading
   */
  async computeCID(content) {
    const data = typeof content === 'string'
      ? new TextEncoder().encode(content)
      : content;

    // Compute SHA-256 hash
    const hash = sha256(data);

    // Create a CID v1 with raw codec
    // Using dag-pb would be more accurate for IPFS but raw is simpler
    const cid = CID.create(1, raw.code, {
      code: 0x12, // sha2-256
      size: 32,
      digest: hash
    });

    return cid.toString(base58btc);
  }

  /**
   * Check if content is available on IPFS
   */
  async isAvailable(cid) {
    for (const gateway of IPFS_GATEWAYS) {
      try {
        const response = await fetch(`${gateway}${cid}`, {
          method: 'HEAD',
          signal: AbortSignal.timeout(10000)
        });

        if (response.ok) {
          return true;
        }
      } catch (e) {
        continue;
      }
    }
    return false;
  }
}

/**
 * Encrypted Attachment Manager
 *
 * ALWAYS encrypts attachments before IPFS upload.
 * Uses recipient's public key for encryption.
 */
export class AttachmentManager {
  constructor(ipfs) {
    this.ipfs = ipfs;
  }

  /**
   * Encrypt and upload an attachment
   * @param {Uint8Array} data - Raw attachment data
   * @param {string} filename - Original filename
   * @param {Uint8Array} recipientPublicKey - Recipient's X25519 public key
   * @param {string} mimeType - MIME type
   * @returns {Object} Attachment metadata with encryption info
   */
  async uploadAttachment(data, filename, recipientPublicKey, mimeType = 'application/octet-stream') {
    // Generate ephemeral keypair for this attachment
    const ephemeralPrivate = randomBytes(32);
    const ephemeralPublic = x25519.getPublicKey(ephemeralPrivate);

    // Compute shared secret
    const sharedSecret = x25519.getSharedSecret(ephemeralPrivate, recipientPublicKey);

    // Derive encryption key
    const encryptionKey = hkdf(
      sha256,
      sharedSecret,
      undefined,
      new TextEncoder().encode('dmail-attachment-v1'),
      32
    );

    // Generate nonce
    const nonce = randomBytes(12);

    // Encrypt the attachment
    const cipher = chacha20poly1305(encryptionKey, nonce);
    const encryptedData = cipher.encrypt(data);

    // Create encrypted package: [ephemeralPublic (32) | nonce (12) | ciphertext]
    const encryptedPackage = new Uint8Array(32 + 12 + encryptedData.length);
    encryptedPackage.set(ephemeralPublic, 0);
    encryptedPackage.set(nonce, 32);
    encryptedPackage.set(encryptedData, 44);

    // Upload encrypted package to IPFS
    const result = await this.ipfs.upload(encryptedPackage, { filename: `${filename}.encrypted` });

    return {
      cid: result.cid,
      filename,
      mimeType,
      size: data.length,
      encryptedSize: encryptedPackage.length,
      uploaded: result.uploaded,
      encrypted: true
    };
  }

  /**
   * Download and decrypt an attachment
   * @param {Object} attachment - Attachment metadata
   * @param {Uint8Array} recipientPrivateKey - Recipient's X25519 private key
   * @returns {Object} Decrypted attachment data
   */
  async downloadAttachment(attachment, recipientPrivateKey) {
    // Download encrypted package from IPFS
    const encryptedPackage = await this.ipfs.download(attachment.cid);

    // Extract components
    const ephemeralPublic = encryptedPackage.slice(0, 32);
    const nonce = encryptedPackage.slice(32, 44);
    const ciphertext = encryptedPackage.slice(44);

    // Compute shared secret
    const sharedSecret = x25519.getSharedSecret(recipientPrivateKey, ephemeralPublic);

    // Derive decryption key
    const decryptionKey = hkdf(
      sha256,
      sharedSecret,
      undefined,
      new TextEncoder().encode('dmail-attachment-v1'),
      32
    );

    // Decrypt
    const cipher = chacha20poly1305(decryptionKey, nonce);
    const data = cipher.decrypt(ciphertext);

    return {
      data,
      filename: attachment.filename,
      mimeType: attachment.mimeType
    };
  }
}

export { IPFS_GATEWAYS, PINNING_SERVICES };
