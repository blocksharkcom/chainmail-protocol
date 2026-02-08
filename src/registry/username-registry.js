/**
 * Username Registry for dMail
 *
 * Maps human-readable usernames to dMail addresses:
 *   alice@dmail.network → dm1abc...
 *
 * Can be stored:
 * 1. On-chain (permanent, costs gas)
 * 2. In DHT (decentralized, free)
 * 3. Hybrid (on-chain for verification, DHT for discovery)
 */

import { sha256 } from '@noble/hashes/sha256';
import { Level } from 'level';
import { join } from 'path';
import { DMAIL_DIR } from '../crypto/identity.js';
import { ethers } from 'ethers';

const DEFAULT_DOMAIN = 'dmail.network';
const USERNAME_REGEX = /^[a-z0-9][a-z0-9._-]{2,29}$/i;
const RESERVED_USERNAMES = ['admin', 'support', 'help', 'info', 'contact', 'root', 'system', 'dmail'];

/**
 * Local Username Registry (for relay nodes)
 */
export class UsernameRegistry {
  constructor(domain = DEFAULT_DOMAIN) {
    this.domain = domain;
    this.db = new Level(join(DMAIL_DIR, 'usernames'), { valueEncoding: 'json' });
  }

  /**
   * Validate username format
   */
  validateUsername(username) {
    if (!username || typeof username !== 'string') {
      return { valid: false, error: 'Username required' };
    }

    const lower = username.toLowerCase();

    if (!USERNAME_REGEX.test(lower)) {
      return {
        valid: false,
        error: 'Username must be 3-30 characters, start with letter/number, and contain only letters, numbers, dots, underscores, or hyphens'
      };
    }

    if (RESERVED_USERNAMES.includes(lower)) {
      return { valid: false, error: 'Username is reserved' };
    }

    return { valid: true, normalized: lower };
  }

  /**
   * Register a username for a wallet/dMail address
   */
  async register(username, dmailAddress, walletAddress, signature) {
    // Validate username
    const validation = this.validateUsername(username);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const normalizedUsername = validation.normalized;

    // Check if username is taken
    const existing = await this.getByUsername(normalizedUsername);
    if (existing) {
      throw new Error('Username already taken');
    }

    // Verify signature proves wallet ownership
    const message = `Register ${normalizedUsername}@${this.domain} for dMail address ${dmailAddress}`;
    const recoveredAddress = ethers.verifyMessage(message, signature);

    if (recoveredAddress.toLowerCase() !== walletAddress.toLowerCase()) {
      throw new Error('Invalid signature');
    }

    // Store the registration
    const record = {
      username: normalizedUsername,
      email: `${normalizedUsername}@${this.domain}`,
      dmailAddress,
      walletAddress: walletAddress.toLowerCase(),
      registeredAt: Date.now(),
      verified: true
    };

    await this.db.put(`user:${normalizedUsername}`, record);
    await this.db.put(`dmail:${dmailAddress}`, record);
    await this.db.put(`wallet:${walletAddress.toLowerCase()}`, record);

    return record;
  }

  /**
   * Look up by username
   */
  async getByUsername(username) {
    try {
      const normalized = username.toLowerCase().split('@')[0]; // Handle full email
      return await this.db.get(`user:${normalized}`);
    } catch (e) {
      if (e.code === 'LEVEL_NOT_FOUND') return null;
      throw e;
    }
  }

  /**
   * Look up by dMail address
   */
  async getByDmailAddress(dmailAddress) {
    try {
      return await this.db.get(`dmail:${dmailAddress}`);
    } catch (e) {
      if (e.code === 'LEVEL_NOT_FOUND') return null;
      throw e;
    }
  }

  /**
   * Look up by wallet address
   */
  async getByWallet(walletAddress) {
    try {
      return await this.db.get(`wallet:${walletAddress.toLowerCase()}`);
    } catch (e) {
      if (e.code === 'LEVEL_NOT_FOUND') return null;
      throw e;
    }
  }

  /**
   * Resolve email address to dMail address
   * Supports: username@domain OR dm1... addresses
   */
  async resolve(address) {
    // If it's already a dMail address
    if (address.startsWith('dm1')) {
      return { dmailAddress: address, type: 'direct' };
    }

    // If it's an email format
    if (address.includes('@')) {
      const [username, domain] = address.split('@');

      // Check if it's our domain
      if (domain === this.domain) {
        const record = await this.getByUsername(username);
        if (record) {
          return {
            dmailAddress: record.dmailAddress,
            username: record.username,
            email: record.email,
            type: 'registered'
          };
        }
      }

      throw new Error(`Unknown address: ${address}`);
    }

    // Try as username without domain
    const record = await this.getByUsername(address);
    if (record) {
      return {
        dmailAddress: record.dmailAddress,
        username: record.username,
        email: record.email,
        type: 'registered'
      };
    }

    throw new Error(`Could not resolve address: ${address}`);
  }

  /**
   * Check if username is available
   */
  async isAvailable(username) {
    const validation = this.validateUsername(username);
    if (!validation.valid) {
      return { available: false, error: validation.error };
    }

    const existing = await this.getByUsername(validation.normalized);
    return { available: !existing, normalized: validation.normalized };
  }

  /**
   * Get registration message for signing
   */
  getRegistrationMessage(username, dmailAddress) {
    const validation = this.validateUsername(username);
    if (!validation.valid) {
      throw new Error(validation.error);
    }
    return `Register ${validation.normalized}@${this.domain} for dMail address ${dmailAddress}`;
  }

  async close() {
    await this.db.close();
  }
}

/**
 * On-chain username registry (uses smart contract)
 */
export class OnChainUsernameRegistry {
  constructor(contractAddress, provider) {
    this.contractAddress = contractAddress;
    this.provider = provider;
    this.contract = null;
  }

  async connect(signerOrProvider) {
    const abi = [
      'function register(string username, bytes32 dmailAddressHash) external',
      'function resolve(string username) external view returns (bytes32)',
      'function isAvailable(string username) external view returns (bool)',
      'function getRegistration(address wallet) external view returns (string username, bytes32 dmailAddressHash)',
      'event UsernameRegistered(address indexed wallet, string username, bytes32 dmailAddressHash)'
    ];

    this.contract = new ethers.Contract(this.contractAddress, abi, signerOrProvider);
  }

  async register(username, dmailAddress) {
    if (!this.contract) throw new Error('Not connected');

    // Hash the dMail address for privacy
    const dmailHash = ethers.keccak256(ethers.toUtf8Bytes(dmailAddress));
    const tx = await this.contract.register(username.toLowerCase(), dmailHash);
    await tx.wait();

    return { username: username.toLowerCase(), dmailHash, txHash: tx.hash };
  }

  async resolve(username) {
    if (!this.contract) throw new Error('Not connected');
    return await this.contract.resolve(username.toLowerCase());
  }

  async isAvailable(username) {
    if (!this.contract) throw new Error('Not connected');
    return await this.contract.isAvailable(username.toLowerCase());
  }
}

export { DEFAULT_DOMAIN, USERNAME_REGEX };
