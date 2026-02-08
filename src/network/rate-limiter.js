/**
 * Rate Limiter for dMail
 *
 * Prevents spam and abuse by limiting the rate of operations.
 * Uses a sliding window algorithm with per-sender and global limits.
 *
 * Features:
 * - Per-sender rate limiting
 * - Global rate limiting
 * - Configurable windows and limits
 * - Automatic cleanup of old entries
 * - Reputation system integration
 */

/**
 * Sliding Window Rate Limiter
 */
export class RateLimiter {
  constructor(options = {}) {
    // Default: 10 messages per minute per sender
    this.maxRequests = options.maxRequests || 10;
    this.windowMs = options.windowMs || 60000; // 1 minute

    // Global limit: 1000 messages per minute for the entire node
    this.globalMaxRequests = options.globalMaxRequests || 1000;

    // Storage for request counts
    this.requests = new Map(); // sender -> timestamps[]
    this.globalRequests = [];

    // Cleanup interval
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  /**
   * Check if a request is allowed
   * @param {string} senderId - Unique identifier for the sender
   * @returns {{allowed: boolean, retryAfterMs?: number, reason?: string}}
   */
  check(senderId) {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Check global limit first
    this.globalRequests = this.globalRequests.filter(t => t > windowStart);
    if (this.globalRequests.length >= this.globalMaxRequests) {
      const oldestRequest = this.globalRequests[0];
      const retryAfterMs = oldestRequest + this.windowMs - now;
      return {
        allowed: false,
        retryAfterMs,
        reason: 'global_limit_exceeded'
      };
    }

    // Check per-sender limit
    let senderRequests = this.requests.get(senderId) || [];
    senderRequests = senderRequests.filter(t => t > windowStart);

    if (senderRequests.length >= this.maxRequests) {
      const oldestRequest = senderRequests[0];
      const retryAfterMs = oldestRequest + this.windowMs - now;
      return {
        allowed: false,
        retryAfterMs,
        reason: 'sender_limit_exceeded'
      };
    }

    return { allowed: true };
  }

  /**
   * Record a request (call after allowing)
   * @param {string} senderId - Unique identifier for the sender
   */
  record(senderId) {
    const now = Date.now();

    // Record sender request
    let senderRequests = this.requests.get(senderId) || [];
    senderRequests.push(now);
    this.requests.set(senderId, senderRequests);

    // Record global request
    this.globalRequests.push(now);
  }

  /**
   * Check and record in one call
   * @param {string} senderId - Unique identifier for the sender
   * @returns {{allowed: boolean, retryAfterMs?: number, reason?: string}}
   */
  checkAndRecord(senderId) {
    const result = this.check(senderId);
    if (result.allowed) {
      this.record(senderId);
    }
    return result;
  }

  /**
   * Get current rate for a sender
   */
  getRate(senderId) {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    let senderRequests = this.requests.get(senderId) || [];
    senderRequests = senderRequests.filter(t => t > windowStart);

    return {
      count: senderRequests.length,
      limit: this.maxRequests,
      remaining: Math.max(0, this.maxRequests - senderRequests.length),
      resetMs: senderRequests.length > 0
        ? senderRequests[0] + this.windowMs - now
        : 0
    };
  }

  /**
   * Get global rate
   */
  getGlobalRate() {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    this.globalRequests = this.globalRequests.filter(t => t > windowStart);

    return {
      count: this.globalRequests.length,
      limit: this.globalMaxRequests,
      remaining: Math.max(0, this.globalMaxRequests - this.globalRequests.length)
    };
  }

  /**
   * Cleanup old entries
   */
  cleanup() {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Cleanup sender requests
    for (const [senderId, timestamps] of this.requests.entries()) {
      const filtered = timestamps.filter(t => t > windowStart);
      if (filtered.length === 0) {
        this.requests.delete(senderId);
      } else {
        this.requests.set(senderId, filtered);
      }
    }

    // Cleanup global requests
    this.globalRequests = this.globalRequests.filter(t => t > windowStart);
  }

  /**
   * Reset limits for a sender (for trusted senders)
   */
  reset(senderId) {
    this.requests.delete(senderId);
  }

  /**
   * Stop the cleanup interval
   */
  stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

/**
 * Message Size Limiter
 * Prevents oversized message attacks
 */
export class SizeLimiter {
  constructor(options = {}) {
    // Default: 1MB max message size
    this.maxMessageSize = options.maxMessageSize || 1024 * 1024;
    // Default: 10MB max storage per sender per day
    this.maxDailyStorage = options.maxDailyStorage || 10 * 1024 * 1024;

    this.dailyUsage = new Map(); // sender -> {bytes, date}
  }

  /**
   * Check if message size is allowed
   */
  checkSize(size) {
    if (size > this.maxMessageSize) {
      return {
        allowed: false,
        reason: 'message_too_large',
        maxSize: this.maxMessageSize
      };
    }
    return { allowed: true };
  }

  /**
   * Check daily storage limit for a sender
   */
  checkDailyStorage(senderId, size) {
    const today = new Date().toDateString();
    const usage = this.dailyUsage.get(senderId);

    if (usage && usage.date === today) {
      if (usage.bytes + size > this.maxDailyStorage) {
        return {
          allowed: false,
          reason: 'daily_storage_exceeded',
          used: usage.bytes,
          limit: this.maxDailyStorage
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Record storage usage
   */
  recordStorage(senderId, size) {
    const today = new Date().toDateString();
    const usage = this.dailyUsage.get(senderId);

    if (usage && usage.date === today) {
      usage.bytes += size;
    } else {
      this.dailyUsage.set(senderId, { bytes: size, date: today });
    }
  }

  /**
   * Check both size limits
   */
  check(senderId, size) {
    const sizeResult = this.checkSize(size);
    if (!sizeResult.allowed) return sizeResult;

    return this.checkDailyStorage(senderId, size);
  }
}

/**
 * Reputation-based Rate Limiter
 * Adjusts limits based on sender reputation
 */
export class ReputationRateLimiter {
  constructor(options = {}) {
    this.baseRateLimiter = new RateLimiter(options);
    this.sizeLimiter = new SizeLimiter(options);

    // Reputation scores (higher = more trusted)
    this.reputations = new Map(); // sender -> score (0-100)

    // Reputation thresholds for rate multipliers
    this.thresholds = {
      0: 0.5,   // New/untrusted: 50% of base limit
      25: 1.0,  // Low trust: normal limits
      50: 1.5,  // Medium trust: 150% of base limit
      75: 2.0,  // High trust: double limits
      100: 3.0  // Maximum trust: triple limits
    };
  }

  /**
   * Get reputation-adjusted limit for a sender
   */
  getAdjustedLimit(senderId) {
    const reputation = this.reputations.get(senderId) || 0;
    let multiplier = 0.5;

    for (const [threshold, mult] of Object.entries(this.thresholds)) {
      if (reputation >= parseInt(threshold)) {
        multiplier = mult;
      }
    }

    return Math.floor(this.baseRateLimiter.maxRequests * multiplier);
  }

  /**
   * Check if request is allowed (reputation-adjusted)
   */
  check(senderId, messageSize = 0) {
    // Check size limits
    if (messageSize > 0) {
      const sizeResult = this.sizeLimiter.check(senderId, messageSize);
      if (!sizeResult.allowed) return sizeResult;
    }

    // Get reputation-adjusted limit
    const adjustedLimit = this.getAdjustedLimit(senderId);
    const rate = this.baseRateLimiter.getRate(senderId);

    if (rate.count >= adjustedLimit) {
      return {
        allowed: false,
        reason: 'rate_limit_exceeded',
        reputation: this.reputations.get(senderId) || 0,
        adjustedLimit
      };
    }

    return { allowed: true };
  }

  /**
   * Record a request
   */
  record(senderId, messageSize = 0) {
    this.baseRateLimiter.record(senderId);
    if (messageSize > 0) {
      this.sizeLimiter.recordStorage(senderId, messageSize);
    }

    // Slowly increase reputation for successful sends
    this.adjustReputation(senderId, 0.1);
  }

  /**
   * Check and record in one call
   */
  checkAndRecord(senderId, messageSize = 0) {
    const result = this.check(senderId, messageSize);
    if (result.allowed) {
      this.record(senderId, messageSize);
    }
    return result;
  }

  /**
   * Adjust reputation for a sender
   * @param {string} senderId - Sender identifier
   * @param {number} delta - Amount to adjust (-100 to 100)
   */
  adjustReputation(senderId, delta) {
    const current = this.reputations.get(senderId) || 25; // Start at 25
    const newScore = Math.max(0, Math.min(100, current + delta));
    this.reputations.set(senderId, newScore);
  }

  /**
   * Report spam from a sender (significantly reduces reputation)
   */
  reportSpam(senderId) {
    this.adjustReputation(senderId, -25);
  }

  /**
   * Mark sender as trusted (e.g., on-chain verified identity)
   */
  markTrusted(senderId, level = 'medium') {
    const scores = {
      low: 25,
      medium: 50,
      high: 75,
      verified: 100
    };
    this.reputations.set(senderId, scores[level] || 50);
  }

  /**
   * Get sender stats
   */
  getStats(senderId) {
    return {
      reputation: this.reputations.get(senderId) || 0,
      adjustedLimit: this.getAdjustedLimit(senderId),
      rate: this.baseRateLimiter.getRate(senderId),
      globalRate: this.baseRateLimiter.getGlobalRate()
    };
  }

  /**
   * Stop all intervals
   */
  stop() {
    this.baseRateLimiter.stop();
  }
}

/**
 * Proof of Work Spam Prevention
 * Requires computational work for unverified senders
 */
export class ProofOfWorkLimiter {
  constructor(options = {}) {
    // Difficulty: number of leading zero bits required
    this.baseDifficulty = options.baseDifficulty || 16;
    this.maxDifficulty = options.maxDifficulty || 24;
  }

  /**
   * Get required difficulty for a sender
   * @param {number} reputation - Sender reputation (0-100)
   */
  getDifficulty(reputation = 0) {
    // Higher reputation = lower difficulty
    const reductionFactor = reputation / 100;
    const reduction = Math.floor(this.baseDifficulty * reductionFactor * 0.5);
    return Math.max(8, this.baseDifficulty - reduction);
  }

  /**
   * Generate a challenge for the sender
   */
  generateChallenge(senderId) {
    const { randomBytes } = require('crypto');
    const challenge = randomBytes(32).toString('hex');
    const timestamp = Date.now();

    return {
      challenge,
      timestamp,
      senderId,
      expiresAt: timestamp + 60000 // 1 minute validity
    };
  }

  /**
   * Verify proof of work
   * @param {Object} challenge - The original challenge
   * @param {string} nonce - The solution nonce
   */
  verifyProof(challenge, nonce) {
    const { sha256 } = require('@noble/hashes/sha256');

    if (Date.now() > challenge.expiresAt) {
      return { valid: false, reason: 'challenge_expired' };
    }

    const data = `${challenge.challenge}:${challenge.senderId}:${nonce}`;
    const hash = Buffer.from(sha256(new TextEncoder().encode(data)));

    // Check leading zero bits
    const difficulty = this.getDifficulty();
    const requiredZeroBytes = Math.floor(difficulty / 8);
    const remainingBits = difficulty % 8;

    for (let i = 0; i < requiredZeroBytes; i++) {
      if (hash[i] !== 0) {
        return { valid: false, reason: 'insufficient_work' };
      }
    }

    if (remainingBits > 0) {
      const mask = 0xFF << (8 - remainingBits);
      if ((hash[requiredZeroBytes] & mask) !== 0) {
        return { valid: false, reason: 'insufficient_work' };
      }
    }

    return { valid: true };
  }
}

export default ReputationRateLimiter;
