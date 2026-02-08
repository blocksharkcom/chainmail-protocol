import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { MessagesService } from './messages.service';
import {
  SendMessageDto,
  EncryptedMessageDto,
  MessageResponseDto,
} from './dto/message.dto';
import { RegistryService } from '../blockchain/registry.service';

@ApiTags('messages')
@Controller('api/messages')
export class MessagesController {
  constructor(
    private readonly messagesService: MessagesService,
    private readonly registryService: RegistryService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get inbox messages' })
  @ApiResponse({ status: 200, description: 'List of messages', type: [MessageResponseDto] })
  async getInbox(): Promise<MessageResponseDto[]> {
    const messages = await this.messagesService.getInbox();

    return messages.map((msg) => {
      const decrypted = this.messagesService.decryptMessage(msg);
      return {
        id: (msg as any).id || '',
        from: msg.from || '',
        to: msg.to || '',
        subject: decrypted?.subject,
        body: decrypted?.body,
        timestamp: msg.timestamp,
        read: msg.read,
        encrypted: decrypted ? undefined : msg.encrypted,
      };
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a specific message' })
  @ApiParam({ name: 'id', description: 'Message ID' })
  @ApiResponse({ status: 200, description: 'Message details', type: MessageResponseDto })
  @ApiResponse({ status: 404, description: 'Message not found' })
  async getMessage(@Param('id') id: string): Promise<MessageResponseDto> {
    const message = await this.messagesService.getMessage(id);

    if (!message) {
      throw new HttpException('Message not found', HttpStatus.NOT_FOUND);
    }

    const decrypted = this.messagesService.decryptMessage(message);

    return {
      id,
      from: message.from || '',
      to: message.to || '',
      subject: decrypted?.subject,
      body: decrypted?.body,
      timestamp: message.timestamp,
      read: message.read,
      encrypted: decrypted ? undefined : message.encrypted,
    };
  }

  @Post()
  @ApiOperation({ summary: 'Send a new message' })
  @ApiResponse({ status: 201, description: 'Message sent successfully' })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  async sendMessage(@Body() dto: SendMessageDto): Promise<{ messageId: string; timestamp: number }> {
    // Look up recipient's encryption key
    const recipientInfo = await this.registryService.lookupByAddress(dto.to);

    if (!recipientInfo) {
      throw new HttpException('Recipient not found in registry', HttpStatus.BAD_REQUEST);
    }

    const recipientKey = new Uint8Array(Buffer.from(recipientInfo.encryptionKey, 'hex'));

    const result = await this.messagesService.sendMessage(
      dto.to,
      dto.subject,
      dto.body,
      recipientKey,
    );

    return result;
  }

  @Post('encrypted')
  @ApiOperation({ summary: 'Send a pre-encrypted message' })
  @ApiResponse({ status: 201, description: 'Message sent successfully' })
  async sendEncryptedMessage(
    @Body() dto: EncryptedMessageDto,
  ): Promise<{ messageId: string; timestamp: number }> {
    const result = await this.messagesService.sendEncryptedMessage(
      dto.to,
      dto.encrypted,
      dto.routingToken,
    );

    return result;
  }

  @Post(':id/read')
  @ApiOperation({ summary: 'Mark a message as read' })
  @ApiParam({ name: 'id', description: 'Message ID' })
  @ApiResponse({ status: 200, description: 'Message marked as read' })
  async markAsRead(@Param('id') id: string): Promise<{ success: boolean }> {
    await this.messagesService.markAsRead(id);
    return { success: true };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a message' })
  @ApiParam({ name: 'id', description: 'Message ID' })
  @ApiResponse({ status: 200, description: 'Message deleted' })
  async deleteMessage(@Param('id') id: string): Promise<{ success: boolean }> {
    await this.messagesService.deleteMessage(id);
    return { success: true };
  }
}
