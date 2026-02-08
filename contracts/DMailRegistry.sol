// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title DMailRegistry
 * @notice Decentralized Email Registry - Maps human-readable names to public keys
 *         and provides message hash timestamping for proof of existence.
 *
 * Features:
 * - Register a human-readable name (like ENS but for email)
 * - Associate multiple public keys (signing + encryption)
 * - Timestamp message hashes for proof of existence
 * - Optional encrypted message storage (IPFS CID)
 * - Fully decentralized - no admin controls
 */
contract DMailRegistry {
    struct Identity {
        bytes32 signingKey;       // Ed25519 public key (32 bytes)
        bytes32 encryptionKey;    // X25519 public key (32 bytes)
        string dmailAddress;      // Full dmail address (dm1...)
        uint256 registeredAt;
        bool exists;
    }

    struct MessageProof {
        bytes32 messageHash;      // SHA256 of the encrypted message
        address sender;           // Ethereum address of sender
        string senderDmail;       // dMail address of sender
        string recipientDmail;    // dMail address of recipient
        string ipfsCid;           // Optional: IPFS CID if stored on IPFS
        uint256 timestamp;
    }

    // Name => Identity mapping
    mapping(string => Identity) public identities;

    // dMail address => name (reverse lookup)
    mapping(string => string) public addressToName;

    // Ethereum address => dMail names owned
    mapping(address => string[]) public ownerNames;

    // Name => owner Ethereum address
    mapping(string => address) public nameOwner;

    // Message hash => proof (for timestamping)
    mapping(bytes32 => MessageProof) public messageProofs;

    // Events
    event IdentityRegistered(
        string indexed name,
        string dmailAddress,
        address indexed owner
    );

    event IdentityUpdated(
        string indexed name,
        string dmailAddress
    );

    event MessageTimestamped(
        bytes32 indexed messageHash,
        string indexed senderDmail,
        string indexed recipientDmail,
        uint256 timestamp
    );

    event MessageStoredOnChain(
        bytes32 indexed messageHash,
        string ipfsCid
    );

    // Errors
    error NameAlreadyRegistered();
    error NameNotRegistered();
    error NotOwner();
    error InvalidName();
    error InvalidDmailAddress();
    error MessageAlreadyTimestamped();

    /**
     * @notice Register a new identity
     * @param name Human-readable name (e.g., "alice")
     * @param signingKey Ed25519 public key for signing
     * @param encryptionKey X25519 public key for encryption
     * @param dmailAddress Full dmail address (dm1...)
     */
    function register(
        string calldata name,
        bytes32 signingKey,
        bytes32 encryptionKey,
        string calldata dmailAddress
    ) external {
        if (bytes(name).length == 0 || bytes(name).length > 32) {
            revert InvalidName();
        }
        if (!_startsWith(dmailAddress, "dm1")) {
            revert InvalidDmailAddress();
        }
        if (identities[name].exists) {
            revert NameAlreadyRegistered();
        }

        identities[name] = Identity({
            signingKey: signingKey,
            encryptionKey: encryptionKey,
            dmailAddress: dmailAddress,
            registeredAt: block.timestamp,
            exists: true
        });

        addressToName[dmailAddress] = name;
        nameOwner[name] = msg.sender;
        ownerNames[msg.sender].push(name);

        emit IdentityRegistered(name, dmailAddress, msg.sender);
    }

    /**
     * @notice Update identity keys
     */
    function updateKeys(
        string calldata name,
        bytes32 signingKey,
        bytes32 encryptionKey
    ) external {
        if (nameOwner[name] != msg.sender) {
            revert NotOwner();
        }
        if (!identities[name].exists) {
            revert NameNotRegistered();
        }

        identities[name].signingKey = signingKey;
        identities[name].encryptionKey = encryptionKey;

        emit IdentityUpdated(name, identities[name].dmailAddress);
    }

    /**
     * @notice Timestamp a message hash for proof of existence
     * @param messageHash SHA256 hash of the encrypted message
     * @param senderDmail Sender's dmail address
     * @param recipientDmail Recipient's dmail address
     */
    function timestampMessage(
        bytes32 messageHash,
        string calldata senderDmail,
        string calldata recipientDmail
    ) external {
        if (messageProofs[messageHash].timestamp != 0) {
            revert MessageAlreadyTimestamped();
        }

        messageProofs[messageHash] = MessageProof({
            messageHash: messageHash,
            sender: msg.sender,
            senderDmail: senderDmail,
            recipientDmail: recipientDmail,
            ipfsCid: "",
            timestamp: block.timestamp
        });

        emit MessageTimestamped(
            messageHash,
            senderDmail,
            recipientDmail,
            block.timestamp
        );
    }

    /**
     * @notice Timestamp message and store IPFS CID
     * @param messageHash SHA256 hash of the encrypted message
     * @param senderDmail Sender's dmail address
     * @param recipientDmail Recipient's dmail address
     * @param ipfsCid IPFS Content ID where encrypted message is stored
     */
    function timestampAndStore(
        bytes32 messageHash,
        string calldata senderDmail,
        string calldata recipientDmail,
        string calldata ipfsCid
    ) external {
        if (messageProofs[messageHash].timestamp != 0) {
            revert MessageAlreadyTimestamped();
        }

        messageProofs[messageHash] = MessageProof({
            messageHash: messageHash,
            sender: msg.sender,
            senderDmail: senderDmail,
            recipientDmail: recipientDmail,
            ipfsCid: ipfsCid,
            timestamp: block.timestamp
        });

        emit MessageTimestamped(
            messageHash,
            senderDmail,
            recipientDmail,
            block.timestamp
        );

        emit MessageStoredOnChain(messageHash, ipfsCid);
    }

    /**
     * @notice Look up identity by name
     */
    function getIdentity(string calldata name)
        external
        view
        returns (
            bytes32 signingKey,
            bytes32 encryptionKey,
            string memory dmailAddress,
            uint256 registeredAt
        )
    {
        Identity storage identity = identities[name];
        if (!identity.exists) {
            revert NameNotRegistered();
        }
        return (
            identity.signingKey,
            identity.encryptionKey,
            identity.dmailAddress,
            identity.registeredAt
        );
    }

    /**
     * @notice Look up name by dmail address
     */
    function getName(string calldata dmailAddress)
        external
        view
        returns (string memory)
    {
        return addressToName[dmailAddress];
    }

    /**
     * @notice Get message proof
     */
    function getMessageProof(bytes32 messageHash)
        external
        view
        returns (MessageProof memory)
    {
        return messageProofs[messageHash];
    }

    /**
     * @notice Verify a message was sent before a certain time
     */
    function verifyMessageTime(bytes32 messageHash, uint256 beforeTime)
        external
        view
        returns (bool)
    {
        MessageProof storage proof = messageProofs[messageHash];
        return proof.timestamp != 0 && proof.timestamp <= beforeTime;
    }

    /**
     * @notice Get all names owned by an address
     */
    function getNamesOwnedBy(address owner)
        external
        view
        returns (string[] memory)
    {
        return ownerNames[owner];
    }

    // Internal helper to check string prefix
    function _startsWith(string memory str, string memory prefix)
        internal
        pure
        returns (bool)
    {
        bytes memory strBytes = bytes(str);
        bytes memory prefixBytes = bytes(prefix);

        if (strBytes.length < prefixBytes.length) {
            return false;
        }

        for (uint i = 0; i < prefixBytes.length; i++) {
            if (strBytes[i] != prefixBytes[i]) {
                return false;
            }
        }
        return true;
    }
}
