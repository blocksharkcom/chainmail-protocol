import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ethers } from 'ethers';
import { randomBytes } from 'crypto';

export interface AuthChallenge {
  challenge: string;
  timestamp: number;
  expiresAt: number;
  address?: string;
}

export interface VerificationResult {
  valid: boolean;
  address?: string;
  error?: string;
}

@Injectable()
export class AuthService implements OnModuleDestroy {
  private challenges: Map<string, AuthChallenge> = new Map();
  private sessions: Map<string, { address: string; expiresAt: number }> = new Map();
  private cleanupIntervalRef: NodeJS.Timeout | null = null;

  private readonly challengeExpiry = 5 * 60 * 1000; // 5 minutes
  private readonly sessionExpiry = 24 * 60 * 60 * 1000; // 24 hours

  constructor() {
    // Cleanup expired challenges and sessions periodically
    this.cleanupIntervalRef = setInterval(() => this.cleanup(), 60000);
    this.cleanupIntervalRef.unref();
  }

  onModuleDestroy(): void {
    if (this.cleanupIntervalRef) {
      clearInterval(this.cleanupIntervalRef);
      this.cleanupIntervalRef = null;
    }
  }

  /**
   * Generate a challenge for wallet authentication
   */
  generateChallenge(address?: string): AuthChallenge {
    const challenge = randomBytes(32).toString('hex');
    const timestamp = Date.now();
    const expiresAt = timestamp + this.challengeExpiry;

    const authChallenge: AuthChallenge = {
      challenge,
      timestamp,
      expiresAt,
      address,
    };

    this.challenges.set(challenge, authChallenge);

    return authChallenge;
  }

  /**
   * Verify a signed challenge
   */
  async verifySignature(
    challenge: string,
    signature: string,
    expectedAddress?: string,
  ): Promise<VerificationResult> {
    const storedChallenge = this.challenges.get(challenge);

    if (!storedChallenge) {
      return { valid: false, error: 'Challenge not found' };
    }

    if (Date.now() > storedChallenge.expiresAt) {
      this.challenges.delete(challenge);
      return { valid: false, error: 'Challenge expired' };
    }

    try {
      // Create the message that was signed
      const message = `Sign this message to authenticate with dMail:\n\nChallenge: ${challenge}\nTimestamp: ${storedChallenge.timestamp}`;

      // Recover the address from the signature
      const recoveredAddress = ethers.verifyMessage(message, signature);

      // If an expected address was provided, verify it matches
      if (expectedAddress && recoveredAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
        return { valid: false, error: 'Address mismatch' };
      }

      // If the challenge was created with an address, verify it matches
      if (
        storedChallenge.address &&
        recoveredAddress.toLowerCase() !== storedChallenge.address.toLowerCase()
      ) {
        return { valid: false, error: 'Address mismatch' };
      }

      // Challenge verified, remove it
      this.challenges.delete(challenge);

      return { valid: true, address: recoveredAddress };
    } catch (error) {
      return { valid: false, error: 'Invalid signature' };
    }
  }

  /**
   * Create a session token after successful authentication
   */
  createSession(address: string): string {
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + this.sessionExpiry;

    this.sessions.set(token, { address, expiresAt });

    return token;
  }

  /**
   * Validate a session token
   */
  validateSession(token: string): { valid: boolean; address?: string } {
    const session = this.sessions.get(token);

    if (!session) {
      return { valid: false };
    }

    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token);
      return { valid: false };
    }

    return { valid: true, address: session.address };
  }

  /**
   * Invalidate a session
   */
  invalidateSession(token: string): void {
    this.sessions.delete(token);
  }

  /**
   * Get the message to sign for a challenge
   */
  getMessageToSign(challenge: string): string | null {
    const storedChallenge = this.challenges.get(challenge);
    if (!storedChallenge) {
      return null;
    }

    return `Sign this message to authenticate with dMail:\n\nChallenge: ${challenge}\nTimestamp: ${storedChallenge.timestamp}`;
  }

  /**
   * Cleanup expired challenges and sessions
   */
  private cleanup(): void {
    const now = Date.now();

    for (const [key, challenge] of this.challenges.entries()) {
      if (now > challenge.expiresAt) {
        this.challenges.delete(key);
      }
    }

    for (const [key, session] of this.sessions.entries()) {
      if (now > session.expiresAt) {
        this.sessions.delete(key);
      }
    }
  }
}
