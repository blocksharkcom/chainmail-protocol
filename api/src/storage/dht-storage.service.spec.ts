import { Test, TestingModule } from '@nestjs/testing';
import { DHTStorageService, MessageRecord } from './dht-storage.service';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('DHTStorageService', () => {
  let service: DHTStorageService;
  let testDbPath: string;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DHTStorageService],
    }).compile();

    service = module.get<DHTStorageService>(DHTStorageService);
    testDbPath = path.join(os.tmpdir(), `dmail-test-${Date.now()}`);

    await service.init({ dbPath: testDbPath });
  });

  afterEach(async () => {
    await service.close();
    // Clean up test database
    try {
      fs.rmSync(testDbPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('store and getMessages', () => {
    it('should store and retrieve a message', async () => {
      const recipient = 'dm1testrecipient';
      const data = Buffer.from('Hello, World!').toString('base64');

      const record = await service.store(recipient, data);

      expect(record).toBeDefined();
      expect(record.id).toBeDefined();
      expect(record.recipient).toBe(recipient);
      expect(record.data).toBe(data);
      expect(record.timestamp).toBeDefined();

      const messages = await service.getMessages(recipient);
      expect(messages.length).toBe(1);
      expect(messages[0].id).toBe(record.id);
    });

    it('should store multiple messages for the same recipient', async () => {
      const recipient = 'dm1testrecipient';

      await service.store(recipient, 'message1');
      await service.store(recipient, 'message2');
      await service.store(recipient, 'message3');

      const messages = await service.getMessages(recipient);
      expect(messages.length).toBe(3);
    });

    it('should return messages sorted by timestamp', async () => {
      const recipient = 'dm1testrecipient';

      await service.store(recipient, 'first');
      await new Promise((resolve) => setTimeout(resolve, 10));
      await service.store(recipient, 'second');
      await new Promise((resolve) => setTimeout(resolve, 10));
      await service.store(recipient, 'third');

      const messages = await service.getMessages(recipient);
      expect(messages[0].data).toBe('first');
      expect(messages[1].data).toBe('second');
      expect(messages[2].data).toBe('third');
    });

    it('should return empty array for recipient with no messages', async () => {
      const messages = await service.getMessages('dm1nonexistent');
      expect(messages).toEqual([]);
    });
  });

  describe('getMessage', () => {
    it('should retrieve a specific message', async () => {
      const recipient = 'dm1testrecipient';
      const record = await service.store(recipient, 'test message');

      const retrieved = await service.getMessage(recipient, record.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(record.id);
      expect(retrieved?.data).toBe('test message');
    });

    it('should return null for non-existent message', async () => {
      const retrieved = await service.getMessage('dm1test', 'nonexistent');
      expect(retrieved).toBeNull();
    });
  });

  describe('deleteMessage', () => {
    it('should delete a message', async () => {
      const recipient = 'dm1testrecipient';
      const record = await service.store(recipient, 'to be deleted');

      await service.deleteMessage(recipient, record.id);

      const retrieved = await service.getMessage(recipient, record.id);
      expect(retrieved).toBeNull();
    });

    it('should not throw when deleting non-existent message', async () => {
      await expect(service.deleteMessage('dm1test', 'nonexistent')).resolves.not.toThrow();
    });
  });

  describe('storeRecord', () => {
    it('should store a message record directly', async () => {
      const record = new MessageRecord({
        recipient: 'dm1test',
        data: 'direct record',
        timestamp: Date.now(),
      });

      await service.storeRecord(record);

      const retrieved = await service.getMessage('dm1test', record.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.data).toBe('direct record');
    });
  });

  describe('addressToKey', () => {
    it('should derive consistent keys for the same address', () => {
      const key1 = service.addressToKey('dm1test');
      const key2 = service.addressToKey('dm1test');

      expect(Buffer.from(key1).toString('hex')).toBe(Buffer.from(key2).toString('hex'));
    });

    it('should derive different keys for different addresses', () => {
      const key1 = service.addressToKey('dm1alice');
      const key2 = service.addressToKey('dm1bob');

      expect(Buffer.from(key1).toString('hex')).not.toBe(Buffer.from(key2).toString('hex'));
    });
  });

  describe('getStats', () => {
    it('should return storage statistics', async () => {
      await service.store('dm1alice', 'message1');
      await service.store('dm1alice', 'message2');
      await service.store('dm1bob', 'message3');

      const stats = await service.getStats();

      expect(stats.messageCount).toBe(3);
      expect(stats.uniqueRecipients).toBe(2);
      expect(stats.totalSizeBytes).toBeGreaterThan(0);
    });

    it('should return zero stats for empty storage', async () => {
      const stats = await service.getStats();

      expect(stats.messageCount).toBe(0);
      expect(stats.uniqueRecipients).toBe(0);
      expect(stats.totalSizeBytes).toBe(0);
    });
  });
});

describe('MessageRecord', () => {
  it('should create a record with auto-generated id', () => {
    const record = new MessageRecord({
      recipient: 'dm1test',
      data: 'test',
      timestamp: Date.now(),
    });

    expect(record.id).toBeDefined();
    expect(record.id.length).toBeGreaterThan(0);
  });

  it('should check expiration correctly', () => {
    const pastRecord = new MessageRecord({
      recipient: 'dm1test',
      data: 'expired',
      timestamp: Date.now() - 10 * 24 * 60 * 60 * 1000,
      expires: Date.now() - 1000, // Already expired
    });

    const freshRecord = new MessageRecord({
      recipient: 'dm1test',
      data: 'fresh',
      timestamp: Date.now(),
      expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days from now
    });

    expect(pastRecord.isExpired()).toBe(true);
    expect(freshRecord.isExpired()).toBe(false);
  });

  it('should serialize and deserialize correctly', () => {
    const record = new MessageRecord({
      recipient: 'dm1test',
      data: 'serialize test',
      timestamp: Date.now(),
    });

    const json = record.toJSON();
    const restored = MessageRecord.fromJSON(json);

    expect(restored.id).toBe(record.id);
    expect(restored.recipient).toBe(record.recipient);
    expect(restored.data).toBe(record.data);
    expect(restored.timestamp).toBe(record.timestamp);
  });
});
