# Chainmail Protocol - Blockchain Email with P2P Encryption

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/NestJS-E0234E?style=for-the-badge&logo=nestjs&logoColor=white" alt="NestJS"/>
  <img src="https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB" alt="React"/>
  <img src="https://img.shields.io/badge/Ethereum-3C3C3D?style=for-the-badge&logo=Ethereum&logoColor=white" alt="Ethereum"/>
  <img src="https://img.shields.io/badge/libp2p-000000?style=for-the-badge&logo=libp2p&logoColor=white" alt="libp2p"/>
</p>

<p align="center">
  <strong>Open-source Web3 email protocol with P2P messaging, blockchain identity, and zero-knowledge encryption. No servers required.</strong>
</p>

<p align="center">
  <a href="#features">Features</a> &bull;
  <a href="#architecture">Architecture</a> &bull;
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#documentation">Documentation</a> &bull;
  <a href="#security">Security</a> &bull;
  <a href="#contributing">Contributing</a>
</p>

---

## Overview

Chainmail Protocol is a next-generation decentralized email system that combines the familiarity of email with the security and privacy of blockchain technology. Unlike traditional email services, Chainmail ensures that only you and your intended recipients can read your messages - no central servers, no data harvesting, no compromises.

### Why Chainmail?

| Traditional Email | Chainmail Protocol |
|-------------------|-------------------|
| Centralized servers | Peer-to-peer network |
| Provider can read emails | End-to-end encrypted |
| Username/password auth | Wallet-based identity |
| Single point of failure | Distributed architecture |
| Data stored on company servers | Data stored on your device |
| Trust the provider | Trust the cryptography |

---

## Features

### Core Features

- **End-to-End Encryption** - Messages are encrypted using X25519 + ChaCha20-Poly1305. Only the recipient can decrypt.
- **Wallet-Based Identity** - No passwords to remember. Sign in with MetaMask, WalletConnect, or any Web3 wallet.
- **Peer-to-Peer Messaging** - Messages travel directly between peers via libp2p. No central mail servers.
- **Blockchain Identity Registry** - On-chain identity verification and name resolution.
- **Human-Readable Addresses** - Bech32-encoded addresses (e.g., `cm1abc123...`) that are easy to share.
- **Local-Only Mode** - Works without P2P for development and testing with local storage.

### Advanced Features

- **Sealed Envelopes** - Anonymous messaging where even the network doesn't know the sender.
- **Double Ratchet Protocol** - Forward secrecy and post-compromise security for long-term conversations.
- **Onion Routing** - Multi-layer encryption for enhanced privacy (configurable).
- **Message Timestamping** - Cryptographic proof of when messages were sent (via blockchain).
- **Offline Message Delivery** - Relay nodes store encrypted messages for offline recipients.

### Security Features

- **Ed25519 Signatures** - All messages are digitally signed to prevent tampering.
- **Perfect Forward Secrecy** - Compromised keys don't expose past messages.
- **Local Key Storage** - Private keys never leave your device.
- **Zero-Knowledge Architecture** - Relay nodes only see encrypted blobs.

---

## Architecture

### System Overview

```
+-----------------------------------------------------------------------------+
|                              CLIENT LAYER                                    |
+-----------------------------------------------------------------------------+
|  +-------------+    +-------------+    +-------------+                      |
|  |   Web App   |    |  Mobile App |    |   CLI Tool  |                      |
|  |   (React)   |    |   (Future)  |    |   (Future)  |                      |
|  +------+------+    +------+------+    +------+------+                      |
|         |                  |                  |                              |
|         +------------------+------------------+                              |
|                            |                                                 |
|                    +-------+-------+                                         |
|                    |   REST API    |                                         |
|                    |   (NestJS)    |                                         |
|                    +-------+-------+                                         |
+----------------------------+------------------------------------------------+
                             |
+----------------------------v------------------------------------------------+
|                              API LAYER                                       |
+-----------------------------------------------------------------------------+
|  +----------------+  +----------------+  +----------------+                 |
|  | Auth Module    |  | Messages       |  | Identity       |                 |
|  | - SIWE Pattern |  | - Send/Receive |  | - Key Gen      |                 |
|  | - JWT Sessions |  | - Encrypt/Dec  |  | - Serialization|                 |
|  +----------------+  +----------------+  +----------------+                 |
+----------------------------+------------------------------------------------+
                             |
+----------------------------v------------------------------------------------+
|                              CORE SERVICES                                   |
+-----------------------------------------------------------------------------+
|  +--------------------------------------------------------------------+     |
|  |                        CRYPTO MODULE                                |     |
|  |  +--------------+  +--------------+  +--------------------------+  |     |
|  |  | Identity     |  | Encryption   |  | Double Ratchet           |  |     |
|  |  | Ed25519 +    |  | X25519+HKDF  |  | Forward Secrecy          |  |     |
|  |  | X25519 Keys  |  | ChaCha20     |  | Post-Compromise Security |  |     |
|  |  +--------------+  +--------------+  +--------------------------+  |     |
|  +--------------------------------------------------------------------+     |
|                                                                              |
|  +--------------------------------------------------------------------+     |
|  |                        NETWORK MODULE                               |     |
|  |  +--------------+  +--------------+  +--------------------------+  |     |
|  |  | P2P Node     |  | Connection   |  | Onion Routing            |  |     |
|  |  | libp2p       |  | Pool         |  | Multi-layer Encryption   |  |     |
|  |  | GossipSub    |  | Rate Limit   |  | Anonymous Messaging      |  |     |
|  |  +--------------+  +--------------+  +--------------------------+  |     |
|  +--------------------------------------------------------------------+     |
|                                                                              |
|  +--------------------------------------------------------------------+     |
|  |                        STORAGE MODULE                               |     |
|  |  +--------------+  +--------------+  +--------------------------+  |     |
|  |  | DHT Storage  |  | Local LevelDB|  | Storage Proofs           |  |     |
|  |  | Replication  |  | Message DB   |  | Node Verification        |  |     |
|  |  +--------------+  +--------------+  +--------------------------+  |     |
|  +--------------------------------------------------------------------+     |
+-----------------------------------------------------------------------------+
                             |
+----------------------------v------------------------------------------------+
|                              P2P NETWORK LAYER                               |
+-----------------------------------------------------------------------------+
|                                                                              |
|    +---------+         +---------+         +---------+                      |
|    |  Node A |<------->|  Relay  |<------->|  Node B |                      |
|    | (User)  |         |  Node   |         | (User)  |                      |
|    +----+----+         +----+----+         +----+----+                      |
|         |                   |                   |                            |
|         |    +--------------+--------------+    |                            |
|         |    |      GossipSub PubSub       |    |                            |
|         |    | /chainmail/1.0.0/mail topic |    |                            |
|         |    +-----------------------------+    |                            |
|         |                                       |                            |
|         +---------------------------------------+                            |
|                    mDNS Discovery                                            |
|                    Bootstrap Nodes                                           |
|                                                                              |
+-----------------------------------------------------------------------------+
                             |
+----------------------------v------------------------------------------------+
|                         BLOCKCHAIN LAYER (Optional)                          |
+-----------------------------------------------------------------------------+
|  +------------------+  +------------------+  +------------------+           |
|  | Identity Registry|  | Message Timestamps|  | Name Resolution |           |
|  | On-chain mapping |  | Proof of delivery |  | ENS-like names  |           |
|  +------------------+  +------------------+  +------------------+           |
+-----------------------------------------------------------------------------+
```

### Message Flow

#### Sending a Message

```
+-------------------+                                         +------------------+
|      Sender       |                                         |    Recipient     |
+---------+---------+                                         +--------+---------+
          |                                                            |
          | 1. Compose message                                         |
          |    {subject, body, to}                                     |
          v                                                            |
+---------+---------+                                                  |
| Lookup Registry   | 2. Resolve recipient address                     |
| Get encryption key|    Get encryption public key                     |
+---------+---------+                                                  |
          |                                                            |
          v                                                            |
+---------+---------+                                                  |
| Encrypt Message   | 3. X25519 key exchange                           |
|                   |    ChaCha20-Poly1305 encryption                  |
+---------+---------+                                                  |
          |                                                            |
          v                                                            |
+---------+---------+                                                  |
| Create Envelope   | 4. Create sealed envelope                        |
|                   |    Add routing token, timestamp                  |
+---------+---------+                                                  |
          |                                                            |
          v                                                            |
+---------+---------+    +--------------+    +----------------+        |
| Publish to        |--->|  GossipSub   |--->|  Relay Nodes   |        |
| P2P Network       |    |  Broadcast   |    |  Store Message |        |
+-------------------+    +--------------+    +-------+--------+        |
                                                     |                 |
                                                     |                 |
                                                     v                 v
                                         +---------------------------+
                                         | 5. Match routing token    |
                                         | 6. Decrypt with private   |
                                         |    key                    |
                                         | 7. Display to recipient   |
                                         +---------------------------+
```

#### Authentication Flow (SIWE - Sign-In with Ethereum)

```
+------------+                              +------------+
|   Client   |                              |   Server   |
+-----+------+                              +-----+------+
      |                                           |
      | 1. POST /api/auth/challenge               |
      |   {address: "0x..."}                      |
      |------------------------------------------>|
      |                                           |
      | 2. Returns challenge + message            |
      |   {challenge, message, expiresAt}         |
      |<------------------------------------------|
      |                                           |
      | 3. Sign message with wallet               |
      |   wallet.signMessage(message)             |
      |                                           |
      | 4. POST /api/auth/verify                  |
      |   {challenge, signature, address}         |
      |------------------------------------------>|
      |                                           |
      |                                    5. Verify signature
      |                                       Recover address
      |                                       Create JWT token
      |                                           |
      | 6. Returns session token                  |
      |   {token, chainmailAddress}               |
      |<------------------------------------------|
      |                                           |
      | 7. Use token for API requests             |
      |   Authorization: Bearer <token>           |
      |------------------------------------------>|
      |                                           |
```

### Cryptographic Primitives

| Primitive | Algorithm | Purpose |
|-----------|-----------|---------|
| **Signing Keys** | Ed25519 | Identity verification, message authentication |
| **Encryption Keys** | X25519 | Elliptic curve Diffie-Hellman key exchange |
| **Symmetric Encryption** | ChaCha20-Poly1305 | Authenticated encryption of messages |
| **Key Derivation** | HKDF-SHA256 | Derive shared secrets from key exchange |
| **Hashing** | SHA-256 | Address derivation, message IDs, routing tokens |
| **Address Encoding** | Bech32 | Human-readable addresses with checksum |

### Envelope Types

#### Plain Envelope
Standard message with visible sender and recipient.

```json
{
  "type": "plain",
  "from": "cm1sender...",
  "to": "cm1recipient...",
  "encrypted": {
    "ephemeralPublicKey": "base64...",
    "nonce": "base64...",
    "ciphertext": "base64..."
  },
  "timestamp": 1234567890
}
```

#### Sealed Envelope
Anonymous message where sender identity is hidden.

```json
{
  "type": "sealed",
  "routingToken": "hex-derived-from-recipient-address",
  "encrypted": {
    "ephemeralPublicKey": "base64...",
    "nonce": "base64...",
    "ciphertext": "base64..."
  },
  "timestamp": 1234567890
}
```

---

## Quick Start

### Prerequisites

- **Node.js** >= 18.0.0
- **npm** or **yarn**
- **Git**
- A Web3 wallet (MetaMask, etc.) for authentication

### Installation

```bash
# Clone the repository
git clone https://github.com/blocksharkcom/chainmail-protocol.git
cd chainmail-protocol

# Install API dependencies
cd api
npm install

# Install Web dependencies
cd ../web
npm install
```

### Running the Application

#### Development Mode

**Terminal 1 - API Server:**
```bash
cd api
npm run build
npm run start:prod
```

**Terminal 2 - Web Frontend:**
```bash
cd web
npm run dev
```

The API will be available at `http://localhost:3001` with Swagger docs at `http://localhost:3001/api/docs`.
The web app will be available at `http://localhost:5173`.

#### Using Docker

```bash
# Build and start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down
```

### Configuration

Create a `.env` file in the `api` directory:

```env
# Server Configuration
PORT=3001
CORS_ORIGIN=http://localhost:5173

# Blockchain Configuration (Optional)
BLOCKCHAIN_NETWORK=localhost
BLOCKCHAIN_RPC_URL=http://127.0.0.1:8545
REGISTRY_CONTRACT_ADDRESS=0x...

# P2P Configuration
BOOTSTRAP_NODES=
RELAY_HOSTS=

# Security
JWT_SECRET=your-secret-key
JWT_EXPIRATION=24h
```

### Local-Only Mode

Chainmail automatically falls back to local-only mode when P2P networking is unavailable. This is useful for:
- Development and testing
- Environments where P2P is blocked
- Single-user deployments

In local-only mode:
- Messages are stored in LevelDB at `~/.chainmail/messages/`
- Identity is stored at `~/.chainmail/identity.json`
- All encryption/decryption works normally
- No P2P networking required

---

## API Documentation

### Swagger UI

When the API is running, visit `http://localhost:3001/api/docs` for interactive API documentation.

### Key Endpoints

#### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth/challenge` | Request authentication challenge |
| `POST` | `/api/auth/verify` | Verify signature and get JWT token |
| `GET` | `/api/auth/session` | Get current session info |
| `POST` | `/api/auth/logout` | Invalidate session |

#### Identity

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/identity` | Create new identity |
| `GET` | `/api/identity` | Get current identity |
| `POST` | `/api/identity/load` | Load existing identity |
| `POST` | `/api/identity/lookup` | Look up recipient by address/name |
| `GET` | `/api/identity/node` | Get P2P node info |

#### Messages

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/messages` | Get inbox messages |
| `GET` | `/api/messages/:id` | Get specific message |
| `POST` | `/api/messages` | Send new message |
| `POST` | `/api/messages/encrypted` | Send pre-encrypted message |
| `POST` | `/api/messages/:id/read` | Mark message as read |
| `DELETE` | `/api/messages/:id` | Delete message |

### Example: Sending a Message

```bash
# 1. Create identity
curl -X POST http://localhost:3001/api/identity \
  -H "Content-Type: application/json" \
  -d '{"name": "alice"}'

# Response:
# {
#   "address": "cm1abc123...",
#   "publicKey": "base64...",
#   "encryptionPublicKey": "base64...",
#   "name": "alice",
#   "createdAt": 1234567890
# }

# 2. Send a message
curl -X POST http://localhost:3001/api/messages \
  -H "Content-Type: application/json" \
  -d '{
    "to": "cm1abc123...",
    "subject": "Hello!",
    "body": "This is a test message"
  }'

# Response:
# {
#   "messageId": "abc123...",
#   "timestamp": 1234567890
# }

# 3. Get inbox
curl http://localhost:3001/api/messages

# Response:
# [
#   {
#     "id": "abc123...",
#     "from": "cm1sender...",
#     "to": "cm1recipient...",
#     "subject": "Hello!",
#     "body": "This is a test message",
#     "timestamp": 1234567890,
#     "read": false
#   }
# ]
```

---

## Project Structure

```
chainmail-protocol/
|-- api/                          # NestJS Backend
|   |-- src/
|   |   |-- auth/                 # Wallet authentication (SIWE)
|   |   |   |-- auth.controller.ts
|   |   |   |-- auth.service.ts
|   |   |   +-- auth.module.ts
|   |   |-- crypto/               # Cryptographic services
|   |   |   |-- identity.service.ts
|   |   |   |-- encryption.service.ts
|   |   |   |-- double-ratchet.service.ts
|   |   |   +-- interfaces/
|   |   |-- network/              # P2P networking
|   |   |   |-- p2p-node.service.ts
|   |   |   |-- connection-pool.service.ts
|   |   |   |-- rate-limiter.service.ts
|   |   |   +-- onion-router.service.ts
|   |   |-- messages/             # Message handling
|   |   |   |-- messages.controller.ts
|   |   |   |-- messages.service.ts
|   |   |   +-- identity.controller.ts
|   |   |-- storage/              # DHT & local storage
|   |   |   +-- dht-storage.service.ts
|   |   |-- blockchain/           # Smart contract integration
|   |   |   +-- registry.service.ts
|   |   |-- app.module.ts
|   |   +-- main.ts
|   |-- test/                     # Test files
|   |-- package.json
|   +-- tsconfig.json
|
|-- web/                          # React Frontend
|   |-- src/
|   |   |-- components/           # UI components
|   |   |   +-- ui/               # shadcn/ui components
|   |   |-- pages/                # Page components
|   |   |   +-- LoginPage.tsx
|   |   |-- lib/                  # Utilities
|   |   |   +-- api.ts            # API client
|   |   |-- store/                # State management
|   |   +-- App.tsx
|   |-- package.json
|   +-- vite.config.ts
|
|-- contracts/                    # Solidity smart contracts (optional)
|   |-- ChainmailRegistry.sol
|   +-- ...
|
|-- docker-compose.yml
+-- README.md
```

---

## Security

### Threat Model

Chainmail Protocol is designed to protect against:

- **Passive Network Surveillance** - All messages are encrypted end-to-end
- **Server Compromise** - Keys are stored client-side only
- **Man-in-the-Middle** - Signature verification prevents tampering
- **Metadata Analysis** - Sealed envelopes hide sender identity
- **Future Key Compromise** - Forward secrecy protects past messages

### Security Best Practices

1. **Backup Your Identity** - Export and securely store your identity file (`~/.chainmail/identity.json`)
2. **Verify Recipients** - Confirm addresses through a trusted channel before sending sensitive messages
3. **Keep Software Updated** - Run the latest version for security patches
4. **Use Hardware Wallets** - For highest security, use a hardware wallet for authentication

### Cryptographic Details

| Component | Algorithm | Key Size |
|-----------|-----------|----------|
| Identity Signing | Ed25519 | 256-bit |
| Key Exchange | X25519 (ECDH) | 256-bit |
| Message Encryption | ChaCha20-Poly1305 | 256-bit |
| Key Derivation | HKDF-SHA256 | Variable |
| Address Hashing | SHA-256 | 256-bit |

### Reporting Vulnerabilities

If you discover a security vulnerability, please report it responsibly. Do not open public issues for security problems.

---

## Testing

```bash
# Run unit tests
cd api
npm run test

# Run e2e tests
npm run test:e2e

# Run with coverage
npm run test:cov

# Run specific test file
npm run test -- --testPathPattern=identity
```

---

## Roadmap

### Completed

- [x] Core messaging with E2E encryption
- [x] Wallet-based authentication (SIWE)
- [x] Local-only mode (works without P2P)
- [x] NestJS API with Swagger documentation
- [x] React web frontend with wallet connection
- [x] In-memory registry for local development
- [x] Multi-user identity management (per-wallet identities)
- [x] Persistent read/unread status tracking
- [x] Reply functionality with auto-populated recipients

### Phase 1: SMTP Gateway - Decentralized Email Bridge

Enable receiving emails from traditional email providers (Gmail, Outlook, etc.) to Chainmail addresses.

- [ ] **Inbound SMTP Server** - Run SMTP server on port 25/587 to receive external emails
- [ ] **MX Record Configuration** - DNS setup guide for `@chainmail.network` or custom domains
- [ ] **Email-to-Chainmail Bridge** - Parse incoming SMTP emails, encrypt with recipient's public key, deliver to inbox
- [ ] **SPF/DKIM/DMARC Verification** - Validate sender authenticity for inbound emails
- [ ] **Spam Filtering** - Basic spam detection before encryption and delivery
- [ ] **Outbound SMTP Relay** - Send emails from Chainmail to traditional email addresses (optional, requires sender verification)

### Phase 2: P2P Network Infrastructure

Build robust decentralized infrastructure for message relay and storage.

- [ ] **Bootstrap Node Registry** - On-chain registry of reliable bootstrap nodes with staking
- [ ] **Node Onboarding Flow** - Simplified setup for running a Chainmail relay node
- [ ] **Storage Proof Verification** - Cryptographic proofs that nodes are storing messages correctly
- [ ] **Proof-of-Storage Rewards** - Incentive mechanism for nodes providing reliable storage
- [ ] **Node Reputation System** - Track uptime, delivery success rate, and reliability scores
- [ ] **Geographic Distribution** - Encourage node diversity across regions for resilience

### Phase 3: Enhanced Messaging Features

- [ ] **Encrypted File Attachments** - Encrypt files with same E2E encryption, store on IPFS/Arweave
- [ ] **Attachment Size Limits** - Configurable limits with chunked upload for large files
- [ ] **Message Threading** - Conversation view with proper reply chains
- [ ] **Contact Management** - Address book with nicknames and verified contacts
- [ ] **Group Messaging** - Encrypted group conversations with key rotation
- [ ] **Message Search** - Client-side search of decrypted message content

### Phase 4: Web UI Improvements

- [ ] **Dark Mode** - System-aware theme switching
- [ ] **Keyboard Shortcuts** - Power user navigation (j/k, r, c, etc.)
- [ ] **Rich Text Editor** - Markdown support with preview
- [ ] **Drag & Drop Attachments** - Easy file attachment workflow
- [ ] **Notification System** - Browser notifications for new messages
- [ ] **Mobile Responsive** - Full mobile browser support

### Phase 5: Protocol Enhancements

- [ ] **ENS Integration** - Send to `name.eth` addresses
- [ ] **Multi-Chain Support** - Polygon, Arbitrum, Base wallet authentication
- [ ] **Message Expiration** - Self-destructing messages with configurable TTL
- [ ] **Read Receipts** - Optional encrypted delivery/read confirmations
- [ ] **Offline Queue** - Queue messages when recipient is offline, deliver when online

### Future Considerations

- [ ] CLI tool for power users and automation
- [ ] Browser extension for quick compose
- [ ] Hardware wallet message signing
- [ ] Zero-knowledge proofs for sender privacy
- [ ] Decentralized identity (DID) integration

---

## Contributing

We welcome contributions! Here's how to get started:

### Development Setup

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run tests: `npm test`
5. Commit with conventional commits: `git commit -m "feat: add new feature"`
6. Push and open a Pull Request

### Code Style

- TypeScript strict mode enabled
- ESLint + Prettier for formatting
- Conventional Commits for commit messages

### Areas for Contribution

- Mobile app development (React Native)
- Browser extension
- CLI improvements
- Documentation
- Test coverage
- Performance optimization
- Internationalization

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## FAQ

### Q: Do I need a blockchain to use Chainmail?
**A:** No! Chainmail works completely without blockchain. The blockchain integration is optional and provides additional features like name registration and message timestamping.

### Q: What happens if I lose my identity file?
**A:** Your identity file contains your private keys. If you lose it, you won't be able to decrypt messages or access your Chainmail address. Always backup `~/.chainmail/identity.json`.

### Q: Can I run Chainmail on a server?
**A:** Yes! Chainmail can run in headless mode on a server. Use the API directly or set up a relay node to help the network.

### Q: Is Chainmail encrypted?
**A:** Yes, Chainmail uses end-to-end encryption. Messages are encrypted with the recipient's public key before leaving your device. Only the recipient can decrypt them.

### Q: How does wallet authentication work?
**A:** Chainmail uses the "Sign-In with Ethereum" (SIWE) pattern. Your wallet signs a challenge message, and this signature proves you own the wallet address. No passwords needed!

---

<div align="center">

## Need Custom Blockchain Development?

<p>
  <strong>Looking for enterprise solutions or custom blockchain development?</strong>
</p>

<p>
  <strong>BlockShark</strong> specializes in blockchain development, decentralized applications, and Web3 infrastructure.
  We can help you with:
</p>

<table>
  <tr>
    <td align="center" width="50%">
      <h4>Custom Blockchain Development</h4>
      Build your own L1/L2 blockchain or customize existing networks for your specific use case
    </td>
    <td align="center" width="50%">
      <h4>Smart Contract Development</h4>
      Secure, audited smart contracts for DeFi, NFTs, DAOs, and enterprise applications
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <h4>dApp Development</h4>
      Full-stack decentralized applications with modern frameworks and best practices
    </td>
    <td align="center" width="50%">
      <h4>Enterprise Web3 Solutions</h4>
      Private networks, tokenization, supply chain, and digital identity solutions
    </td>
  </tr>
</table>

<br/>

<p>
  <a href="https://blockshark.com/contact-us">
    <img src="https://img.shields.io/badge/Contact%20BlockShark-Get%20a%20Free%20Consultation-0066CC?style=for-the-badge&logo=ethereum&logoColor=white" alt="Contact BlockShark"/>
  </a>
</p>

<p>
  <a href="https://blockshark.com">blockshark.com</a> &bull;
  <a href="https://blockshark.com/contact-us">Contact Us</a> &bull;
  <a href="mailto:info@blockshark.com">info@blockshark.com</a> &bull;
  <a href="https://t.me/blocksharkcom">Telegram</a>
</p>

<p>
  <em>From concept to mainnet - we build blockchain solutions that scale.</em>
</p>

</div>

---

<p align="center">
  <strong>Chainmail Protocol</strong> - Blockchain email with end-to-end encryption. No servers. No tracking. No compromises.
</p>

<p align="center">
  Made with care by the BlockShark Team
</p>
