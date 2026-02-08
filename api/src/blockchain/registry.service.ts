import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers, Contract, JsonRpcProvider, Wallet } from 'ethers';
import { sha256 } from '@noble/hashes/sha256';
import { Identity } from '../crypto/interfaces/identity.interface';

const REGISTRY_ABI = [
  'function getIdentity(string name) view returns (bytes32 signingKey, bytes32 encryptionKey, string dmailAddress, uint256 registeredAt)',
  'function getName(string dmailAddress) view returns (string)',
  'function getMessageProof(bytes32 messageHash) view returns (tuple(bytes32 messageHash, address sender, string senderDmail, string recipientDmail, string ipfsCid, uint256 timestamp))',
  'function verifyMessageTime(bytes32 messageHash, uint256 beforeTime) view returns (bool)',
  'function getNamesOwnedBy(address owner) view returns (string[])',
  'function register(string name, bytes32 signingKey, bytes32 encryptionKey, string dmailAddress)',
  'function updateKeys(string name, bytes32 signingKey, bytes32 encryptionKey)',
  'function timestampMessage(bytes32 messageHash, string senderDmail, string recipientDmail)',
  'function timestampAndStore(bytes32 messageHash, string senderDmail, string recipientDmail, string ipfsCid)',
  'event IdentityRegistered(string indexed name, string dmailAddress, address indexed owner)',
  'event MessageTimestamped(bytes32 indexed messageHash, string indexed senderDmail, string indexed recipientDmail, uint256 timestamp)',
];

const CONTRACT_ADDRESSES: Record<string, string | null> = {
  mainnet: null,
  sepolia: null,
  localhost: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  polygon: null,
  arbitrum: null,
  base: null,
};

const RPC_ENDPOINTS: Record<string, string> = {
  mainnet: 'https://eth.llamarpc.com',
  sepolia: 'https://rpc.sepolia.org',
  polygon: 'https://polygon-rpc.com',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  base: 'https://mainnet.base.org',
  localhost: 'http://127.0.0.1:8545',
};

export interface RegisteredIdentity {
  name: string;
  signingKey: string;
  encryptionKey: string;
  dmailAddress: string;
  registeredAt: number;
}

export interface RegistrationResult {
  transactionHash: string;
  blockNumber: number;
  name: string;
  dmailAddress: string;
}

export interface TimestampResult {
  transactionHash: string;
  blockNumber: number;
  messageHash: string;
  ipfsCid?: string;
  timestamp: number;
}

export interface MessageProof {
  messageHash: string;
  sender: string;
  senderDmail: string;
  recipientDmail: string;
  ipfsCid: string | null;
  timestamp: number;
}

export interface NetworkInfo {
  network: string;
  chainId: number;
  blockNumber: number;
  contractAddress: string | null;
  contractDeployed: boolean;
}

@Injectable()
export class RegistryService {
  private network: string;
  private rpcUrl: string;
  private contractAddress: string | null;
  private provider: JsonRpcProvider | null = null;
  private contract: Contract | null = null;
  private signer: Wallet | null = null;

  // In-memory registry for local development (when no blockchain is available)
  private localRegistry: Map<string, RegisteredIdentity> = new Map();
  private addressToName: Map<string, string> = new Map();

  constructor(private readonly configService: ConfigService) {
    this.network = this.configService.get<string>('BLOCKCHAIN_NETWORK') || 'localhost';
    this.rpcUrl =
      this.configService.get<string>('BLOCKCHAIN_RPC_URL') || RPC_ENDPOINTS[this.network];
    this.contractAddress =
      this.configService.get<string>('REGISTRY_CONTRACT_ADDRESS') ||
      CONTRACT_ADDRESSES[this.network];
  }

  /**
   * Register identity in local registry (for development without blockchain)
   */
  registerLocal(
    name: string,
    dmailAddress: string,
    signingKey: string,
    encryptionKey: string,
  ): void {
    const identity: RegisteredIdentity = {
      name,
      signingKey,
      encryptionKey,
      dmailAddress,
      registeredAt: Date.now(),
    };
    this.localRegistry.set(name, identity);
    this.addressToName.set(dmailAddress, name);
  }

  /**
   * Look up identity in local registry
   */
  lookupLocalByName(name: string): RegisteredIdentity | null {
    return this.localRegistry.get(name) || null;
  }

  /**
   * Look up identity in local registry by address
   */
  lookupLocalByAddress(dmailAddress: string): RegisteredIdentity | null {
    const name = this.addressToName.get(dmailAddress);
    if (!name) return null;
    return this.localRegistry.get(name) || null;
  }

  /**
   * Connect to the blockchain
   */
  async connect(privateKey?: string): Promise<this> {
    this.provider = new JsonRpcProvider(this.rpcUrl);

    if (privateKey) {
      this.signer = new Wallet(privateKey, this.provider);
    }

    if (this.contractAddress) {
      const signerOrProvider = this.signer || this.provider;
      this.contract = new Contract(this.contractAddress, REGISTRY_ABI, signerOrProvider);
    }

    return this;
  }

  /**
   * Check if connected and contract is available
   */
  isAvailable(): boolean {
    return this.contract !== null;
  }

  /**
   * Register a dMail identity on-chain
   */
  async registerIdentity(name: string, identity: Identity): Promise<RegistrationResult> {
    if (!this.signer) {
      throw new Error('Signer required for registration');
    }
    if (!this.contract) {
      throw new Error('Contract not available on this network');
    }

    const signingKey = '0x' + Buffer.from(identity.publicKey).toString('hex');
    const encryptionKey = '0x' + Buffer.from(identity.encryptionPublicKey).toString('hex');

    const tx = await this.contract.register(name, signingKey, encryptionKey, identity.address);
    const receipt = await tx.wait();

    return {
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      name,
      dmailAddress: identity.address,
    };
  }

  /**
   * Look up identity by human-readable name
   */
  async lookupByName(name: string): Promise<RegisteredIdentity | null> {
    if (!this.contract) {
      return null;
    }

    try {
      const [signingKey, encryptionKey, dmailAddress, registeredAt] =
        await this.contract.getIdentity(name);

      return {
        name,
        signingKey: (signingKey as string).slice(2),
        encryptionKey: (encryptionKey as string).slice(2),
        dmailAddress,
        registeredAt: Number(registeredAt),
      };
    } catch {
      return null;
    }
  }

  /**
   * Look up name by dMail address
   */
  async lookupByAddress(dmailAddress: string): Promise<RegisteredIdentity | null> {
    // First check local registry (for development without blockchain)
    const localResult = this.lookupLocalByAddress(dmailAddress);
    if (localResult) {
      return localResult;
    }

    if (!this.contract) {
      return null;
    }

    try {
      const name = await this.contract.getName(dmailAddress);
      if (!name) return null;
      return this.lookupByName(name);
    } catch {
      return null;
    }
  }

  /**
   * Timestamp a message hash on-chain
   */
  async timestampMessage(messageEnvelope: {
    from: string;
    to: string;
    encrypted: unknown;
  }): Promise<TimestampResult> {
    if (!this.signer) {
      throw new Error('Signer required for timestamping');
    }
    if (!this.contract) {
      throw new Error('Contract not available on this network');
    }

    const messageData = JSON.stringify(messageEnvelope.encrypted);
    const hash = sha256(new TextEncoder().encode(messageData));
    const messageHash = '0x' + Buffer.from(hash).toString('hex');

    const tx = await this.contract.timestampMessage(
      messageHash,
      messageEnvelope.from,
      messageEnvelope.to,
    );

    const receipt = await tx.wait();
    return {
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      messageHash,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Timestamp message and store IPFS CID
   */
  async timestampAndStore(
    messageEnvelope: { from: string; to: string; encrypted: unknown },
    ipfsCid: string,
  ): Promise<TimestampResult> {
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
      ipfsCid,
    );

    const receipt = await tx.wait();
    return {
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      messageHash,
      ipfsCid,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Verify a message was timestamped before a certain time
   */
  async verifyMessageTime(messageHash: string, beforeTime: number): Promise<boolean | null> {
    if (!this.contract) {
      return null;
    }

    const hash = messageHash.startsWith('0x') ? messageHash : '0x' + messageHash;
    return await this.contract.verifyMessageTime(hash, beforeTime);
  }

  /**
   * Get proof of a timestamped message
   */
  async getMessageProof(messageHash: string): Promise<MessageProof | null> {
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
        timestamp: Number(proof.timestamp),
      };
    } catch {
      return null;
    }
  }

  /**
   * Resolve an address - can be a name or dmail address
   */
  async resolveAddress(addressOrName: string): Promise<string> {
    if (addressOrName.startsWith('dm1')) {
      return addressOrName;
    }

    const identity = await this.lookupByName(addressOrName);
    if (identity) {
      return identity.dmailAddress;
    }

    throw new Error(`Could not resolve address: ${addressOrName}`);
  }

  /**
   * Get network info
   */
  async getNetworkInfo(): Promise<NetworkInfo> {
    if (!this.provider) {
      throw new Error('Not connected');
    }

    const network = await this.provider.getNetwork();
    const blockNumber = await this.provider.getBlockNumber();

    return {
      network: this.network,
      chainId: Number(network.chainId),
      blockNumber,
      contractAddress: this.contractAddress,
      contractDeployed: this.contract !== null,
    };
  }
}
