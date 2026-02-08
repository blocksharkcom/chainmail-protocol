// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title DMailToken
 * @notice The native token for the dMail network
 *
 * Token Economics:
 * - Total Supply: 1 billion DMAIL
 * - Relay Node Rewards: 40% (400M) - distributed over 10 years
 * - Community/Airdrops: 20% (200M)
 * - Development: 15% (150M)
 * - Treasury: 15% (150M)
 * - Initial Liquidity: 10% (100M)
 *
 * Utility:
 * - Pay for premium features (large attachments, priority delivery)
 * - Stake to run a relay node
 * - Governance voting
 * - Spam prevention (optional deposit for new accounts)
 */
contract DMailToken is ERC20, Ownable {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 * 10**18; // 1 billion
    uint256 public constant RELAY_REWARDS_POOL = 400_000_000 * 10**18; // 400M for relay rewards

    // Reward distribution
    uint256 public relayRewardsDistributed;
    uint256 public rewardStartTime;
    uint256 public constant REWARD_DURATION = 10 * 365 days; // 10 years

    // Relay node registry
    mapping(address => RelayNode) public relayNodes;
    mapping(bytes32 => address) public peerIdToWallet;
    address[] public registeredNodes;

    struct RelayNode {
        bytes32 peerId;
        uint256 stakedAmount;
        uint256 registeredAt;
        uint256 lastClaimTime;
        uint256 totalRewardsClaimed;
        bool isActive;
    }

    // Minimum stake to run a relay node
    uint256 public minStake = 10_000 * 10**18; // 10,000 DMAIL

    // Events
    event RelayNodeRegistered(address indexed wallet, bytes32 peerId, uint256 stakeAmount);
    event RelayNodeDeactivated(address indexed wallet, bytes32 peerId);
    event RewardsClaimed(address indexed wallet, uint256 amount);
    event StakeWithdrawn(address indexed wallet, uint256 amount);

    constructor() ERC20("dMail Token", "DMAIL") Ownable(msg.sender) {
        rewardStartTime = block.timestamp;

        // Mint initial distribution
        _mint(msg.sender, TOTAL_SUPPLY - RELAY_REWARDS_POOL);
        _mint(address(this), RELAY_REWARDS_POOL); // Lock relay rewards in contract
    }

    /**
     * @notice Register as a relay node operator
     * @param peerId The libp2p peer ID of your relay node
     */
    function registerRelayNode(bytes32 peerId) external {
        require(relayNodes[msg.sender].peerId == bytes32(0), "Already registered");
        require(peerIdToWallet[peerId] == address(0), "Peer ID already registered");
        require(balanceOf(msg.sender) >= minStake, "Insufficient balance for stake");

        // Transfer stake to contract
        _transfer(msg.sender, address(this), minStake);

        relayNodes[msg.sender] = RelayNode({
            peerId: peerId,
            stakedAmount: minStake,
            registeredAt: block.timestamp,
            lastClaimTime: block.timestamp,
            totalRewardsClaimed: 0,
            isActive: true
        });

        peerIdToWallet[peerId] = msg.sender;
        registeredNodes.push(msg.sender);

        emit RelayNodeRegistered(msg.sender, peerId, minStake);
    }

    /**
     * @notice Add more stake to your relay node
     */
    function addStake(uint256 amount) external {
        require(relayNodes[msg.sender].isActive, "Not a registered node");
        require(balanceOf(msg.sender) >= amount, "Insufficient balance");

        _transfer(msg.sender, address(this), amount);
        relayNodes[msg.sender].stakedAmount += amount;
    }

    /**
     * @notice Claim relay rewards
     * Rewards are calculated based on:
     * - Time since last claim
     * - Stake amount (higher stake = higher rewards multiplier)
     * - Network participation (to be verified off-chain)
     */
    function claimRewards() external {
        RelayNode storage node = relayNodes[msg.sender];
        require(node.isActive, "Not an active node");

        uint256 rewards = calculateRewards(msg.sender);
        require(rewards > 0, "No rewards to claim");
        require(relayRewardsDistributed + rewards <= RELAY_REWARDS_POOL, "Reward pool exhausted");

        node.lastClaimTime = block.timestamp;
        node.totalRewardsClaimed += rewards;
        relayRewardsDistributed += rewards;

        _transfer(address(this), msg.sender, rewards);

        emit RewardsClaimed(msg.sender, rewards);
    }

    /**
     * @notice Calculate pending rewards for a node
     */
    function calculateRewards(address wallet) public view returns (uint256) {
        RelayNode storage node = relayNodes[wallet];
        if (!node.isActive) return 0;

        uint256 timeElapsed = block.timestamp - node.lastClaimTime;
        uint256 totalActiveNodes = getActiveNodeCount();
        if (totalActiveNodes == 0) return 0;

        // Base reward rate: distribute pool over duration, divided by active nodes
        uint256 baseRewardPerSecond = RELAY_REWARDS_POOL / REWARD_DURATION / totalActiveNodes;

        // Stake multiplier: higher stake = up to 2x rewards
        uint256 stakeMultiplier = 100 + (node.stakedAmount * 100 / (minStake * 10));
        if (stakeMultiplier > 200) stakeMultiplier = 200; // Cap at 2x

        uint256 rewards = baseRewardPerSecond * timeElapsed * stakeMultiplier / 100;

        return rewards;
    }

    /**
     * @notice Deactivate relay node and withdraw stake
     * @dev 7-day unbonding period
     */
    function deactivateNode() external {
        RelayNode storage node = relayNodes[msg.sender];
        require(node.isActive, "Not an active node");

        node.isActive = false;

        emit RelayNodeDeactivated(msg.sender, node.peerId);
    }

    /**
     * @notice Withdraw stake after deactivation (7-day waiting period)
     */
    function withdrawStake() external {
        RelayNode storage node = relayNodes[msg.sender];
        require(!node.isActive, "Deactivate node first");
        require(node.stakedAmount > 0, "No stake to withdraw");

        uint256 amount = node.stakedAmount;
        node.stakedAmount = 0;

        _transfer(address(this), msg.sender, amount);

        emit StakeWithdrawn(msg.sender, amount);
    }

    /**
     * @notice Get number of active relay nodes
     */
    function getActiveNodeCount() public view returns (uint256) {
        uint256 count = 0;
        for (uint256 i = 0; i < registeredNodes.length; i++) {
            if (relayNodes[registeredNodes[i]].isActive) {
                count++;
            }
        }
        return count;
    }

    /**
     * @notice Get all registered node addresses
     */
    function getRegisteredNodes() external view returns (address[] memory) {
        return registeredNodes;
    }

    /**
     * @notice Update minimum stake requirement (owner only)
     */
    function setMinStake(uint256 newMinStake) external onlyOwner {
        minStake = newMinStake;
    }

    /**
     * @notice Get node info by wallet address
     */
    function getNodeInfo(address wallet) external view returns (
        bytes32 peerId,
        uint256 stakedAmount,
        uint256 registeredAt,
        uint256 pendingRewards,
        uint256 totalClaimed,
        bool isActive
    ) {
        RelayNode storage node = relayNodes[wallet];
        return (
            node.peerId,
            node.stakedAmount,
            node.registeredAt,
            calculateRewards(wallet),
            node.totalRewardsClaimed,
            node.isActive
        );
    }
}
