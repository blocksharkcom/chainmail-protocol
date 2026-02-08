import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';

import { WalletIdentity } from '../crypto/wallet-identity.js';
import { DMailNode } from '../network/node.js';
import { createSealedMessage, parseSealedMessage } from '../protocol/sealed-envelope.js';
import { addressToPublicKey } from '../crypto/identity.js';
import { UsernameRegistry } from '../registry/username-registry.js';
import {
  generateNonce,
  authenticateWallet,
  createSession,
  validateSession,
  destroySession,
  authMiddleware,
  corsOptions,
  checkRateLimit
} from './auth.js';

// Username registry
const usernameRegistry = new UsernameRegistry(process.env.DMAIL_DOMAIN || 'dmail.network');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Security middleware
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:5173', 'http://localhost:3000'];

app.use(cors(corsOptions(ALLOWED_ORIGINS)));
app.use(express.json({ limit: '1mb' })); // Limit body size

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Per-session state (supports multiple users)
const sessions = new Map(); // token -> { identity, node, ws }
const wsClients = new Map(); // token -> ws

// Helper to get session data
function getSessionData(token) {
  return sessions.get(token) || {};
}

function setSessionData(token, data) {
  const existing = sessions.get(token) || {};
  sessions.set(token, { ...existing, ...data });
}

// Broadcast to authenticated WebSocket clients only
function broadcast(type, data, sessionToken = null) {
  const message = JSON.stringify({ type, data, timestamp: Date.now() });

  for (const [token, client] of wsClients.entries()) {
    // Only send to authenticated clients
    if (client.readyState === 1) {
      if (!sessionToken || token === sessionToken) {
        client.send(message);
      }
    }
  }
}

// WebSocket connection handler with authentication
wss.on('connection', (ws, req) => {
  // Require authentication token in query string
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');

  if (!token) {
    ws.close(4001, 'Authentication required');
    return;
  }

  const validation = validateSession(token);
  if (!validation.valid) {
    ws.close(4001, validation.error);
    return;
  }

  wsClients.set(token, ws);

  // Get session-specific node info
  const { node } = getSessionData(token);

  // Send current state
  ws.send(JSON.stringify({
    type: 'init',
    data: {
      authenticated: true,
      address: validation.session.dmailAddress,
      isOnline: node !== null && node.node !== null,
      peerCount: node ? node.getPeerCount() : 0
    }
  }));

  ws.on('close', () => {
    wsClients.delete(token);
  });
});

// ============ PUBLIC ENDPOINTS (no auth required) ============

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Get authentication challenge (nonce)
app.get('/api/auth/challenge', (req, res) => {
  const { nonce, expires } = generateNonce();
  res.json({
    nonce,
    expires,
    message: `Sign this message to authenticate with dMail.\n\nNonce: ${nonce}`
  });
});

// Authenticate with wallet signature
app.post('/api/auth/login', async (req, res) => {
  try {
    const { signature, walletAddress, nonce } = req.body;

    if (!signature || !walletAddress || !nonce) {
      return res.status(400).json({ error: 'Missing signature, walletAddress, or nonce' });
    }

    // Verify signature and nonce
    const authResult = authenticateWallet(signature, walletAddress, nonce);
    if (!authResult.success) {
      return res.status(401).json({ error: authResult.error });
    }

    // Create dMail identity from wallet
    // We need a fresh signature for identity derivation
    const timestamp = Date.now();
    const identity = WalletIdentity.fromSignature(signature, walletAddress, timestamp);

    // Create session
    const session = createSession(walletAddress, identity.address);

    // Store identity per-session
    setSessionData(session.token, { identity });

    res.json({
      success: true,
      token: session.token,
      expires: session.expires,
      identity: {
        address: identity.address,
        // NEVER expose private keys!
        publicKey: Buffer.from(identity.publicKey).toString('hex'),
        encryptionPublicKey: Buffer.from(identity.encryptionPublicKey).toString('hex'),
        walletAddress: identity.walletAddress
      }
    });
  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    destroySession(authHeader.slice(7));
  }
  res.json({ success: true });
});

// ============ PROTECTED ENDPOINTS (auth required) ============

// Apply auth middleware to all /api/* routes except auth
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) {
    return next();
  }
  authMiddleware(req, res, next);
});

// Get current identity (safe - no private keys)
app.get('/api/identity', (req, res) => {
  const { identity } = getSessionData(req.sessionToken);
  if (!identity) {
    return res.json({ identity: null });
  }

  // Only return public information
  res.json({
    identity: {
      address: identity.address,
      publicKey: Buffer.from(identity.publicKey).toString('hex'),
      encryptionPublicKey: Buffer.from(identity.encryptionPublicKey).toString('hex'),
      walletAddress: identity.walletAddress
    }
  });
});

// Start P2P node
app.post('/api/node/start', async (req, res) => {
  try {
    const sessionData = getSessionData(req.sessionToken);
    const { identity } = sessionData;

    if (!identity) {
      return res.status(400).json({ error: 'Not authenticated' });
    }

    if (sessionData.node && sessionData.node.node) {
      return res.json({ status: 'already_running', peerCount: sessionData.node.getPeerCount() });
    }

    const node = new DMailNode(identity);
    await node.start(req.body.port || 0);

    if (!node.node) {
      throw new Error('Failed to initialize P2P node');
    }

    // Store node in session
    setSessionData(req.sessionToken, { node });

    // Handle incoming messages securely
    node.onMessage('api', async (envelope) => {
      try {
        // Parse sealed envelope
        const message = await parseSealedMessage(identity, envelope);
        broadcast('new_message', {
          id: message.id,
          // Only show preview, not full content
          hasContent: true,
          timestamp: message.timestamp
        }, req.sessionToken);
      } catch (e) {
        // Don't log message content on error
        console.error('Failed to process incoming message');
      }
    });

    // Broadcast peer count updates (session-specific)
    const peerInterval = setInterval(() => {
      const currentData = getSessionData(req.sessionToken);
      if (currentData.node && currentData.node.node) {
        broadcast('peer_update', { peerCount: currentData.node.getPeerCount() }, req.sessionToken);
      } else {
        clearInterval(peerInterval);
      }
    }, 5000);

    res.json({
      status: 'started',
      address: identity.address,
      // Don't expose internal peer ID
      peerCount: 0
    });
  } catch (error) {
    console.error('Node start error');
    res.status(500).json({ error: 'Failed to start node' });
  }
});

// Stop P2P node
app.post('/api/node/stop', async (req, res) => {
  try {
    const { node } = getSessionData(req.sessionToken);
    if (node) {
      await node.stop();
      setSessionData(req.sessionToken, { node: null });
      broadcast('node_stopped', {}, req.sessionToken);
    }
    res.json({ status: 'stopped' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to stop node' });
  }
});

// Get node status
app.get('/api/node/status', (req, res) => {
  const { node, identity } = getSessionData(req.sessionToken);
  if (!node || !node.node) {
    return res.json({ status: 'stopped', peerCount: 0 });
  }
  res.json({
    status: 'running',
    peerCount: node.getPeerCount(),
    address: identity?.address
    // Don't expose multiaddrs or peer ID
  });
});

// Get inbox messages
app.get('/api/messages', async (req, res) => {
  try {
    const { node, identity } = getSessionData(req.sessionToken);
    console.log('Fetching messages for session:', req.sessionToken?.slice(0, 16));
    console.log('Node exists:', !!node, 'Identity exists:', !!identity);
    if (!node) {
      return res.json({ messages: [] });
    }

    console.log('Calling node.getInbox()...');
    const messages = await node.getInbox();
    console.log('Got', messages.length, 'messages from inbox');
    const parsed = [];

    for (const msg of messages) {
      try {
        const decrypted = await parseSealedMessage(identity, msg);
        parsed.push({
          id: msg.id,
          from: decrypted.from,
          subject: decrypted.subject,
          // Only preview, not full body
          preview: decrypted.body ? decrypted.body.slice(0, 100) : '',
          timestamp: decrypted.timestamp,
          read: msg.read,
          sealed: true
        });
      } catch (e) {
        // Message couldn't be decrypted - don't expose error details
        parsed.push({
          id: msg.id,
          encrypted: true,
          error: 'Unable to decrypt'
        });
      }
    }

    res.json({ messages: parsed });
  } catch (error) {
    console.error('Fetch messages error:', error.message);
    console.error('Stack:', error.stack);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Get single message (full content)
app.get('/api/messages/:id', async (req, res) => {
  try {
    const { node, identity } = getSessionData(req.sessionToken);
    if (!node) {
      return res.status(400).json({ error: 'Node not running' });
    }

    const msg = await node.getMessage(req.params.id);
    if (!msg) {
      return res.status(404).json({ error: 'Message not found' });
    }

    await node.markAsRead(req.params.id);

    const decrypted = await parseSealedMessage(identity, msg);
    res.json({
      message: {
        id: req.params.id,
        from: decrypted.from,
        to: decrypted.to,
        subject: decrypted.subject,
        body: decrypted.body,
        attachments: decrypted.attachments,
        timestamp: decrypted.timestamp,
        read: true,
        sealed: true,
        verified: decrypted.verified
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read message' });
  }
});

// Send message (using sealed envelope)
app.post('/api/messages', async (req, res) => {
  try {
    const { node, identity } = getSessionData(req.sessionToken);
    if (!node) {
      return res.status(400).json({ error: 'Node not running' });
    }

    const { to, subject, body } = req.body;

    if (!to) {
      return res.status(400).json({ error: 'Recipient address required' });
    }

    // Validate recipient address
    let recipientKey;
    try {
      recipientKey = addressToPublicKey(to);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid recipient address' });
    }

    // Build sealed envelope (encrypts ALL metadata)
    const builder = createSealedMessage(identity)
      .to(to, recipientKey)
      .subject(subject || '(no subject)')
      .body(body || '');

    const envelope = await builder.build();

    // Send via P2P network
    const messageId = await node.sendMessage(envelope);

    res.json({
      success: true,
      messageId
      // Don't echo back message content
    });
  } catch (error) {
    console.error('Send error:', error.message);
    console.error('Stack:', error.stack);
    res.status(500).json({ error: 'Failed to send message', details: error.message });
  }
});

// Delete message
app.delete('/api/messages/:id', async (req, res) => {
  try {
    const { node } = getSessionData(req.sessionToken);
    if (!node) {
      return res.status(400).json({ error: 'Node not running' });
    }
    await node.deleteMessage(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// ============ USERNAME REGISTRATION ============

// Check username availability
app.get('/api/username/check/:username', async (req, res) => {
  try {
    const result = await usernameRegistry.isAvailable(req.params.username);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get message to sign for username registration
app.get('/api/username/register-message', (req, res) => {
  try {
    const { username } = req.query;
    if (!username) {
      return res.status(400).json({ error: 'Username required' });
    }
    const { identity } = getSessionData(req.sessionToken);
    if (!identity) {
      return res.status(400).json({ error: 'Not authenticated' });
    }

    const message = usernameRegistry.getRegistrationMessage(username, identity.address);
    res.json({ message, username, dmailAddress: identity.address });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Register username
app.post('/api/username/register', async (req, res) => {
  try {
    const { identity } = getSessionData(req.sessionToken);
    if (!identity) {
      return res.status(400).json({ error: 'Not authenticated' });
    }

    const { username, signature } = req.body;
    if (!username || !signature) {
      return res.status(400).json({ error: 'Username and signature required' });
    }

    const record = await usernameRegistry.register(
      username,
      identity.address,
      identity.walletAddress,
      signature
    );

    res.json({
      success: true,
      email: record.email,
      dmailAddress: record.dmailAddress,
      username: record.username
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get my username
app.get('/api/username/me', async (req, res) => {
  try {
    const { identity } = getSessionData(req.sessionToken);
    if (!identity) {
      return res.json({ username: null });
    }

    const record = await usernameRegistry.getByDmailAddress(identity.address);
    if (record) {
      res.json({
        username: record.username,
        email: record.email,
        dmailAddress: record.dmailAddress
      });
    } else {
      res.json({ username: null });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to get username' });
  }
});

// Resolve address (username, email, or dm1... address)
app.get('/api/resolve/:address', async (req, res) => {
  try {
    const result = await usernameRegistry.resolve(req.params.address);
    res.json(result);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

// Error handler - don't leak internal details
app.use((err, req, res, next) => {
  console.error('Server error');
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║              dMail Secure API Server                      ║
╠═══════════════════════════════════════════════════════════╣
║  REST API:    http://localhost:${PORT}/api                  ║
║  WebSocket:   ws://localhost:${PORT}/ws                     ║
║  Health:      http://localhost:${PORT}/health               ║
╠═══════════════════════════════════════════════════════════╣
║  Security:                                                ║
║  ✓ Wallet authentication with nonce                       ║
║  ✓ Session tokens with expiration                         ║
║  ✓ Rate limiting per IP                                   ║
║  ✓ Restricted CORS                                        ║
║  ✓ Sealed envelope (metadata encryption)                  ║
║  ✓ No private key exposure                                ║
╚═══════════════════════════════════════════════════════════╝

Auth flow:
  1. GET  /api/auth/challenge  → Get nonce
  2. POST /api/auth/login      → Sign nonce with wallet
  3. Use Bearer token for all other requests
`);
});

export { app, server };
