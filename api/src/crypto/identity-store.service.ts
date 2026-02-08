import { Injectable } from '@nestjs/common';
import { Identity } from './interfaces/identity.interface';
import { IdentityService } from './identity.service';
import { writeFile, readFile, mkdir, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DMAIL_DIR = join(homedir(), '.dmail');
const IDENTITIES_DIR = join(DMAIL_DIR, 'identities');

/**
 * Multi-user identity store for local development.
 * Stores identities in ~/.dmail/identities/{address}.json
 * and keeps them in memory for quick access.
 */
@Injectable()
export class IdentityStoreService {
  private identities: Map<string, Identity> = new Map();

  constructor(private readonly identityService: IdentityService) {}

  /**
   * Ensure the identities directory exists
   */
  private async ensureDir(): Promise<void> {
    if (!existsSync(IDENTITIES_DIR)) {
      await mkdir(IDENTITIES_DIR, { recursive: true });
    }
  }

  /**
   * Generate and store a new identity
   */
  async createIdentity(name?: string): Promise<Identity> {
    await this.ensureDir();

    const identity = this.identityService.generate();
    const serialized = this.identityService.serialize(identity);
    const identityData = { ...serialized, name };

    // Store in file system
    const filePath = join(IDENTITIES_DIR, `${identity.address}.json`);
    await writeFile(filePath, JSON.stringify(identityData, null, 2));

    // Also update the legacy identity.json for backwards compatibility
    await writeFile(join(DMAIL_DIR, 'identity.json'), JSON.stringify(identityData, null, 2));

    // Store in memory
    this.identities.set(identity.address, identity);

    return identity;
  }

  /**
   * Get an identity by address
   */
  async getIdentity(address: string): Promise<Identity | null> {
    // Check memory first
    if (this.identities.has(address)) {
      return this.identities.get(address)!;
    }

    // Try to load from file
    await this.ensureDir();
    const filePath = join(IDENTITIES_DIR, `${address}.json`);

    if (!existsSync(filePath)) {
      return null;
    }

    try {
      const data = await readFile(filePath, 'utf-8');
      const serialized = JSON.parse(data);
      const identity = this.identityService.deserialize(serialized);
      this.identities.set(address, identity);
      return identity;
    } catch {
      return null;
    }
  }

  /**
   * Load all identities from disk into memory
   */
  async loadAllIdentities(): Promise<void> {
    await this.ensureDir();

    try {
      const files = await readdir(IDENTITIES_DIR);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const filePath = join(IDENTITIES_DIR, file);
        try {
          const data = await readFile(filePath, 'utf-8');
          const serialized = JSON.parse(data);
          const identity = this.identityService.deserialize(serialized);
          this.identities.set(identity.address, identity);
        } catch (err) {
          console.warn(`Failed to load identity from ${file}:`, (err as Error).message);
        }
      }
    } catch (err) {
      console.warn('Failed to load identities:', (err as Error).message);
    }

    // Also try to load the legacy identity.json
    const legacyPath = join(DMAIL_DIR, 'identity.json');
    if (existsSync(legacyPath)) {
      try {
        const data = await readFile(legacyPath, 'utf-8');
        const serialized = JSON.parse(data);
        const identity = this.identityService.deserialize(serialized);

        // If not already loaded, add it
        if (!this.identities.has(identity.address)) {
          this.identities.set(identity.address, identity);

          // Also save to the new location
          const newPath = join(IDENTITIES_DIR, `${identity.address}.json`);
          await writeFile(newPath, data);
        }
      } catch (err) {
        console.warn('Failed to load legacy identity:', (err as Error).message);
      }
    }
  }

  /**
   * Get all loaded identities
   */
  getAllIdentities(): Identity[] {
    return Array.from(this.identities.values());
  }

  /**
   * Check if an identity exists
   */
  hasIdentity(address: string): boolean {
    return this.identities.has(address);
  }

  /**
   * Get the first/default identity (for backwards compatibility)
   */
  getDefaultIdentity(): Identity | null {
    const identities = this.getAllIdentities();
    return identities.length > 0 ? identities[0] : null;
  }
}
