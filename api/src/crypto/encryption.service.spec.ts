import { Test, TestingModule } from '@nestjs/testing';
import { EncryptionService } from './encryption.service';
import { x25519 } from '@noble/curves/ed25519';
import { randomBytes } from 'crypto';

describe('EncryptionService', () => {
  let service: EncryptionService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [EncryptionService],
    }).compile();

    service = module.get<EncryptionService>(EncryptionService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('encrypt and decrypt', () => {
    it('should encrypt and decrypt a message', () => {
      const recipientPrivate = randomBytes(32);
      const recipientPublic = x25519.getPublicKey(recipientPrivate);

      const plaintext = new TextEncoder().encode('Hello, dMail!');
      const encrypted = service.encrypt(plaintext, recipientPublic);

      expect(encrypted.ephemeralPublicKey).toBeInstanceOf(Uint8Array);
      expect(encrypted.ephemeralPublicKey.length).toBe(32);
      expect(encrypted.nonce).toBeInstanceOf(Uint8Array);
      expect(encrypted.nonce.length).toBe(12);
      expect(encrypted.ciphertext).toBeInstanceOf(Uint8Array);

      const decrypted = service.decrypt(encrypted, recipientPrivate);
      expect(new TextDecoder().decode(decrypted)).toBe('Hello, dMail!');
    });

    it('should produce different ciphertext for same message', () => {
      const recipientPrivate = randomBytes(32);
      const recipientPublic = x25519.getPublicKey(recipientPrivate);

      const plaintext = new TextEncoder().encode('Same message');
      const encrypted1 = service.encrypt(plaintext, recipientPublic);
      const encrypted2 = service.encrypt(plaintext, recipientPublic);

      expect(Buffer.from(encrypted1.ciphertext).toString('hex')).not.toBe(
        Buffer.from(encrypted2.ciphertext).toString('hex'),
      );
    });

    it('should fail decryption with wrong private key', () => {
      const recipientPrivate = randomBytes(32);
      const recipientPublic = x25519.getPublicKey(recipientPrivate);
      const wrongPrivate = randomBytes(32);

      const plaintext = new TextEncoder().encode('Secret message');
      const encrypted = service.encrypt(plaintext, recipientPublic);

      expect(() => service.decrypt(encrypted, wrongPrivate)).toThrow();
    });

    it('should fail decryption with tampered ciphertext', () => {
      const recipientPrivate = randomBytes(32);
      const recipientPublic = x25519.getPublicKey(recipientPrivate);

      const plaintext = new TextEncoder().encode('Secret message');
      const encrypted = service.encrypt(plaintext, recipientPublic);
      encrypted.ciphertext[0] = encrypted.ciphertext[0] ^ 0xff;

      expect(() => service.decrypt(encrypted, recipientPrivate)).toThrow();
    });

    it('should fail decryption with tampered nonce', () => {
      const recipientPrivate = randomBytes(32);
      const recipientPublic = x25519.getPublicKey(recipientPrivate);

      const plaintext = new TextEncoder().encode('Secret message');
      const encrypted = service.encrypt(plaintext, recipientPublic);
      encrypted.nonce[0] = encrypted.nonce[0] ^ 0xff;

      expect(() => service.decrypt(encrypted, recipientPrivate)).toThrow();
    });
  });

  describe('serialize and deserialize', () => {
    it('should serialize and deserialize encrypted message', () => {
      const recipientPrivate = randomBytes(32);
      const recipientPublic = x25519.getPublicKey(recipientPrivate);

      const plaintext = new TextEncoder().encode('Test message');
      const encrypted = service.encrypt(plaintext, recipientPublic);
      const serialized = service.serialize(encrypted);

      expect(typeof serialized.ephemeralPublicKey).toBe('string');
      expect(typeof serialized.nonce).toBe('string');
      expect(typeof serialized.ciphertext).toBe('string');

      const deserialized = service.deserialize(serialized);

      expect(Buffer.from(deserialized.ephemeralPublicKey).toString('hex')).toBe(
        Buffer.from(encrypted.ephemeralPublicKey).toString('hex'),
      );
      expect(Buffer.from(deserialized.nonce).toString('hex')).toBe(
        Buffer.from(encrypted.nonce).toString('hex'),
      );
      expect(Buffer.from(deserialized.ciphertext).toString('hex')).toBe(
        Buffer.from(encrypted.ciphertext).toString('hex'),
      );
    });

    it('should allow decryption after serialization round-trip', () => {
      const recipientPrivate = randomBytes(32);
      const recipientPublic = x25519.getPublicKey(recipientPrivate);

      const plaintext = new TextEncoder().encode('Round trip test');
      const encrypted = service.encrypt(plaintext, recipientPublic);
      const serialized = service.serialize(encrypted);
      const deserialized = service.deserialize(serialized);

      const decrypted = service.decrypt(deserialized, recipientPrivate);
      expect(new TextDecoder().decode(decrypted)).toBe('Round trip test');
    });
  });

  describe('encryptString and decryptString', () => {
    it('should encrypt and decrypt a string', () => {
      const recipientPrivate = randomBytes(32);
      const recipientPublic = x25519.getPublicKey(recipientPrivate);

      const message = 'Hello, World!';
      const encrypted = service.encryptString(message, recipientPublic);

      expect(typeof encrypted.ephemeralPublicKey).toBe('string');
      expect(typeof encrypted.nonce).toBe('string');
      expect(typeof encrypted.ciphertext).toBe('string');

      const decrypted = service.decryptString(encrypted, recipientPrivate);
      expect(decrypted).toBe(message);
    });

    it('should handle unicode strings', () => {
      const recipientPrivate = randomBytes(32);
      const recipientPublic = x25519.getPublicKey(recipientPrivate);

      const message = 'Hello, World! Emoji test';
      const encrypted = service.encryptString(message, recipientPublic);
      const decrypted = service.decryptString(encrypted, recipientPrivate);

      expect(decrypted).toBe(message);
    });

    it('should handle empty string', () => {
      const recipientPrivate = randomBytes(32);
      const recipientPublic = x25519.getPublicKey(recipientPrivate);

      const message = '';
      const encrypted = service.encryptString(message, recipientPublic);
      const decrypted = service.decryptString(encrypted, recipientPrivate);

      expect(decrypted).toBe(message);
    });
  });

  describe('encryptJson and decryptJson', () => {
    it('should encrypt and decrypt a JSON object', () => {
      const recipientPrivate = randomBytes(32);
      const recipientPublic = x25519.getPublicKey(recipientPrivate);

      const data = { to: 'alice@example.com', subject: 'Hello', body: 'Test' };
      const encrypted = service.encryptJson(data, recipientPublic);
      const decrypted = service.decryptJson<typeof data>(encrypted, recipientPrivate);

      expect(decrypted).toEqual(data);
    });

    it('should handle nested objects', () => {
      const recipientPrivate = randomBytes(32);
      const recipientPublic = x25519.getPublicKey(recipientPrivate);

      const data = {
        envelope: {
          to: 'bob',
          from: 'alice',
        },
        content: {
          subject: 'Test',
          body: 'Message body',
          attachments: [{ name: 'file.txt', size: 1024 }],
        },
      };

      const encrypted = service.encryptJson(data, recipientPublic);
      const decrypted = service.decryptJson<typeof data>(encrypted, recipientPrivate);

      expect(decrypted).toEqual(data);
    });

    it('should handle arrays', () => {
      const recipientPrivate = randomBytes(32);
      const recipientPublic = x25519.getPublicKey(recipientPrivate);

      const data = [1, 2, 3, 'four', { five: 5 }];
      const encrypted = service.encryptJson(data, recipientPublic);
      const decrypted = service.decryptJson<typeof data>(encrypted, recipientPrivate);

      expect(decrypted).toEqual(data);
    });
  });
});
