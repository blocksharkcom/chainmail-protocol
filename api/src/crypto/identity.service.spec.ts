import { Test, TestingModule } from '@nestjs/testing';
import { IdentityService } from './identity.service';

describe('IdentityService', () => {
  let service: IdentityService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [IdentityService],
    }).compile();

    service = module.get<IdentityService>(IdentityService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('generate', () => {
    it('should generate a valid identity', () => {
      const identity = service.generate();

      expect(identity).toBeDefined();
      expect(identity.address).toBeDefined();
      expect(identity.address.startsWith('dm')).toBe(true);
      expect(identity.publicKey).toBeInstanceOf(Uint8Array);
      expect(identity.privateKey).toBeInstanceOf(Uint8Array);
      expect(identity.encryptionPublicKey).toBeInstanceOf(Uint8Array);
      expect(identity.encryptionPrivateKey).toBeInstanceOf(Uint8Array);
      expect(identity.routingToken).toBeDefined();
      expect(typeof identity.routingToken).toBe('string');
      expect(identity.createdAt).toBeDefined();
      expect(typeof identity.createdAt).toBe('number');
    });

    it('should generate unique identities', () => {
      const identity1 = service.generate();
      const identity2 = service.generate();

      expect(identity1.address).not.toBe(identity2.address);
      expect(Buffer.from(identity1.publicKey).toString('hex')).not.toBe(
        Buffer.from(identity2.publicKey).toString('hex'),
      );
    });

    it('should generate 32-byte keys', () => {
      const identity = service.generate();

      expect(identity.publicKey.length).toBe(32);
      expect(identity.privateKey.length).toBe(32);
      expect(identity.encryptionPublicKey.length).toBe(32);
      expect(identity.encryptionPrivateKey.length).toBe(32);
    });
  });

  describe('deriveAddress', () => {
    it('should derive a bech32 address from public key', () => {
      const identity = service.generate();
      const address = service.deriveAddress(identity.publicKey);

      expect(address).toBeDefined();
      expect(address.startsWith('dm1')).toBe(true);
    });

    it('should derive the same address for the same public key', () => {
      const identity = service.generate();
      const address1 = service.deriveAddress(identity.publicKey);
      const address2 = service.deriveAddress(identity.publicKey);

      expect(address1).toBe(address2);
    });
  });

  describe('sign and verify', () => {
    it('should sign and verify a message', () => {
      const identity = service.generate();
      const message = new TextEncoder().encode('Hello, dMail!');

      const signature = service.sign(message, identity.privateKey);

      expect(signature).toBeInstanceOf(Uint8Array);
      expect(signature.length).toBe(64);

      const isValid = service.verify(message, signature, identity.publicKey);
      expect(isValid).toBe(true);
    });

    it('should fail verification with wrong message', () => {
      const identity = service.generate();
      const message = new TextEncoder().encode('Hello, dMail!');
      const wrongMessage = new TextEncoder().encode('Wrong message');

      const signature = service.sign(message, identity.privateKey);
      const isValid = service.verify(wrongMessage, signature, identity.publicKey);

      expect(isValid).toBe(false);
    });

    it('should fail verification with wrong public key', () => {
      const identity1 = service.generate();
      const identity2 = service.generate();
      const message = new TextEncoder().encode('Hello, dMail!');

      const signature = service.sign(message, identity1.privateKey);
      const isValid = service.verify(message, signature, identity2.publicKey);

      expect(isValid).toBe(false);
    });

    it('should fail verification with tampered signature', () => {
      const identity = service.generate();
      const message = new TextEncoder().encode('Hello, dMail!');

      const signature = service.sign(message, identity.privateKey);
      signature[0] = signature[0] ^ 0xff; // Tamper with signature

      const isValid = service.verify(message, signature, identity.publicKey);
      expect(isValid).toBe(false);
    });
  });

  describe('serialize and deserialize', () => {
    it('should serialize and deserialize an identity', () => {
      const identity = service.generate();
      const serialized = service.serialize(identity);

      expect(typeof serialized.address).toBe('string');
      expect(typeof serialized.publicKey).toBe('string');
      expect(typeof serialized.privateKey).toBe('string');
      expect(typeof serialized.encryptionPublicKey).toBe('string');
      expect(typeof serialized.encryptionPrivateKey).toBe('string');

      const deserialized = service.deserialize(serialized);

      expect(deserialized.address).toBe(identity.address);
      expect(Buffer.from(deserialized.publicKey).toString('hex')).toBe(
        Buffer.from(identity.publicKey).toString('hex'),
      );
      expect(Buffer.from(deserialized.privateKey).toString('hex')).toBe(
        Buffer.from(identity.privateKey).toString('hex'),
      );
      expect(deserialized.routingToken).toBe(identity.routingToken);
      expect(deserialized.createdAt).toBe(identity.createdAt);
    });

    it('should preserve signing capability after deserialization', () => {
      const identity = service.generate();
      const serialized = service.serialize(identity);
      const deserialized = service.deserialize(serialized);

      const message = new TextEncoder().encode('Test message');
      const signature = service.sign(message, deserialized.privateKey);
      const isValid = service.verify(message, signature, deserialized.publicKey);

      expect(isValid).toBe(true);
    });
  });

  describe('getPublicIdentity', () => {
    it('should return only public information', () => {
      const identity = service.generate();
      const publicIdentity = service.getPublicIdentity(identity);

      expect(publicIdentity.address).toBe(identity.address);
      expect(publicIdentity.publicKey).toBeDefined();
      expect(publicIdentity.encryptionPublicKey).toBeDefined();
      expect((publicIdentity as any).privateKey).toBeUndefined();
      expect((publicIdentity as any).encryptionPrivateKey).toBeUndefined();
      expect((publicIdentity as any).routingToken).toBeUndefined();
    });
  });

  describe('isValidAddress', () => {
    it('should validate a correct dMail address', () => {
      const identity = service.generate();
      expect(service.isValidAddress(identity.address)).toBe(true);
    });

    it('should reject an invalid address', () => {
      expect(service.isValidAddress('invalid')).toBe(false);
      expect(service.isValidAddress('')).toBe(false);
      expect(service.isValidAddress('bc1qtest')).toBe(false); // bitcoin address
    });

    it('should reject addresses with wrong prefix', () => {
      expect(service.isValidAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe(false);
    });
  });
});
