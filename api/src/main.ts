import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';

const SYSTEM_DESIGN_DESCRIPTION = `
# Chainmail Protocol - Blockchain Email with P2P Encryption

## System Architecture

\`\`\`
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT LAYER                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                      │
│  │   Web App   │    │  Mobile App │    │   CLI Tool  │                      │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘                      │
│         │                  │                  │                              │
│         └──────────────────┼──────────────────┘                              │
│                            ▼                                                 │
│                    ┌───────────────┐                                         │
│                    │   REST API    │                                         │
│                    └───────┬───────┘                                         │
└────────────────────────────┼────────────────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              API LAYER (NestJS)                              │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐                 │
│  │ Auth Module    │  │ Messages       │  │ Identity       │                 │
│  │ - Challenge    │  │ - Send/Receive │  │ - Generate     │                 │
│  │ - Verify       │  │ - Encrypt      │  │ - Serialize    │                 │
│  │ - Sessions     │  │ - Decrypt      │  │ - Validate     │                 │
│  └────────────────┘  └────────────────┘  └────────────────┘                 │
└────────────────────────────┼────────────────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CORE SERVICES                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │                        CRYPTO MODULE                                │     │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │     │
│  │  │ Identity     │  │ Encryption   │  │ Double Ratchet           │  │     │
│  │  │ Ed25519      │  │ X25519+HKDF  │  │ Forward Secrecy          │  │     │
│  │  │ X25519       │  │ ChaCha20     │  │ Post-Compromise Security │  │     │
│  │  └──────────────┘  └──────────────┘  └──────────────────────────┘  │     │
│  └────────────────────────────────────────────────────────────────────┘     │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │                        NETWORK MODULE                               │     │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │     │
│  │  │ P2P Node     │  │ Connection   │  │ Onion Routing            │  │     │
│  │  │ libp2p       │  │ Pool         │  │ Multi-layer Encryption   │  │     │
│  │  │ GossipSub    │  │ Rate Limit   │  │ Anonymous Messaging      │  │     │
│  │  └──────────────┘  └──────────────┘  └──────────────────────────┘  │     │
│  └────────────────────────────────────────────────────────────────────┘     │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │                        STORAGE MODULE                               │     │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │     │
│  │  │ DHT Storage  │  │ Local LevelDB│  │ Storage Proofs           │  │     │
│  │  │ Replication  │  │ Message DB   │  │ Node Verification        │  │     │
│  │  └──────────────┘  └──────────────┘  └──────────────────────────┘  │     │
│  └────────────────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              P2P NETWORK LAYER                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│    ┌─────────┐         ┌─────────┐         ┌─────────┐                      │
│    │  Node A │◄───────►│  Relay  │◄───────►│  Node B │                      │
│    │ (User)  │         │  Node   │         │ (User)  │                      │
│    └────┬────┘         └────┬────┘         └────┬────┘                      │
│         │                   │                   │                            │
│         │    ┌──────────────┴──────────────┐    │                            │
│         │    │      GossipSub PubSub       │    │                            │
│         │    │ /chainmail/1.0.0/mail topic │    │                            │
│         │    └─────────────────────────────┘    │                            │
│         │                                       │                            │
│         └───────────────────────────────────────┘                            │
│                    mDNS Discovery                                            │
│                    Bootstrap Nodes                                           │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
\`\`\`

## Message Flow

### 1. Sending a Message (End-to-End Encrypted)

\`\`\`
Sender                          Network                         Recipient
  │                                │                                │
  │ 1. Encrypt with recipient's   │                                │
  │    X25519 public key          │                                │
  │    ─────────────────►         │                                │
  │                               │                                │
  │ 2. Create sealed envelope     │                                │
  │    with routing token         │                                │
  │    ─────────────────►         │                                │
  │                               │                                │
  │ 3. Publish to GossipSub       │                                │
  │    ═══════════════════════════►                                │
  │                               │                                │
  │                               │ 4. Broadcast to all peers      │
  │                               │ ════════════════════════════════►
  │                               │                                │
  │                               │ 5. Store on relay nodes        │
  │                               │ (for offline delivery)         │
  │                               │                                │
  │                               │              6. Match routing  │
  │                               │                 token & decrypt│
  │                               │                 ◄───────────────
\`\`\`

### 2. Sealed Envelope (Anonymous Messaging)

\`\`\`json
{
  "type": "sealed",
  "routingToken": "derived-from-recipient-address",
  "encrypted": {
    "ephemeralPublicKey": "base64...",
    "nonce": "base64...",
    "ciphertext": "base64..."
  },
  "timestamp": 1234567890
}
\`\`\`

## Security Features

| Feature | Implementation | Purpose |
|---------|---------------|---------|
| **Identity** | Ed25519 signing keys | Authenticate messages |
| **Encryption** | X25519 + ChaCha20-Poly1305 | End-to-end encryption |
| **Key Exchange** | ECDH + HKDF | Derive shared secrets |
| **Forward Secrecy** | Double Ratchet Protocol | Protect past messages |
| **Anonymity** | Sealed Envelopes | Hide sender identity |
| **Privacy** | Onion Routing | Hide message path |
| **Address Format** | Bech32 (cm1...) | Human-readable addresses |

## Key Cryptographic Primitives

- **Ed25519**: Digital signatures (identity verification)
- **X25519**: Elliptic curve Diffie-Hellman (key exchange)
- **ChaCha20-Poly1305**: Authenticated encryption
- **HKDF-SHA256**: Key derivation function
- **SHA256**: Hashing (address derivation, message IDs)

## API Authentication Flow

\`\`\`
1. Client requests challenge:     POST /api/auth/challenge
2. Server returns challenge:      { challenge: "...", message: "..." }
3. Client signs with wallet:      wallet.signMessage(message)
4. Client verifies signature:     POST /api/auth/verify
5. Server returns session token:  { token: "...", address: "0x..." }
6. Client uses token for requests: Authorization: Bearer <token>
\`\`\`

## P2P Protocols

| Protocol | Path | Purpose |
|----------|------|---------|
| Global Mail | \`/chainmail/1.0.0/mail\` | GossipSub topic for all messages |
| Fetch | \`/chainmail/fetch/1.0.0\` | Retrieve stored messages |
| DHT Store | \`/chainmail/storage/1.0.0/store\` | Store messages on relay |
| DHT Fetch | \`/chainmail/storage/1.0.0/fetch\` | Fetch from DHT storage |

---
`;

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Enable CORS
  app.enableCors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Swagger documentation
  const config = new DocumentBuilder()
    .setTitle('Chainmail Protocol API')
    .setDescription(SYSTEM_DESIGN_DESCRIPTION)
    .setVersion('1.0')
    .addBearerAuth()
    .addTag('auth', 'Wallet-based authentication using SIWE pattern')
    .addTag('identity', 'Generate and manage Chainmail identities (Ed25519 + X25519 keys)')
    .addTag('messages', 'Send and receive end-to-end encrypted messages')
    .addTag('node', 'P2P node status and management')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT || 3001;
  await app.listen(port);

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                  Chainmail Protocol API                       ║
╠═══════════════════════════════════════════════════════════════╣
║  Status:  Running                                             ║
║  Port:    ${port.toString().padEnd(52)}║
║  Docs:    http://localhost:${port}/api/docs                       ║
╚═══════════════════════════════════════════════════════════════╝
  `);
}

bootstrap();
