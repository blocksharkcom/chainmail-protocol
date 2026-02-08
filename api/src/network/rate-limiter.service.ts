import { Injectable, OnModuleDestroy } from '@nestjs/common';

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
  reason?: string;
}

export interface RateInfo {
  count: number;
  limit: number;
  remaining: number;
  resetMs: number;
}

export interface SizeLimitResult {
  allowed: boolean;
  reason?: string;
  maxSize?: number;
  used?: number;
  limit?: number;
}

export interface SenderStats {
  reputation: number;
  adjustedLimit: number;
  rate: RateInfo;
  globalRate: {
    count: number;
    limit: number;
    remaining: number;
  };
}

export interface ProofOfWorkChallenge {
  challenge: string;
  timestamp: number;
  senderId: string;
  expiresAt: number;
}

@Injectable()
export class RateLimiterService implements OnModuleDestroy {
  private maxRequests: number;
  private windowMs: number;
  private globalMaxRequests: number;
  private requests: Map<string, number[]> = new Map();
  private globalRequests: number[] = [];
  private cleanupInterval: NodeJS.Timeout;

  // Size limiter
  private maxMessageSize: number;
  private maxDailyStorage: number;
  private dailyUsage: Map<string, { bytes: number; date: string }> = new Map();

  // Reputation system
  private reputations: Map<string, number> = new Map();
  private thresholds: Record<number, number> = {
    0: 0.5,
    25: 1.0,
    50: 1.5,
    75: 2.0,
    100: 3.0,
  };

  constructor() {
    this.maxRequests = 10;
    this.windowMs = 60000;
    this.globalMaxRequests = 1000;
    this.maxMessageSize = 1024 * 1024; // 1MB
    this.maxDailyStorage = 10 * 1024 * 1024; // 10MB

    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  onModuleDestroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  /**
   * Check if a request is allowed
   */
  check(senderId: string): RateLimitResult {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Check global limit first
    this.globalRequests = this.globalRequests.filter((t) => t > windowStart);
    if (this.globalRequests.length >= this.globalMaxRequests) {
      const oldestRequest = this.globalRequests[0];
      const retryAfterMs = oldestRequest + this.windowMs - now;
      return {
        allowed: false,
        retryAfterMs,
        reason: 'global_limit_exceeded',
      };
    }

    // Check per-sender limit
    let senderRequests = this.requests.get(senderId) || [];
    senderRequests = senderRequests.filter((t) => t > windowStart);

    if (senderRequests.length >= this.maxRequests) {
      const oldestRequest = senderRequests[0];
      const retryAfterMs = oldestRequest + this.windowMs - now;
      return {
        allowed: false,
        retryAfterMs,
        reason: 'sender_limit_exceeded',
      };
    }

    return { allowed: true };
  }

  /**
   * Record a request
   */
  record(senderId: string): void {
    const now = Date.now();

    let senderRequests = this.requests.get(senderId) || [];
    senderRequests.push(now);
    this.requests.set(senderId, senderRequests);

    this.globalRequests.push(now);
  }

  /**
   * Check and record in one call
   */
  checkAndRecord(senderId: string): RateLimitResult {
    const result = this.check(senderId);
    if (result.allowed) {
      this.record(senderId);
    }
    return result;
  }

  /**
   * Get current rate for a sender
   */
  getRate(senderId: string): RateInfo {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    let senderRequests = this.requests.get(senderId) || [];
    senderRequests = senderRequests.filter((t) => t > windowStart);

    return {
      count: senderRequests.length,
      limit: this.maxRequests,
      remaining: Math.max(0, this.maxRequests - senderRequests.length),
      resetMs: senderRequests.length > 0 ? senderRequests[0] + this.windowMs - now : 0,
    };
  }

  /**
   * Get global rate
   */
  getGlobalRate(): { count: number; limit: number; remaining: number } {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    this.globalRequests = this.globalRequests.filter((t) => t > windowStart);

    return {
      count: this.globalRequests.length,
      limit: this.globalMaxRequests,
      remaining: Math.max(0, this.globalMaxRequests - this.globalRequests.length),
    };
  }

  /**
   * Cleanup old entries
   */
  private cleanup(): void {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    for (const [senderId, timestamps] of this.requests.entries()) {
      const filtered = timestamps.filter((t) => t > windowStart);
      if (filtered.length === 0) {
        this.requests.delete(senderId);
      } else {
        this.requests.set(senderId, filtered);
      }
    }

    this.globalRequests = this.globalRequests.filter((t) => t > windowStart);
  }

  /**
   * Reset limits for a sender
   */
  reset(senderId: string): void {
    this.requests.delete(senderId);
  }

  // Size limiter methods

  /**
   * Check if message size is allowed
   */
  checkSize(size: number): SizeLimitResult {
    if (size > this.maxMessageSize) {
      return {
        allowed: false,
        reason: 'message_too_large',
        maxSize: this.maxMessageSize,
      };
    }
    return { allowed: true };
  }

  /**
   * Check daily storage limit for a sender
   */
  checkDailyStorage(senderId: string, size: number): SizeLimitResult {
    const today = new Date().toDateString();
    const usage = this.dailyUsage.get(senderId);

    if (usage && usage.date === today) {
      if (usage.bytes + size > this.maxDailyStorage) {
        return {
          allowed: false,
          reason: 'daily_storage_exceeded',
          used: usage.bytes,
          limit: this.maxDailyStorage,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Record storage usage
   */
  recordStorage(senderId: string, size: number): void {
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
  checkSizeLimits(senderId: string, size: number): SizeLimitResult {
    const sizeResult = this.checkSize(size);
    if (!sizeResult.allowed) return sizeResult;

    return this.checkDailyStorage(senderId, size);
  }

  // Reputation-based rate limiting

  /**
   * Get reputation-adjusted limit for a sender
   */
  getAdjustedLimit(senderId: string): number {
    const reputation = this.reputations.get(senderId) || 0;
    let multiplier = 0.5;

    for (const [threshold, mult] of Object.entries(this.thresholds)) {
      if (reputation >= parseInt(threshold)) {
        multiplier = mult;
      }
    }

    return Math.floor(this.maxRequests * multiplier);
  }

  /**
   * Check if request is allowed (reputation-adjusted)
   */
  checkWithReputation(senderId: string, messageSize = 0): RateLimitResult {
    if (messageSize > 0) {
      const sizeResult = this.checkSizeLimits(senderId, messageSize);
      if (!sizeResult.allowed) {
        return { allowed: false, reason: sizeResult.reason };
      }
    }

    const adjustedLimit = this.getAdjustedLimit(senderId);
    const rate = this.getRate(senderId);

    if (rate.count >= adjustedLimit) {
      return {
        allowed: false,
        reason: 'rate_limit_exceeded',
      };
    }

    return { allowed: true };
  }

  /**
   * Record a request with reputation adjustment
   */
  recordWithReputation(senderId: string, messageSize = 0): void {
    this.record(senderId);
    if (messageSize > 0) {
      this.recordStorage(senderId, messageSize);
    }
    this.adjustReputation(senderId, 0.1);
  }

  /**
   * Check and record with reputation
   */
  checkAndRecordWithReputation(senderId: string, messageSize = 0): RateLimitResult {
    const result = this.checkWithReputation(senderId, messageSize);
    if (result.allowed) {
      this.recordWithReputation(senderId, messageSize);
    }
    return result;
  }

  /**
   * Adjust reputation for a sender
   */
  adjustReputation(senderId: string, delta: number): void {
    const current = this.reputations.get(senderId) || 25;
    const newScore = Math.max(0, Math.min(100, current + delta));
    this.reputations.set(senderId, newScore);
  }

  /**
   * Report spam from a sender
   */
  reportSpam(senderId: string): void {
    this.adjustReputation(senderId, -25);
  }

  /**
   * Mark sender as trusted
   */
  markTrusted(senderId: string, level: 'low' | 'medium' | 'high' | 'verified' = 'medium'): void {
    const scores: Record<string, number> = {
      low: 25,
      medium: 50,
      high: 75,
      verified: 100,
    };
    this.reputations.set(senderId, scores[level] || 50);
  }

  /**
   * Get sender stats
   */
  getStats(senderId: string): SenderStats {
    return {
      reputation: this.reputations.get(senderId) || 0,
      adjustedLimit: this.getAdjustedLimit(senderId),
      rate: this.getRate(senderId),
      globalRate: this.getGlobalRate(),
    };
  }
}
