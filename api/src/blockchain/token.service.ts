import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers, Contract, JsonRpcProvider, Wallet } from 'ethers';

const TOKEN_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function TOTAL_SUPPLY() view returns (uint256)',
  'function RELAY_REWARDS_POOL() view returns (uint256)',
  'function REWARD_DURATION() view returns (uint256)',
  'function minStake() view returns (uint256)',
  'function relayRewardsDistributed() view returns (uint256)',
  'function rewardStartTime() view returns (uint256)',
  'function registerRelayNode(bytes32 peerId)',
  'function addStake(uint256 amount)',
  'function claimRewards()',
  'function deactivateNode()',
  'function withdrawStake()',
  'function calculateRewards(address wallet) view returns (uint256)',
  'function getActiveNodeCount() view returns (uint256)',
  'function getRegisteredNodes() view returns (address[])',
  'function getNodeInfo(address wallet) view returns (bytes32 peerId, uint256 stakedAmount, uint256 registeredAt, uint256 pendingRewards, uint256 totalClaimed, bool isActive)',
  'function relayNodes(address) view returns (bytes32 peerId, uint256 stakedAmount, uint256 registeredAt, uint256 lastClaimTime, uint256 totalRewardsClaimed, bool isActive)',
  'function peerIdToWallet(bytes32) view returns (address)',
  'event RelayNodeRegistered(address indexed wallet, bytes32 peerId, uint256 stakeAmount)',
  'event RelayNodeDeactivated(address indexed wallet, bytes32 peerId)',
  'event RewardsClaimed(address indexed wallet, uint256 amount)',
  'event StakeWithdrawn(address indexed wallet, uint256 amount)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

const TOKEN_ADDRESSES: Record<string, string | null> = {
  mainnet: null,
  sepolia: null,
  polygon: null,
  arbitrum: null,
  base: null,
  localhost: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
};

const RPC_ENDPOINTS: Record<string, string> = {
  mainnet: 'https://eth.llamarpc.com',
  sepolia: 'https://rpc.sepolia.org',
  polygon: 'https://polygon-rpc.com',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  base: 'https://mainnet.base.org',
  localhost: 'http://127.0.0.1:8545',
};

export interface TokenInfo {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  rewardsPool: string;
  rewardsDistributed: string;
  rewardsRemaining: string;
}

export interface Balance {
  raw: bigint;
  formatted: string;
}

export interface RelayNodeInfo {
  peerId: string;
  stakedAmount: string;
  registeredAt: Date;
  pendingRewards: string;
  totalClaimed: string;
  isActive: boolean;
}

export interface RegistrationResult {
  transactionHash: string;
  blockNumber: number;
  peerId: string;
  peerIdBytes: string;
  stakedAmount: string;
}

export interface TransactionResult {
  transactionHash: string;
  blockNumber: number;
  [key: string]: unknown;
}

export interface NetworkStats extends TokenInfo {
  activeNodes: number;
  totalRegisteredNodes: number;
  minStakeRequired: string;
  rewardRatePerNodePerYear: number;
}

@Injectable()
export class TokenService {
  private network: string;
  private rpcUrl: string;
  private contractAddress: string | null;
  private provider: JsonRpcProvider | null = null;
  private contract: Contract | null = null;
  private signer: Wallet | null = null;

  constructor(private readonly configService: ConfigService) {
    this.network = this.configService.get<string>('BLOCKCHAIN_NETWORK') || 'localhost';
    this.rpcUrl =
      this.configService.get<string>('BLOCKCHAIN_RPC_URL') || RPC_ENDPOINTS[this.network];
    this.contractAddress =
      this.configService.get<string>('TOKEN_CONTRACT_ADDRESS') || TOKEN_ADDRESSES[this.network];
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
      this.contract = new Contract(this.contractAddress, TOKEN_ABI, signerOrProvider);
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
   * Get token info
   */
  async getTokenInfo(): Promise<TokenInfo> {
    if (!this.contract) {
      throw new Error('Token contract not available');
    }

    const [name, symbol, decimals, totalSupply, rewardsPool, rewardsDistributed] =
      await Promise.all([
        this.contract.name(),
        this.contract.symbol(),
        this.contract.decimals(),
        this.contract.TOTAL_SUPPLY(),
        this.contract.RELAY_REWARDS_POOL(),
        this.contract.relayRewardsDistributed(),
      ]);

    return {
      name,
      symbol,
      decimals: Number(decimals),
      totalSupply: ethers.formatEther(totalSupply),
      rewardsPool: ethers.formatEther(rewardsPool),
      rewardsDistributed: ethers.formatEther(rewardsDistributed),
      rewardsRemaining: ethers.formatEther(rewardsPool - rewardsDistributed),
    };
  }

  /**
   * Get token balance for an address
   */
  async getBalance(address: string): Promise<Balance> {
    if (!this.contract) {
      throw new Error('Token contract not available');
    }

    const balance = await this.contract.balanceOf(address);
    return {
      raw: balance,
      formatted: ethers.formatEther(balance),
    };
  }

  /**
   * Get minimum stake required for relay nodes
   */
  async getMinStake(): Promise<Balance> {
    if (!this.contract) {
      throw new Error('Token contract not available');
    }

    const minStake = await this.contract.minStake();
    return {
      raw: minStake,
      formatted: ethers.formatEther(minStake),
    };
  }

  /**
   * Register as a relay node operator
   */
  async registerRelayNode(peerId: string): Promise<RegistrationResult> {
    if (!this.signer) {
      throw new Error('Signer required for registration');
    }
    if (!this.contract) {
      throw new Error('Token contract not available');
    }

    const peerIdBytes = ethers.keccak256(ethers.toUtf8Bytes(peerId));

    const existingWallet = await this.contract.peerIdToWallet(peerIdBytes);
    if (existingWallet !== ethers.ZeroAddress) {
      throw new Error('Peer ID already registered');
    }

    const balance = await this.contract.balanceOf(this.signer.address);
    const minStake = await this.contract.minStake();

    if (balance < minStake) {
      throw new Error(
        `Insufficient balance. Need ${ethers.formatEther(minStake)} DMAIL, have ${ethers.formatEther(balance)}`,
      );
    }

    const tx = await this.contract.registerRelayNode(peerIdBytes);
    const receipt = await tx.wait();

    return {
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      peerId,
      peerIdBytes,
      stakedAmount: ethers.formatEther(minStake),
    };
  }

  /**
   * Add more stake to relay node
   */
  async addStake(amount: number | string): Promise<TransactionResult> {
    if (!this.signer) {
      throw new Error('Signer required');
    }
    if (!this.contract) {
      throw new Error('Token contract not available');
    }

    const amountWei = ethers.parseEther(amount.toString());
    const tx = await this.contract.addStake(amountWei);
    const receipt = await tx.wait();

    return {
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      amountAdded: amount,
    };
  }

  /**
   * Claim pending rewards
   */
  async claimRewards(): Promise<TransactionResult> {
    if (!this.signer) {
      throw new Error('Signer required');
    }
    if (!this.contract) {
      throw new Error('Token contract not available');
    }

    const pending = await this.contract.calculateRewards(this.signer.address);
    if (pending === 0n) {
      throw new Error('No rewards to claim');
    }

    const tx = await this.contract.claimRewards();
    const receipt = await tx.wait();

    return {
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      amountClaimed: ethers.formatEther(pending),
    };
  }

  /**
   * Get pending rewards for an address
   */
  async getPendingRewards(address?: string): Promise<Balance> {
    if (!this.contract) {
      throw new Error('Token contract not available');
    }

    const walletAddress = address || this.signer?.address;
    if (!walletAddress) {
      throw new Error('No address provided');
    }

    const pending = await this.contract.calculateRewards(walletAddress);
    return {
      raw: pending,
      formatted: ethers.formatEther(pending),
    };
  }

  /**
   * Get relay node info
   */
  async getNodeInfo(address?: string): Promise<RelayNodeInfo> {
    if (!this.contract) {
      throw new Error('Token contract not available');
    }

    const walletAddress = address || this.signer?.address;
    if (!walletAddress) {
      throw new Error('No address provided');
    }

    const [peerId, stakedAmount, registeredAt, pendingRewards, totalClaimed, isActive] =
      await this.contract.getNodeInfo(walletAddress);

    return {
      peerId,
      stakedAmount: ethers.formatEther(stakedAmount),
      registeredAt: new Date(Number(registeredAt) * 1000),
      pendingRewards: ethers.formatEther(pendingRewards),
      totalClaimed: ethers.formatEther(totalClaimed),
      isActive,
    };
  }

  /**
   * Deactivate relay node
   */
  async deactivateNode(): Promise<TransactionResult> {
    if (!this.signer) {
      throw new Error('Signer required');
    }
    if (!this.contract) {
      throw new Error('Token contract not available');
    }

    const tx = await this.contract.deactivateNode();
    const receipt = await tx.wait();

    return {
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
    };
  }

  /**
   * Withdraw stake after deactivation
   */
  async withdrawStake(): Promise<TransactionResult> {
    if (!this.signer) {
      throw new Error('Signer required');
    }
    if (!this.contract) {
      throw new Error('Token contract not available');
    }

    const nodeInfo = await this.getNodeInfo();
    if (nodeInfo.isActive) {
      throw new Error('Deactivate node first');
    }

    const tx = await this.contract.withdrawStake();
    const receipt = await tx.wait();

    return {
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      amountWithdrawn: nodeInfo.stakedAmount,
    };
  }

  /**
   * Get all registered relay nodes
   */
  async getRegisteredNodes(): Promise<(RelayNodeInfo & { address: string })[]> {
    if (!this.contract) {
      throw new Error('Token contract not available');
    }

    const addresses = await this.contract.getRegisteredNodes();
    const nodes: (RelayNodeInfo & { address: string })[] = [];

    for (const addr of addresses) {
      try {
        const info = await this.getNodeInfo(addr);
        nodes.push({
          address: addr,
          ...info,
        });
      } catch {
        // Skip invalid nodes
      }
    }

    return nodes;
  }

  /**
   * Get active node count
   */
  async getActiveNodeCount(): Promise<number> {
    if (!this.contract) {
      throw new Error('Token contract not available');
    }

    const count = await this.contract.getActiveNodeCount();
    return Number(count);
  }

  /**
   * Get network statistics
   */
  async getNetworkStats(): Promise<NetworkStats> {
    if (!this.contract) {
      throw new Error('Token contract not available');
    }

    const [tokenInfo, activeNodes, registeredNodes, minStake] = await Promise.all([
      this.getTokenInfo(),
      this.getActiveNodeCount(),
      this.contract.getRegisteredNodes(),
      this.getMinStake(),
    ]);

    return {
      ...tokenInfo,
      activeNodes,
      totalRegisteredNodes: registeredNodes.length,
      minStakeRequired: minStake.formatted,
      rewardRatePerNodePerYear:
        parseFloat(tokenInfo.rewardsRemaining) / 10 / Math.max(activeNodes, 1),
    };
  }

  /**
   * Transfer tokens
   */
  async transfer(to: string, amount: number | string): Promise<TransactionResult> {
    if (!this.signer) {
      throw new Error('Signer required');
    }
    if (!this.contract) {
      throw new Error('Token contract not available');
    }

    const amountWei = ethers.parseEther(amount.toString());
    const tx = await this.contract.transfer(to, amountWei);
    const receipt = await tx.wait();

    return {
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      to,
      amount,
    };
  }

  /**
   * Listen for reward claim events
   */
  onRewardsClaimed(
    callback: (event: {
      wallet: string;
      amount: string;
      transactionHash: string;
      blockNumber: number;
    }) => void,
  ): void {
    if (!this.contract) {
      throw new Error('Token contract not available');
    }

    this.contract.on('RewardsClaimed', (wallet, amount, event) => {
      callback({
        wallet,
        amount: ethers.formatEther(amount),
        transactionHash: event.log.transactionHash,
        blockNumber: event.log.blockNumber,
      });
    });
  }

  /**
   * Listen for new relay node registrations
   */
  onRelayNodeRegistered(
    callback: (event: {
      wallet: string;
      peerId: string;
      stakeAmount: string;
      transactionHash: string;
      blockNumber: number;
    }) => void,
  ): void {
    if (!this.contract) {
      throw new Error('Token contract not available');
    }

    this.contract.on('RelayNodeRegistered', (wallet, peerId, stakeAmount, event) => {
      callback({
        wallet,
        peerId,
        stakeAmount: ethers.formatEther(stakeAmount),
        transactionHash: event.log.transactionHash,
        blockNumber: event.log.blockNumber,
      });
    });
  }
}
