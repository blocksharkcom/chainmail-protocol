import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from 'crypto';
import { ethers } from 'ethers';

const SESSION_DURATION = 24 * 60 * 60 * 1000;
const NONCE_EXPIRY = 5 * 60 * 1000;
const MAX_REQUESTS_PER_MINUTE = 60;
const CHALLENGE_MESSAGE = 'Sign this message to authenticate with dMail.\n\nNonce: ';

const sessions = new Map();
const nonces = new Map();
const rateLimits = new Map();

export function generateNonce() {
  const nonce = Buffer.from(randomBytes(32)).toString('hex');
  const expires = Date.now() + NONCE_EXPIRY;
  nonces.set(nonce, { expires, used: false });

  // Clean up expired nonces
  for (const [key, value] of nonces.entries()) {
    if (value.expires < Date.now()) {
      nonces.delete(key);
    }
  }

  return { nonce, expires };
}

/**
 * Verify nonce is valid and unused
 */
function verifyNonce(nonce) {
  const record = nonces.get(nonce);
  if (!record) {
    return { valid: false, error: 'Invalid nonce' };
  }
  if (record.expires < Date.now()) {
    nonces.delete(nonce);
    return { valid: false, error: 'Nonce expired' };
  }
  if (record.used) {
    return { valid: false, error: 'Nonce already used' };
  }
  return { valid: true };
}

/**
 * Mark nonce as used (prevents replay)
 */
function consumeNonce(nonce) {
  const record = nonces.get(nonce);
  if (record) {
    record.used = true;
    // Delete after a short delay to prevent immediate reuse attempts
    setTimeout(() => nonces.delete(nonce), 60000);
  }
}

/**
 * Create a session for authenticated user
 */
export function createSession(walletAddress, dmailAddress) {
  const token = Buffer.from(randomBytes(32)).toString('hex');
  const expires = Date.now() + SESSION_DURATION;

  sessions.set(token, {
    walletAddress: walletAddress.toLowerCase(),
    dmailAddress,
    expires,
    createdAt: Date.now()
  });

  return { token, expires };
}

/**
 * Validate session token
 */
export function validateSession(token) {
  if (!token) {
    return { valid: false, error: 'No session token provided' };
  }

  const session = sessions.get(token);
  if (!session) {
    return { valid: false, error: 'Invalid session token' };
  }

  if (session.expires < Date.now()) {
    sessions.delete(token);
    return { valid: false, error: 'Session expired' };
  }

  return { valid: true, session };
}

/**
 * Destroy a session (logout)
 */
export function destroySession(token) {
  sessions.delete(token);
}

/**
 * Authenticate with wallet signature
 */
export function authenticateWallet(signature, walletAddress, nonce) {
  // Verify nonce
  const nonceCheck = verifyNonce(nonce);
  if (!nonceCheck.valid) {
    return { success: false, error: nonceCheck.error };
  }

  // Verify signature
  const message = CHALLENGE_MESSAGE + nonce;
  let recoveredAddress;
  try {
    recoveredAddress = ethers.verifyMessage(message, signature);
  } catch (e) {
    console.error('Signature verification error:', e.message);
    return { success: false, error: 'Invalid signature format' };
  }

  console.log('Expected wallet:', walletAddress.toLowerCase());
  console.log('Recovered address:', recoveredAddress.toLowerCase());

  if (recoveredAddress.toLowerCase() !== walletAddress.toLowerCase()) {
    return { success: false, error: 'Signature does not match wallet address' };
  }

  // Consume nonce to prevent replay
  consumeNonce(nonce);

  return { success: true, walletAddress: recoveredAddress };
}

/**
 * Rate limiting middleware
 */
export function checkRateLimit(ip) {
  const now = Date.now();
  const windowStart = now - 60000; // 1 minute window

  let record = rateLimits.get(ip);
  if (!record) {
    record = { requests: [], blocked: false };
    rateLimits.set(ip, record);
  }

  // Remove old requests outside window
  record.requests = record.requests.filter(t => t > windowStart);

  // Check if blocked
  if (record.requests.length >= MAX_REQUESTS_PER_MINUTE) {
    record.blocked = true;
    return { allowed: false, retryAfter: 60 };
  }

  // Add this request
  record.requests.push(now);
  record.blocked = false;

  return { allowed: true, remaining: MAX_REQUESTS_PER_MINUTE - record.requests.length };
}

/**
 * Express middleware for authentication
 */
export function authMiddleware(req, res, next) {
  // Skip auth for public endpoints
  const publicPaths = ['/health', '/api/auth/challenge', '/api/auth/login'];
  if (publicPaths.some(p => req.path.startsWith(p))) {
    return next();
  }

  // Check rate limit
  const ip = req.ip || req.connection.remoteAddress;
  const rateCheck = checkRateLimit(ip);
  if (!rateCheck.allowed) {
    return res.status(429).json({
      error: 'Too many requests',
      retryAfter: rateCheck.retryAfter
    });
  }

  // Get token from header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.slice(7);
  const validation = validateSession(token);

  if (!validation.valid) {
    return res.status(401).json({ error: validation.error });
  }

  // Attach session and token to request
  req.session = validation.session;
  req.sessionToken = token;
  next();
}

/**
 * CORS configuration for security
 */
export function corsOptions(allowedOrigins = []) {
  return {
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, etc.)
      if (!origin) {
        return callback(null, true);
      }

      // In production, restrict to allowed origins
      if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
    maxAge: 86400 // 24 hours
  };
}

/**
 * Generate CSRF token
 */
export function generateCSRFToken() {
  return Buffer.from(randomBytes(32)).toString('hex');
}

/**
 * Clean up expired sessions periodically
 */
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expires < now) {
      sessions.delete(token);
    }
  }
}, 60000); // Every minute

export { CHALLENGE_MESSAGE };
