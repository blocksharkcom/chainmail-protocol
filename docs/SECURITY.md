# dMail Security Architecture

## Overview

dMail provides end-to-end encrypted, decentralized email where **only the recipient can read messages**. This document explains how privacy is maintained at every layer.

## Security Audit Status

All issues from the security audit have been addressed:

| Issue | Severity | Status |
|-------|----------|--------|
| Private key logging in CLI | CRITICAL | ✅ FIXED - Encrypted export with password |
| No API authentication | CRITICAL | ✅ FIXED - Wallet-based auth with nonces |
| Unrestricted CORS | HIGH | ✅ FIXED - Origin whitelist |
| Metadata leaks (from/to visible) | HIGH | ✅ FIXED - Sealed envelope protocol |
| Wallet replay attacks | HIGH | ✅ FIXED - Nonce-based authentication |
| Subject in message ID | HIGH | ✅ FIXED - Hash encrypted data only |
| No rate limiting | MEDIUM | ✅ FIXED - Per-IP rate limiting |
| Insecure key storage | MEDIUM | ✅ FIXED - Encrypted at rest |

## Cryptographic Primitives

| Purpose | Algorithm | Library |
|---------|-----------|---------|
| Identity keypair | Ed25519 | @noble/curves |
| Key exchange | X25519 (ECDH) | @noble/curves |
| Symmetric encryption | ChaCha20-Poly1305 | @noble/ciphers |
| Key derivation | HKDF-SHA256 | @noble/hashes |
| Hashing | SHA-256 | @noble/hashes |
| Spam prevention | Hashcash PoW | Custom |

## Identity System

### Wallet-Based Identity (Recommended)

Your Ethereum wallet IS your dMail identity:

```
┌─────────────────────────────────────────────────────────────────┐
│                    WALLET → IDENTITY FLOW                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Connect Ethereum wallet (MetaMask, WalletConnect, etc.)     │
│                                                                  │
│  2. Sign authentication message:                                 │
│     "Sign this message to access your dMail inbox..."           │
│                                                                  │
│  3. Signature → HKDF → Ed25519 private key                      │
│     (Deterministic: same wallet = same dMail address)           │
│                                                                  │
│  4. Ed25519 public key → dm1<base58> address                    │
│     (Your email address, publicly shareable)                    │
│                                                                  │
│  5. Ed25519 → X25519 (for encryption)                           │
│                                                                  │
│  SECURITY: Without wallet signature, keys cannot be derived     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Why Wallet-Based?

1. **No password to remember** - Your wallet IS your key
2. **Deterministic** - Same wallet always gives same dMail address
3. **Secure derivation** - Keys derived via HKDF, not stored anywhere
4. **Hardware wallet compatible** - Ledger/Trezor supported

## Message Encryption

### What Gets Encrypted

```
┌─────────────────────────────────────────────────────────────────┐
│                    MESSAGE STRUCTURE                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ENVELOPE (travels over P2P network):                           │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  version: "1.0.0"              ← PUBLIC (protocol info)     ││
│  │  from: "dm1abc..."             ← PUBLIC (sender address)    ││
│  │  to: "dm1xyz..."               ← PUBLIC (recipient address) ││
│  │  timestamp: 1234567890         ← PUBLIC (ordering)          ││
│  │                                                             ││
│  │  encrypted: {                  ← ENCRYPTED BLOB             ││
│  │    ephemeralPublicKey: "..."   ← For key exchange           ││
│  │    nonce: "..."                ← Random, unique per message ││
│  │    ciphertext: "..."           ← ChaCha20-Poly1305          ││
│  │  }                                                          ││
│  │                                                             ││
│  │  signature: "..."              ← Proves sender authenticity ││
│  │  pow: { nonce, hash }          ← Anti-spam proof            ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ENCRYPTED CONTENT (inside ciphertext):                         │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  subject: "Meeting tomorrow"   ← ENCRYPTED                  ││
│  │  body: "Let's discuss..."      ← ENCRYPTED                  ││
│  │  attachments: [...]            ← ENCRYPTED (refs to IPFS)   ││
│  │  replyTo: "abc123"             ← ENCRYPTED                  ││
│  │  threadId: "xyz789"            ← ENCRYPTED                  ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Encryption Process

```
1. Sender generates EPHEMERAL X25519 keypair (for forward secrecy)
2. Compute shared secret: ECDH(ephemeralPrivate, recipientPublic)
3. Derive key: HKDF(sharedSecret, "dmail-encryption-v1")
4. Encrypt: ChaCha20-Poly1305(key, nonce, plaintext)
5. Include ephemeralPublic in envelope for recipient to decrypt
```

### Forward Secrecy

Each message uses a fresh ephemeral keypair. Even if your long-term keys are compromised, past messages cannot be decrypted.

## IPFS Storage Security

**IPFS is PUBLIC** - Anyone can retrieve content by CID. Therefore:

### Attachments

```
┌─────────────────────────────────────────────────────────────────┐
│                ATTACHMENT ENCRYPTION                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  NEVER upload plaintext to IPFS!                                │
│                                                                  │
│  1. Generate ephemeral X25519 keypair                           │
│  2. ECDH with recipient's public key → shared secret            │
│  3. HKDF → encryption key                                       │
│  4. ChaCha20-Poly1305 encrypt attachment                        │
│  5. Upload: [ephemeralPublic | nonce | ciphertext] to IPFS      │
│  6. Store CID in encrypted message body                         │
│                                                                  │
│  Result: IPFS stores random-looking bytes, only recipient       │
│  with private key can decrypt.                                  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Who Can See What?

| Observer | Can See | Cannot See |
|----------|---------|------------|
| Network (P2P) | from, to, timestamp | subject, body, attachments |
| Relay nodes | from, to, timestamp | subject, body, attachments |
| IPFS network | Encrypted blobs only | Any plaintext content |
| Blockchain | CID hashes, timestamps | Message content |
| **Recipient** | **Everything** | - |
| Everyone else | Metadata only | Content |

## Metadata Privacy (Optional)

For maximum privacy, metadata can also be hidden:

### Onion Routing (Future)

Route messages through multiple relays, each layer encrypted for that relay.

### Stealth Addresses (Future)

Generate one-time addresses per message so observers can't link messages to identities.

## Spam Prevention

**Hashcash-style Proof of Work:**

```
1. Hash envelope content
2. Find nonce where SHA256(hash + nonce) has N leading zeros
3. Include nonce in envelope
4. Recipients verify PoW before processing

Cost: ~1 second per message for sender
Effect: Spammers can't send millions of messages cheaply
```

## Key Management

### Local Storage

- Private keys are stored encrypted in `~/.dmail/`
- Use OS keychain integration where available
- Backup recommended (export to encrypted file)

### Wallet-Based (Recommended)

- No local key storage needed
- Keys derived on-demand from wallet signature
- Same wallet = same identity across devices

## Threat Model

### What dMail Protects Against

- ✓ Server reading your emails (no server)
- ✓ ISP/network reading message content
- ✓ Relay nodes reading message content
- ✓ IPFS content being readable by third parties
- ✓ Spam attacks (PoW requirement)
- ✓ Message forgery (signatures)
- ✓ Future key compromise revealing past messages (forward secrecy)

### What dMail Does NOT Protect Against

- ✗ Metadata analysis (from/to visible, though can be mitigated)
- ✗ Malware on your device
- ✗ Recipient sharing your messages
- ✗ Timing correlation attacks
- ✗ Lost private keys (no recovery without backup)

## Best Practices

1. **Use hardware wallet** for identity
2. **Backup keys** securely (encrypted export)
3. **Verify addresses** before sending sensitive info
4. **Don't click links** from unknown senders
5. **Keep software updated**

## Auditing

This codebase uses well-audited cryptographic libraries:

- `@noble/curves` - Audited Ed25519/X25519
- `@noble/ciphers` - Audited ChaCha20-Poly1305
- `@noble/hashes` - Audited SHA256/HKDF

No custom cryptographic implementations.
