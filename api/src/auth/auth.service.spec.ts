import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { ethers } from 'ethers';

describe('AuthService', () => {
  let service: AuthService;
  let wallet: ethers.HDNodeWallet;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AuthService],
    }).compile();

    service = module.get<AuthService>(AuthService);
    wallet = ethers.Wallet.createRandom();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('generateChallenge', () => {
    it('should generate a challenge', () => {
      const challenge = service.generateChallenge();

      expect(challenge).toBeDefined();
      expect(challenge.challenge).toBeDefined();
      expect(challenge.challenge.length).toBe(64);
      expect(challenge.timestamp).toBeDefined();
      expect(challenge.expiresAt).toBeGreaterThan(challenge.timestamp);
    });

    it('should generate unique challenges', () => {
      const challenge1 = service.generateChallenge();
      const challenge2 = service.generateChallenge();

      expect(challenge1.challenge).not.toBe(challenge2.challenge);
    });

    it('should store the address when provided', () => {
      const address = '0x1234567890123456789012345678901234567890';
      const challenge = service.generateChallenge(address);

      expect(challenge.address).toBe(address);
    });
  });

  describe('getMessageToSign', () => {
    it('should return the message to sign for a valid challenge', () => {
      const challenge = service.generateChallenge();
      const message = service.getMessageToSign(challenge.challenge);

      expect(message).toBeDefined();
      expect(message).toContain(challenge.challenge);
      expect(message).toContain(challenge.timestamp.toString());
    });

    it('should return null for an invalid challenge', () => {
      const message = service.getMessageToSign('nonexistent');

      expect(message).toBeNull();
    });
  });

  describe('verifySignature', () => {
    it('should verify a valid signature', async () => {
      const challenge = service.generateChallenge();
      const message = service.getMessageToSign(challenge.challenge)!;
      const signature = await wallet.signMessage(message);

      const result = await service.verifySignature(challenge.challenge, signature);

      expect(result.valid).toBe(true);
      expect(result.address?.toLowerCase()).toBe(wallet.address.toLowerCase());
    });

    it('should fail for a nonexistent challenge', async () => {
      const result = await service.verifySignature('nonexistent', '0x123');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Challenge not found');
    });

    it('should fail for an invalid signature', async () => {
      const challenge = service.generateChallenge();
      const result = await service.verifySignature(challenge.challenge, '0xinvalid');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid signature');
    });

    it('should fail if expected address does not match', async () => {
      const challenge = service.generateChallenge();
      const message = service.getMessageToSign(challenge.challenge)!;
      const signature = await wallet.signMessage(message);

      const wrongAddress = '0x0000000000000000000000000000000000000000';
      const result = await service.verifySignature(challenge.challenge, signature, wrongAddress);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Address mismatch');
    });

    it('should fail if challenge address does not match signer', async () => {
      const wrongAddress = '0x0000000000000000000000000000000000000000';
      const challenge = service.generateChallenge(wrongAddress);
      const message = service.getMessageToSign(challenge.challenge)!;
      const signature = await wallet.signMessage(message);

      const result = await service.verifySignature(challenge.challenge, signature);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Address mismatch');
    });

    it('should remove challenge after successful verification', async () => {
      const challenge = service.generateChallenge();
      const message = service.getMessageToSign(challenge.challenge)!;
      const signature = await wallet.signMessage(message);

      await service.verifySignature(challenge.challenge, signature);

      // Try to verify again
      const result = await service.verifySignature(challenge.challenge, signature);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Challenge not found');
    });
  });

  describe('createSession and validateSession', () => {
    it('should create and validate a session', () => {
      const address = wallet.address;
      const token = service.createSession(address);

      expect(token).toBeDefined();
      expect(token.length).toBe(64);

      const result = service.validateSession(token);
      expect(result.valid).toBe(true);
      expect(result.address).toBe(address);
    });

    it('should fail validation for invalid token', () => {
      const result = service.validateSession('invalid');

      expect(result.valid).toBe(false);
      expect(result.address).toBeUndefined();
    });
  });

  describe('invalidateSession', () => {
    it('should invalidate a session', () => {
      const token = service.createSession(wallet.address);

      service.invalidateSession(token);

      const result = service.validateSession(token);
      expect(result.valid).toBe(false);
    });

    it('should not throw for non-existent session', () => {
      expect(() => service.invalidateSession('nonexistent')).not.toThrow();
    });
  });

  describe('full authentication flow', () => {
    it('should complete the full auth flow', async () => {
      // 1. Generate challenge
      const challenge = service.generateChallenge(wallet.address);
      expect(challenge).toBeDefined();

      // 2. Get message to sign
      const message = service.getMessageToSign(challenge.challenge);
      expect(message).toBeDefined();

      // 3. Sign the message
      const signature = await wallet.signMessage(message!);

      // 4. Verify the signature
      const verification = await service.verifySignature(
        challenge.challenge,
        signature,
        wallet.address,
      );
      expect(verification.valid).toBe(true);
      expect(verification.address?.toLowerCase()).toBe(wallet.address.toLowerCase());

      // 5. Create session
      const token = service.createSession(verification.address!);
      expect(token).toBeDefined();

      // 6. Validate session
      const session = service.validateSession(token);
      expect(session.valid).toBe(true);
      expect(session.address?.toLowerCase()).toBe(wallet.address.toLowerCase());

      // 7. Invalidate session
      service.invalidateSession(token);

      // 8. Session should be invalid
      const invalidSession = service.validateSession(token);
      expect(invalidSession.valid).toBe(false);
    });
  });
});
