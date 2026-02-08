import { Controller, Get, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { P2PNodeService } from './p2p-node.service';
import { MessagesService } from '../messages/messages.service';
import { IdentityService } from '../crypto/identity.service';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DMAIL_DIR = join(homedir(), '.dmail');

@ApiTags('node')
@Controller('api/node')
export class NodeController {
  constructor(
    private readonly p2pNode: P2PNodeService,
    private readonly messagesService: MessagesService,
    private readonly identityService: IdentityService,
  ) {}

  @Post('start')
  @ApiOperation({ summary: 'Start the P2P node' })
  @ApiResponse({ status: 200, description: 'Node started' })
  @ApiResponse({ status: 400, description: 'No identity loaded' })
  async startNode(): Promise<{ status: string; peerId?: string }> {
    // Check if identity exists
    const identityPath = join(DMAIL_DIR, 'identity.json');

    if (!existsSync(identityPath)) {
      return { status: 'no_identity' };
    }

    // Load identity if not already loaded
    if (!this.messagesService.getIdentity()) {
      try {
        const data = await readFile(identityPath, 'utf-8');
        const serialized = JSON.parse(data);
        const identity = this.identityService.deserialize(serialized);
        await this.messagesService.setIdentity(identity);
      } catch (err) {
        console.warn('Failed to load identity:', (err as Error).message);
        return { status: 'identity_error' };
      }
    }

    // Try to start P2P node (may fail due to ESM issues)
    if (!this.p2pNode.isNodeStarted()) {
      try {
        const identity = this.messagesService.getIdentity();
        if (identity) {
          await this.p2pNode.initialize(identity);
          await this.p2pNode.start();
        }
      } catch (err) {
        console.warn('P2P node start failed:', (err as Error).message);
        // Continue without P2P - local storage fallback
        return { status: 'local_only' };
      }
    }

    const info = this.p2pNode.getInfo();
    return {
      status: this.p2pNode.isNodeStarted() ? 'running' : 'local_only',
      peerId: info.peerId,
    };
  }

  @Get('status')
  @ApiOperation({ summary: 'Get P2P node status' })
  @ApiResponse({ status: 200, description: 'Node status' })
  async getStatus(): Promise<{
    running: boolean;
    peerId?: string;
    peerCount?: number;
  }> {
    const isRunning = this.p2pNode.isNodeStarted();

    if (!isRunning) {
      return { running: false };
    }

    const info = this.p2pNode.getInfo();
    return {
      running: true,
      peerId: info.peerId,
      peerCount: info.peers,
    };
  }
}
