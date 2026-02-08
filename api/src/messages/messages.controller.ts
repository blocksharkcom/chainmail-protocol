import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  HttpException,
  HttpStatus,
  Headers,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery, ApiHeader } from '@nestjs/swagger';
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
  @ApiOperation({ summary: 'Get inbox or sent messages' })
  @ApiQuery({ name: 'address', required: false, description: 'Filter by recipient address' })
  @ApiQuery({ name: 'type', required: false, description: 'Message type: inbox (default) or sent' })
  @ApiHeader({ name: 'x-dmail-address', required: false, description: 'Dmail address for inbox lookup' })
  @ApiResponse({ status: 200, description: 'List of messages', type: [MessageResponseDto] })
  async getInbox(
    @Query('address') queryAddress?: string,
    @Query('type') type?: string,
    @Headers('x-dmail-address') headerAddress?: string,
  ): Promise<MessageResponseDto[]> {
    // Use address from query param, header, or fall back to current identity
    const address = queryAddress || headerAddress;

    if (!address) {
      // Fall back to legacy behavior if no address provided
      const messages = await this.messagesService.getInbox();
      return messages.map((msg) => ({
        id: (msg as any).id || '',
        from: msg.from || '',
        to: msg.to || '',
        timestamp: msg.timestamp,
        read: msg.read,
        encrypted: msg.encrypted,
      }));
    }

    let messages;
    if (type === 'sent') {
      // Get sent messages for this address
      messages = await this.messagesService.getSentForAddress(address);

      // For sent messages, use the stored plaintext subject/body
      return messages.map((msg) => ({
        id: (msg as any).id || '',
        from: msg.from || '',
        to: msg.to || '',
        subject: (msg as any).plaintextSubject,
        body: (msg as any).plaintextBody,
        timestamp: msg.timestamp,
        read: true,
      }));
    } else {
      // Get inbox messages for specific address
      messages = await this.messagesService.getInboxForAddress(address);
    }

    // Get read message IDs for this user
    const readMessageIds = await this.messagesService.getReadMessageIds(address);

    // Decrypt messages using the appropriate identity
    const decryptedMessages = await Promise.all(
      messages.map(async (msg) => {
        const messageId = (msg as any).id || '';
        const recipientAddress = msg.to || address || '';
        const decrypted = await this.messagesService.decryptMessageForAddress(msg, recipientAddress);
        return {
          id: messageId,
          from: msg.from || '',
          to: msg.to || '',
          subject: decrypted?.subject,
          body: decrypted?.body,
          timestamp: msg.timestamp,
          read: readMessageIds.has(messageId),
          encrypted: decrypted ? undefined : msg.encrypted,
        };
      }),
    );

    return decryptedMessages;
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
  @ApiHeader({ name: 'x-dmail-address', required: true, description: 'Sender dmail address' })
  @ApiResponse({ status: 201, description: 'Message sent successfully' })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  async sendMessage(
    @Body() dto: SendMessageDto,
    @Headers('x-dmail-address') senderAddress?: string,
  ): Promise<{ messageId: string; timestamp: number }> {
    if (!senderAddress) {
      throw new HttpException('Sender address required (x-dmail-address header)', HttpStatus.BAD_REQUEST);
    }

    // Look up recipient's encryption key
    const recipientInfo = await this.registryService.lookupByAddress(dto.to);

    if (!recipientInfo) {
      throw new HttpException('Recipient not found in registry', HttpStatus.BAD_REQUEST);
    }

    const recipientKey = new Uint8Array(Buffer.from(recipientInfo.encryptionKey, 'hex'));

    const result = await this.messagesService.sendMessageWithSender(
      senderAddress,
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
  @ApiHeader({ name: 'x-dmail-address', required: true, description: 'Dmail address' })
  @ApiResponse({ status: 200, description: 'Message marked as read' })
  async markAsRead(
    @Param('id') id: string,
    @Headers('x-dmail-address') address?: string,
  ): Promise<{ success: boolean }> {
    if (address) {
      await this.messagesService.markAsReadForAddress(address, id);
    } else {
      await this.messagesService.markAsRead(id);
    }
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
