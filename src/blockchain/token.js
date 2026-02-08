/**
 * DMAIL Token Client
 *
 * JavaScript client for interacting with the DMailToken smart contract.
 * Handles relay node registration, staking, and reward claiming.
 */

import { ethers } from 'ethers';

// DMailToken contract ABI (key functions)
const TOKEN_ABI = [
  // ERC20 standard
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",

  // Token constants
  "function TOTAL_SUPPLY() view returns (uint256)",
  "function RELAY_REWARDS_POOL() view returns (uint256)",
  "function REWARD_DURATION() view returns (uint256)",

  // Relay node functions
  "function minStake() view returns (uint256)",
  "function relayRewardsDistributed() view returns (uint256)",
  "function rewardStartTime() view returns (uint256)",
  "function registerRelayNode(bytes32 peerId)",
  "function addStake(uint256 amount)",
  "function claimRewards()",
  "function deactivateNode()",
  "function withdrawStake()",
  "function calculateRewards(address wallet) view returns (uint256)",
  "function getActiveNodeCount() view returns (uint256)",
  "function getRegisteredNodes() view returns (address[])",
  "function getNodeInfo(address wallet) view returns (bytes32 peerId, uint256 stakedAmount, uint256 registeredAt, uint256 pendingRewards, uint256 totalClaimed, bool isActive)",
  "function relayNodes(address) view returns (bytes32 peerId, uint256 stakedAmount, uint256 registeredAt, uint256 lastClaimTime, uint256 totalRewardsClaimed, bool isActive)",
  "function peerIdToWallet(bytes32) view returns (address)",

  // Events
  "event RelayNodeRegistered(address indexed wallet, bytes32 peerId, uint256 stakeAmount)",
  "event RelayNodeDeactivated(address indexed wallet, bytes32 peerId)",
  "event RewardsClaimed(address indexed wallet, uint256 amount)",
  "event StakeWithdrawn(address indexed wallet, uint256 amount)",
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];

// Default token contract addresses
const TOKEN_ADDRESSES = {
  mainnet: null,
  sepolia: null,
  polygon: null,
  arbitrum: null,
  base: null,
  localhost: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512' // Second deployed contract after registry
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
 * DMAIL Token Client
 */
export class DMailTokenClient {
  constructor(options = {}) {
    this.network = options.network || 'localhost';
    this.rpcUrl = options.rpcUrl || RPC_ENDPOINTS[this.network];
    this.contractAddress = options.contractAddress || TOKEN_ADDRESSES[this.network];
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
        TOKEN_ABI,
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
   * Get token info
   */
  async getTokenInfo() {
    if (!this.contract) {
      throw new Error('Token contract not available');
    }

    const [name, symbol, decimals, totalSupply, rewardsPool, rewardsDistributed] = await Promise.all([
      this.contract.name(),
      this.contract.symbol(),
      this.contract.decimals(),
      this.contract.TOTAL_SUPPLY(),
      this.contract.RELAY_REWARDS_POOL(),
      this.contract.relayRewardsDistributed()
    ]);

    return {
      name,
      symbol,
      decimals: Number(decimals),
      totalSupply: ethers.formatEther(totalSupply),
      rewardsPool: ethers.formatEther(rewardsPool),
      rewardsDistributed: ethers.formatEther(rewardsDistributed),
      rewardsRemaining: ethers.formatEther(rewardsPool - rewardsDistributed)
    };
  }

  /**
   * Get token balance for an address
   */
  async getBalance(address) {
    if (!this.contract) {
      throw new Error('Token contract not available');
    }

    const balance = await this.contract.balanceOf(address);
    return {
      raw: balance,
      formatted: ethers.formatEther(balance)
    };
  }

  /**
   * Get minimum stake required for relay nodes
   */
  async getMinStake() {
    if (!this.contract) {
      throw new Error('Token contract not available');
    }

    const minStake = await this.contract.minStake();
    return {
      raw: minStake,
      formatted: ethers.formatEther(minStake)
    };
  }

  /**
   * Register as a relay node operator
   * @param {string} peerId - The libp2p peer ID (will be hashed to bytes32)
   */
  async registerRelayNode(peerId) {
    if (!this.signer) {
      throw new Error('Signer required for registration');
    }
    if (!this.contract) {
      throw new Error('Token contract not available');
    }

    // Convert peerId string to bytes32
    const peerIdBytes = ethers.keccak256(ethers.toUtf8Bytes(peerId));

    // Check if already registered
    const existingWallet = await this.contract.peerIdToWallet(peerIdBytes);
    if (existingWallet !== ethers.ZeroAddress) {
      throw new Error('Peer ID already registered');
    }

    // Check balance
    const balance = await this.contract.balanceOf(this.signer.address);
    const minStake = await this.contract.minStake();

    if (balance < minStake) {
      throw new Error(`Insufficient balance. Need ${ethers.formatEther(minStake)} DMAIL, have ${ethers.formatEther(balance)}`);
    }

    console.log(`Registering relay node with peer ID: ${peerId.slice(0, 16)}...`);
    console.log(`Staking ${ethers.formatEther(minStake)} DMAIL`);

    const tx = await this.contract.registerRelayNode(peerIdBytes);
    const receipt = await tx.wait();

    return {
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      peerId,
      peerIdBytes,
      stakedAmount: ethers.formatEther(minStake)
    };
  }

  /**
   * Add more stake to relay node
   */
  async addStake(amount) {
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
      amountAdded: amount
    };
  }

  /**
   * Claim pending rewards
   */
  async claimRewards() {
    if (!this.signer) {
      throw new Error('Signer required');
    }
    if (!this.contract) {
      throw new Error('Token contract not available');
    }

    // Check pending rewards first
    const pending = await this.contract.calculateRewards(this.signer.address);
    if (pending === 0n) {
      throw new Error('No rewards to claim');
    }

    console.log(`Claiming ${ethers.formatEther(pending)} DMAIL rewards...`);

    const tx = await this.contract.claimRewards();
    const receipt = await tx.wait();

    return {
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      amountClaimed: ethers.formatEther(pending)
    };
  }

  /**
   * Get pending rewards for an address
   */
  async getPendingRewards(address) {
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
      formatted: ethers.formatEther(pending)
    };
  }

  /**
   * Get relay node info
   */
  async getNodeInfo(address) {
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
      isActive
    };
  }

  /**
   * Deactivate relay node (starts unbonding period)
   */
  async deactivateNode() {
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
      blockNumber: receipt.blockNumber
    };
  }

  /**
   * Withdraw stake after deactivation
   */
  async withdrawStake() {
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
      amountWithdrawn: nodeInfo.stakedAmount
    };
  }

  /**
   * Get all registered relay nodes
   */
  async getRegisteredNodes() {
    if (!this.contract) {
      throw new Error('Token contract not available');
    }

    const addresses = await this.contract.getRegisteredNodes();
    const nodes = [];

    for (const addr of addresses) {
      try {
        const info = await this.getNodeInfo(addr);
        nodes.push({
          address: addr,
          ...info
        });
      } catch (e) {
        // Skip invalid nodes
      }
    }

    return nodes;
  }

  /**
   * Get active node count
   */
  async getActiveNodeCount() {
    if (!this.contract) {
      throw new Error('Token contract not available');
    }

    const count = await this.contract.getActiveNodeCount();
    return Number(count);
  }

  /**
   * Get network statistics
   */
  async getNetworkStats() {
    if (!this.contract) {
      throw new Error('Token contract not available');
    }

    const [tokenInfo, activeNodes, registeredNodes, minStake] = await Promise.all([
      this.getTokenInfo(),
      this.getActiveNodeCount(),
      this.contract.getRegisteredNodes(),
      this.getMinStake()
    ]);

    return {
      ...tokenInfo,
      activeNodes,
      totalRegisteredNodes: registeredNodes.length,
      minStakeRequired: minStake.formatted,
      rewardRatePerNodePerYear: parseFloat(tokenInfo.rewardsRemaining) / 10 / Math.max(activeNodes, 1)
    };
  }

  /**
   * Transfer tokens
   */
  async transfer(to, amount) {
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
      amount
    };
  }

  /**
   * Listen for reward claim events
   */
  onRewardsClaimed(callback) {
    if (!this.contract) {
      throw new Error('Token contract not available');
    }

    this.contract.on('RewardsClaimed', (wallet, amount, event) => {
      callback({
        wallet,
        amount: ethers.formatEther(amount),
        transactionHash: event.log.transactionHash,
        blockNumber: event.log.blockNumber
      });
    });
  }

  /**
   * Listen for new relay node registrations
   */
  onRelayNodeRegistered(callback) {
    if (!this.contract) {
      throw new Error('Token contract not available');
    }

    this.contract.on('RelayNodeRegistered', (wallet, peerId, stakeAmount, event) => {
      callback({
        wallet,
        peerId,
        stakeAmount: ethers.formatEther(stakeAmount),
        transactionHash: event.log.transactionHash,
        blockNumber: event.log.blockNumber
      });
    });
  }
}

export { TOKEN_ABI, TOKEN_ADDRESSES, RPC_ENDPOINTS };
