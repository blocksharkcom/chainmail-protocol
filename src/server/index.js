/**
 * dMail API Server
 *
 * Provides REST API and WebSocket connections for the frontend.
 * Handles identity management, message sending/receiving, and P2P network status.
 */

import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { Identity, IdentityStore } from '../crypto/identity.js';
import { WalletIdentity, createVerificationChallenge } from '../crypto/wallet-identity.js';
import { DMailNode } from '../network/node.js';
import { createMessage, parseMessage } from '../protocol/message.js';
import { addressToPublicKey } from '../crypto/identity.js';
import { SMTPGateway } from '../gateway/smtp-gateway.js';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(cors());
app.use(express.json());

// Global state
let identity = null;
let node = null;
let store = null;
let gateway = null;
const wsClients = new Set();

// Broadcast to all WebSocket clients
function broadcast(type, data) {
  const message = JSON.stringify({ type, data, timestamp: Date.now() });
  wsClients.forEach(client => {
    if (client.readyState === 1) { // OPEN
      client.send(message);
    }
  });
}

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  wsClients.add(ws);

  // Send current state
  ws.send(JSON.stringify({
    type: 'init',
    data: {
      identity: identity ? { address: identity.address } : null,
      isOnline: node !== null,
      peerCount: node ? node.getPeerCount() : 0
    }
  }));

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log('WebSocket client disconnected');
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Get current identity
app.get('/api/identity', async (req, res) => {
  try {
    if (!identity) {
      return res.json({ identity: null });
    }
    res.json({
      identity: {
        address: identity.address,
        publicKey: Buffer.from(identity.publicKey).toString('hex'),
        encryptionPublicKey: Buffer.from(identity.encryptionPublicKey).toString('hex')
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create new identity
app.post('/api/identity', async (req, res) => {
  try {
    const { name = 'default' } = req.body;

    // Check if identity exists
    if (!store) {
      store = new IdentityStore();
    }

    let existing = await store.getIdentity(name);
    if (existing) {
      identity = existing;
      return res.json({
        identity: {
          address: identity.address,
          publicKey: Buffer.from(identity.publicKey).toString('hex'),
          isNew: false
        }
      });
    }

    // Generate new identity
    identity = Identity.generate();
    await store.saveIdentity(name, identity);

    broadcast('identity_created', { address: identity.address });

    res.json({
      identity: {
        address: identity.address,
        publicKey: Buffer.from(identity.publicKey).toString('hex'),
        isNew: true
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List all identities
app.get('/api/identities', async (req, res) => {
  try {
    if (!store) {
      store = new IdentityStore();
    }
    const identities = await store.listIdentities();
    res.json({ identities });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get challenge for wallet authentication
app.get('/api/auth/challenge', (req, res) => {
  const challenge = createVerificationChallenge();
  res.json(challenge);
});

// Authenticate with wallet signature
app.post('/api/auth/wallet', async (req, res) => {
  try {
    const { signature, walletAddress, timestamp } = req.body;

    if (!signature || !walletAddress || !timestamp) {
      return res.status(400).json({ error: 'Missing signature, walletAddress, or timestamp' });
    }

    // Create identity from wallet signature
    identity = WalletIdentity.fromSignature(signature, walletAddress, timestamp);

    // Store the identity
    if (!store) {
      store = new IdentityStore();
    }
    await store.saveIdentity(`wallet:${walletAddress.toLowerCase()}`, identity);

    broadcast('identity_created', {
      address: identity.address,
      walletAddress: identity.walletAddress
    });

    res.json({
      success: true,
      identity: {
        address: identity.address,
        publicKey: Buffer.from(identity.publicKey).toString('hex'),
        encryptionPublicKey: Buffer.from(identity.encryptionPublicKey).toString('hex'),
        walletAddress: identity.walletAddress
      }
    });
  } catch (error) {
    console.error('Wallet auth error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Start P2P node
app.post('/api/node/start', async (req, res) => {
  try {
    if (!identity) {
      return res.status(400).json({ error: 'No identity loaded. Create one first.' });
    }

    if (node && node.node) {
      return res.json({ status: 'already_running', peerCount: node.getPeerCount() });
    }

    node = new DMailNode(identity);
    await node.start(req.body.port || 0);

    if (!node.node) {
      throw new Error('Failed to initialize P2P node');
    }

    // Handle incoming messages
    node.onMessage('api', async (envelope) => {
      try {
        const message = await parseMessage(identity, envelope);
        broadcast('new_message', {
          id: message.id,
          from: message.from,
          subject: message.subject,
          timestamp: message.timestamp,
          preview: message.body.slice(0, 100)
        });
      } catch (e) {
        console.error('Failed to parse message:', e.message);
      }
    });

    // Broadcast peer count updates
    setInterval(() => {
      if (node && node.node) {
        broadcast('peer_update', { peerCount: node.getPeerCount() });
      }
    }, 5000);

    res.json({
      status: 'started',
      address: identity.address,
      peerId: node.node.peerId.toString(),
      multiaddrs: node.node.getMultiaddrs().map(a => a.toString())
    });
  } catch (error) {
    console.error('Node start error:', error);
    node = null;
    res.status(500).json({ error: error.message });
  }
});

// Stop P2P node
app.post('/api/node/stop', async (req, res) => {
  try {
    if (node) {
      await node.stop();
      node = null;
      broadcast('node_stopped', {});
    }
    res.json({ status: 'stopped' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get node status
app.get('/api/node/status', (req, res) => {
  if (!node || !node.node) {
    return res.json({ status: 'stopped', peerCount: 0 });
  }
  res.json({
    status: 'running',
    peerCount: node.getPeerCount(),
    address: identity?.address,
    peerId: node.node.peerId.toString(),
    multiaddrs: node.node.getMultiaddrs().map(a => a.toString())
  });
});

// Get inbox messages
app.get('/api/messages', async (req, res) => {
  try {
    if (!node) {
      return res.json({ messages: [] });
    }

    const messages = await node.getInbox();
    const parsed = [];

    for (const msg of messages) {
      try {
        const decrypted = await parseMessage(identity, msg);
        parsed.push({
          id: msg.id,
          from: decrypted.from,
          to: decrypted.to,
          subject: decrypted.subject,
          body: decrypted.body,
          timestamp: decrypted.timestamp,
          read: msg.read,
          starred: msg.starred || false,
          encrypted: true,
          verified: true
        });
      } catch (e) {
        // Include raw message if decryption fails
        parsed.push({
          id: msg.id,
          from: msg.from,
          to: msg.to,
          subject: '[Encrypted]',
          body: 'Unable to decrypt message',
          timestamp: msg.timestamp,
          read: msg.read,
          starred: msg.starred || false,
          encrypted: true,
          verified: false,
          error: e.message
        });
      }
    }

    res.json({ messages: parsed });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single message
app.get('/api/messages/:id', async (req, res) => {
  try {
    if (!node) {
      return res.status(400).json({ error: 'Node not running' });
    }

    const msg = await node.getMessage(req.params.id);
    if (!msg) {
      return res.status(404).json({ error: 'Message not found' });
    }

    await node.markAsRead(req.params.id);

    const decrypted = await parseMessage(identity, msg);
    res.json({
      message: {
        id: req.params.id,
        ...decrypted,
        read: true,
        starred: msg.starred || false,
        encrypted: true,
        verified: true
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send message
app.post('/api/messages', async (req, res) => {
  try {
    if (!node) {
      return res.status(400).json({ error: 'Node not running. Start the node first.' });
    }

    const { to, subject, body } = req.body;

    if (!to) {
      return res.status(400).json({ error: 'Recipient address required' });
    }

    // Get recipient's public key
    let recipientKey;
    try {
      recipientKey = addressToPublicKey(to);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid recipient address' });
    }

    // Build the message
    const builder = createMessage(identity)
      .to(to)
      .subject(subject || '(no subject)')
      .body(body || '');

    console.log('Building encrypted message...');
    const envelope = await builder.build(recipientKey);
    console.log('Proof of work completed');

    // Send via P2P network
    const messageId = await node.sendMessage(envelope);

    // Store in sent folder
    const sentMessage = {
      id: messageId,
      from: identity.address,
      to,
      subject: subject || '(no subject)',
      body: body || '',
      timestamp: Date.now(),
      folder: 'sent'
    };

    broadcast('message_sent', sentMessage);

    res.json({
      success: true,
      messageId,
      message: sentMessage
    });
  } catch (error) {
    console.error('Send error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete message
app.delete('/api/messages/:id', async (req, res) => {
  try {
    if (!node) {
      return res.status(400).json({ error: 'Node not running' });
    }
    await node.deleteMessage(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Star/unstar message
app.patch('/api/messages/:id/star', async (req, res) => {
  try {
    if (!node) {
      return res.status(400).json({ error: 'Node not running' });
    }

    const msg = await node.getMessage(req.params.id);
    if (!msg) {
      return res.status(404).json({ error: 'Message not found' });
    }

    msg.starred = !msg.starred;
    await node.db.put(`inbox:${req.params.id}`, msg);

    res.json({ success: true, starred: msg.starred });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ SMTP GATEWAY ENDPOINTS ============

// Register a legacy email address for your dMail
app.post('/api/gateway/register', async (req, res) => {
  try {
    if (!identity) {
      return res.status(400).json({ error: 'No identity loaded' });
    }

    const { localPart } = req.body;
    if (!localPart || !/^[a-z0-9._-]+$/i.test(localPart)) {
      return res.status(400).json({ error: 'Invalid email local part' });
    }

    // Initialize gateway if needed
    if (!gateway) {
      gateway = new SMTPGateway({
        dmailNode: node,
        gatewayIdentity: identity
      });
    }

    const email = await gateway.registerAddress(localPart, identity.address);

    res.json({
      success: true,
      legacyEmail: email,
      dmailAddress: identity.address,
      note: 'Configure DNS MX records to point to the gateway server to receive emails'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List registered gateway addresses
app.get('/api/gateway/addresses', async (req, res) => {
  try {
    if (!gateway) {
      return res.json({ addresses: [] });
    }
    const addresses = await gateway.listAddresses();
    res.json({ addresses });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start SMTP gateway (requires elevated privileges for port 25)
app.post('/api/gateway/start', async (req, res) => {
  try {
    if (!identity) {
      return res.status(400).json({ error: 'No identity loaded' });
    }

    if (gateway) {
      return res.json({ status: 'already_running' });
    }

    gateway = new SMTPGateway({
      dmailNode: node,
      gatewayIdentity: identity,
      domain: req.body.domain || process.env.GATEWAY_DOMAIN || 'dmail.network'
    });

    await gateway.start();

    res.json({
      status: 'started',
      domain: gateway.domain,
      note: 'SMTP gateway running. Configure DNS MX records to receive external emails.'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                    dMail API Server                       ║
╠═══════════════════════════════════════════════════════════╣
║  REST API:    http://localhost:${PORT}/api                  ║
║  WebSocket:   ws://localhost:${PORT}/ws                     ║
║  Health:      http://localhost:${PORT}/health               ║
╚═══════════════════════════════════════════════════════════╝

Endpoints:
  POST   /api/identity          Create/load identity
  GET    /api/identity          Get current identity
  POST   /api/node/start        Start P2P node
  POST   /api/node/stop         Stop P2P node
  GET    /api/node/status       Get node status
  GET    /api/messages          List inbox messages
  POST   /api/messages          Send a message
  GET    /api/messages/:id      Get single message
  DELETE /api/messages/:id      Delete message
`);
});

export { app, server };
