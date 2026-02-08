/**
 * Blockchain Registry Integration
 *
 * Connects to Ethereum (or any EVM chain) to:
 * - Register human-readable names for dMail addresses
 * - Timestamp messages for proof of existence
 * - Store message hashes (and optionally IPFS CIDs)
 */

import { ethers } from 'ethers';
import { sha256 } from '@noble/hashes/sha256';

// Contract ABI (key functions only)
const REGISTRY_ABI = [
  // Read functions
  "function getIdentity(string name) view returns (bytes32 signingKey, bytes32 encryptionKey, string dmailAddress, uint256 registeredAt)",
  "function getName(string dmailAddress) view returns (string)",
  "function getMessageProof(bytes32 messageHash) view returns (tuple(bytes32 messageHash, address sender, string senderDmail, string recipientDmail, string ipfsCid, uint256 timestamp))",
  "function verifyMessageTime(bytes32 messageHash, uint256 beforeTime) view returns (bool)",
  "function getNamesOwnedBy(address owner) view returns (string[])",

  // Write functions
  "function register(string name, bytes32 signingKey, bytes32 encryptionKey, string dmailAddress)",
  "function updateKeys(string name, bytes32 signingKey, bytes32 encryptionKey)",
  "function timestampMessage(bytes32 messageHash, string senderDmail, string recipientDmail)",
  "function timestampAndStore(bytes32 messageHash, string senderDmail, string recipientDmail, string ipfsCid)",

  // Events
  "event IdentityRegistered(string indexed name, string dmailAddress, address indexed owner)",
  "event MessageTimestamped(bytes32 indexed messageHash, string indexed senderDmail, string indexed recipientDmail, uint256 timestamp)"
];

// Default contract addresses for different networks
const CONTRACT_ADDRESSES = {
  // Mainnet - to be deployed
  mainnet: null,
  // Sepolia testnet
  sepolia: null,
  // Local development
  localhost: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  // Polygon
  polygon: null,
  // Arbitrum
  arbitrum: null,
  // Base
  base: null
};

// Default RPC endpoints
const RPC_ENDPOINTS = {
  mainnet: 'https://eth.llamarpc.com',
  sepolia: 'https://rpc.sepolia.org',
  polygon: 'https://polygon-rpc.com',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  base: 'https://mainnet.base.org',
  localhost: 'http://127.0.0.1:8545'
};

/**
 * Blockchain Registry Client
 */
export class BlockchainRegistry {
  constructor(options = {}) {
    this.network = options.network || 'localhost';
    this.rpcUrl = options.rpcUrl || RPC_ENDPOINTS[this.network];
    this.contractAddress = options.contractAddress || CONTRACT_ADDRESSES[this.network];
    this.provider = null;
    this.contract = null;
    this.signer = null;
  }

  /**
   * Connect to the blockchain
   */
  async connect(privateKey = null) {
    this.provider = new ethers.JsonRpcProvider(this.rpcUrl);

    if (privateKey) {
      this.signer = new ethers.Wallet(privateKey, this.provider);
    }

    if (this.contractAddress) {
      const signerOrProvider = this.signer || this.provider;
      this.contract = new ethers.Contract(
        this.contractAddress,
        REGISTRY_ABI,
        signerOrProvider
      );
    }

    return this;
  }

  /**
   * Check if connected and contract is available
   */
  isAvailable() {
    return this.contract !== null;
  }

  /**
   * Register a dMail identity on-chain
   */
  async registerIdentity(name, identity) {
    if (!this.signer) {
      throw new Error('Signer required for registration');
    }
    if (!this.contract) {
      throw new Error('Contract not available on this network');
    }

    const signingKey = '0x' + Buffer.from(identity.publicKey).toString('hex');
    const encryptionKey = '0x' + Buffer.from(identity.encryptionPublicKey).toString('hex');

    const tx = await this.contract.register(
      name,
      signingKey,
      encryptionKey,
      identity.address
    );

    const receipt = await tx.wait();
    return {
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      name,
      dmailAddress: identity.address
    };
  }

  /**
   * Look up identity by human-readable name
   */
  async lookupByName(name) {
    if (!this.contract) {
      return null;
    }

    try {
      const [signingKey, encryptionKey, dmailAddress, registeredAt] =
        await this.contract.getIdentity(name);

      return {
        name,
        signingKey: signingKey.slice(2), // Remove 0x prefix
        encryptionKey: encryptionKey.slice(2),
        dmailAddress,
        registeredAt: Number(registeredAt)
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * Look up name by dMail address
   */
  async lookupByAddress(dmailAddress) {
    if (!this.contract) {
      return null;
    }

    try {
      const name = await this.contract.getName(dmailAddress);
      if (!name) return null;
      return this.lookupByName(name);
    } catch (e) {
      return null;
    }
  }

  /**
   * Timestamp a message hash on-chain
   */
  async timestampMessage(messageEnvelope) {
    if (!this.signer) {
      throw new Error('Signer required for timestamping');
    }
    if (!this.contract) {
      throw new Error('Contract not available on this network');
    }

    // Hash the encrypted message
    const messageData = JSON.stringify(messageEnvelope.encrypted);
    const hash = sha256(new TextEncoder().encode(messageData));
    const messageHash = '0x' + Buffer.from(hash).toString('hex');

    const tx = await this.contract.timestampMessage(
      messageHash,
      messageEnvelope.from,
      messageEnvelope.to
    );

    const receipt = await tx.wait();
    return {
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      messageHash,
      timestamp: Math.floor(Date.now() / 1000)
    };
  }

  /**
   * Timestamp message and store IPFS CID
   */
  async timestampAndStore(messageEnvelope, ipfsCid) {
    if (!this.signer) {
      throw new Error('Signer required for timestamping');
    }
    if (!this.contract) {
      throw new Error('Contract not available on this network');
    }

    const messageData = JSON.stringify(messageEnvelope.encrypted);
    const hash = sha256(new TextEncoder().encode(messageData));
    const messageHash = '0x' + Buffer.from(hash).toString('hex');

    const tx = await this.contract.timestampAndStore(
      messageHash,
      messageEnvelope.from,
      messageEnvelope.to,
      ipfsCid
    );

    const receipt = await tx.wait();
    return {
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      messageHash,
      ipfsCid,
      timestamp: Math.floor(Date.now() / 1000)
    };
  }

  /**
   * Verify a message was timestamped before a certain time
   */
  async verifyMessageTime(messageHash, beforeTime) {
    if (!this.contract) {
      return null;
    }

    const hash = messageHash.startsWith('0x') ? messageHash : '0x' + messageHash;
    return await this.contract.verifyMessageTime(hash, beforeTime);
  }

  /**
   * Get proof of a timestamped message
   */
  async getMessageProof(messageHash) {
    if (!this.contract) {
      return null;
    }

    const hash = messageHash.startsWith('0x') ? messageHash : '0x' + messageHash;

    try {
      const proof = await this.contract.getMessageProof(hash);
      if (proof.timestamp === 0n) return null;

      return {
        messageHash: proof.messageHash,
        sender: proof.sender,
        senderDmail: proof.senderDmail,
        recipientDmail: proof.recipientDmail,
        ipfsCid: proof.ipfsCid || null,
        timestamp: Number(proof.timestamp)
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * Resolve an address - can be a name or dmail address
   */
  async resolveAddress(addressOrName) {
    // If it starts with dm1, it's already a dmail address
    if (addressOrName.startsWith('dm1')) {
      return addressOrName;
    }

    // Try to look up as a name
    const identity = await this.lookupByName(addressOrName);
    if (identity) {
      return identity.dmailAddress;
    }

    throw new Error(`Could not resolve address: ${addressOrName}`);
  }

  /**
   * Get network info
   */
  async getNetworkInfo() {
    const network = await this.provider.getNetwork();
    const blockNumber = await this.provider.getBlockNumber();

    return {
      network: this.network,
      chainId: Number(network.chainId),
      blockNumber,
      contractAddress: this.contractAddress,
      contractDeployed: this.contract !== null
    };
  }
}

export { CONTRACT_ADDRESSES, RPC_ENDPOINTS, REGISTRY_ABI };
