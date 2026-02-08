import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { IdentityService } from '../crypto/identity.service';
import { IdentityStoreService } from '../crypto/identity-store.service';
import { P2PNodeService } from '../network/p2p-node.service';
import { MessagesService } from './messages.service';
import { RegistryService } from '../blockchain/registry.service';
import {
  CreateIdentityDto,
  IdentityResponseDto,
  LookupRecipientDto,
  RecipientInfoDto,
} from './dto/message.dto';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DMAIL_DIR = join(homedir(), '.dmail');

@ApiTags('identity')
@Controller('api/identity')
export class IdentityController {
  constructor(
    private readonly identityService: IdentityService,
    private readonly identityStore: IdentityStoreService,
    private readonly p2pNode: P2PNodeService,
    private readonly messagesService: MessagesService,
    private readonly registryService: RegistryService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a new identity' })
  @ApiResponse({ status: 201, description: 'Identity created', type: IdentityResponseDto })
  async createIdentity(@Body() dto: CreateIdentityDto): Promise<IdentityResponseDto> {
    // Create identity using the store service (auto-persists to ~/.dmail/identities/)
    const identity = await this.identityStore.createIdentity(dto.name);

    // Register in local registry (for development without blockchain)
    this.registryService.registerLocal(
      dto.name || identity.address,
      identity.address,
      Buffer.from(identity.publicKey).toString('hex'),
      Buffer.from(identity.encryptionPublicKey).toString('hex'),
    );

    // Initialize services with the new identity
    await this.messagesService.setIdentity(identity);

    // Try to start P2P node (may fail in some environments due to ESM issues)
    try {
      await this.p2pNode.initialize(identity);
      await this.p2pNode.start();
    } catch (err) {
      console.warn('P2P node initialization failed (ESM module issue):', (err as Error).message);
      console.warn('Continuing without P2P - messages will be stored locally only');
    }

    return {
      address: identity.address,
      publicKey: Buffer.from(identity.publicKey).toString('base64'),
      encryptionPublicKey: Buffer.from(identity.encryptionPublicKey).toString('base64'),
      name: dto.name,
      createdAt: identity.createdAt,
    };
  }

  @Get()
  @ApiOperation({ summary: 'Get current identity' })
  @ApiResponse({ status: 200, description: 'Current identity', type: IdentityResponseDto })
  @ApiResponse({ status: 404, description: 'No identity found' })
  async getCurrentIdentity(): Promise<IdentityResponseDto> {
    const identityPath = join(DMAIL_DIR, 'identity.json');

    if (!existsSync(identityPath)) {
      throw new HttpException('No identity found', HttpStatus.NOT_FOUND);
    }

    const data = await readFile(identityPath, 'utf-8');
    const identityData = JSON.parse(data);

    return {
      address: identityData.address,
      publicKey: identityData.publicKey,
      encryptionPublicKey: identityData.encryptionPublicKey,
      name: identityData.name,
      createdAt: identityData.createdAt,
    };
  }

  @Post('load')
  @ApiOperation({ summary: 'Load existing identity and start node' })
  @ApiResponse({ status: 200, description: 'Identity loaded' })
  @ApiResponse({ status: 404, description: 'No identity found' })
  async loadIdentity(): Promise<{ success: boolean; address: string }> {
    const identityPath = join(DMAIL_DIR, 'identity.json');

    if (!existsSync(identityPath)) {
      throw new HttpException('No identity found', HttpStatus.NOT_FOUND);
    }

    const data = await readFile(identityPath, 'utf-8');
    const serialized = JSON.parse(data);
    const identity = this.identityService.deserialize(serialized);

    // Register in local registry (for development without blockchain)
    this.registryService.registerLocal(
      serialized.name || identity.address,
      identity.address,
      Buffer.from(identity.publicKey).toString('hex'),
      Buffer.from(identity.encryptionPublicKey).toString('hex'),
    );

    // Initialize services
    await this.messagesService.setIdentity(identity);

    // Try to start P2P node (may fail in some environments due to ESM issues)
    try {
      await this.p2pNode.initialize(identity);
      await this.p2pNode.start();
    } catch (err) {
      console.warn('P2P node initialization failed (ESM module issue):', (err as Error).message);
      console.warn('Continuing without P2P - messages will be stored locally only');
    }

    return {
      success: true,
      address: identity.address,
    };
  }

  @Post('lookup')
  @ApiOperation({ summary: 'Look up a recipient by address or name' })
  @ApiResponse({ status: 200, description: 'Recipient info', type: RecipientInfoDto })
  @ApiResponse({ status: 404, description: 'Recipient not found' })
  async lookupRecipient(@Body() dto: LookupRecipientDto): Promise<RecipientInfoDto> {
    // Try to resolve via blockchain registry
    const registryInfo = await this.registryService.lookupByName(dto.addressOrName);

    if (registryInfo) {
      return {
        address: registryInfo.dmailAddress,
        encryptionPublicKey: registryInfo.encryptionKey,
        name: registryInfo.name,
      };
    }

    // If it looks like an address, try lookup by address
    if (dto.addressOrName.startsWith('dm1')) {
      const byAddress = await this.registryService.lookupByAddress(dto.addressOrName);
      if (byAddress) {
        return {
          address: byAddress.dmailAddress,
          encryptionPublicKey: byAddress.encryptionKey,
          name: byAddress.name,
        };
      }
    }

    throw new HttpException('Recipient not found', HttpStatus.NOT_FOUND);
  }

  @Get('node')
  @ApiOperation({ summary: 'Get P2P node info' })
  @ApiResponse({ status: 200, description: 'Node info' })
  async getNodeInfo(): Promise<{
    peerId: string | undefined;
    address: string;
    peers: number;
    addresses: string[];
  }> {
    return this.messagesService.getNodeInfo();
  }
}
