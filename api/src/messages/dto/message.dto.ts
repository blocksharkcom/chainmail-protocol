import { IsString, IsOptional, IsObject, IsNumber } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SendMessageDto {
  @ApiProperty({ description: 'Recipient dMail address' })
  @IsString()
  to: string;

  @ApiProperty({ description: 'Message subject' })
  @IsString()
  subject: string;

  @ApiProperty({ description: 'Message body content' })
  @IsString()
  body: string;

  @ApiPropertyOptional({ description: 'Optional attachments metadata' })
  @IsOptional()
  @IsObject()
  attachments?: Record<string, unknown>;
}

export class EncryptedMessageDto {
  @ApiProperty({ description: 'Recipient dMail address or routing token' })
  @IsString()
  to: string;

  @ApiProperty({ description: 'Encrypted payload' })
  @IsObject()
  encrypted: {
    ephemeralPublicKey: string;
    nonce: string;
    ciphertext: string;
  };

  @ApiPropertyOptional({ description: 'Routing token for sealed envelopes' })
  @IsOptional()
  @IsString()
  routingToken?: string;
}

export class MessageResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  from: string;

  @ApiProperty()
  to: string;

  @ApiPropertyOptional()
  subject?: string;

  @ApiPropertyOptional()
  body?: string;

  @ApiProperty()
  timestamp: number;

  @ApiProperty()
  read: boolean;

  @ApiPropertyOptional()
  encrypted?: unknown;
}

export class CreateIdentityDto {
  @ApiPropertyOptional({ description: 'Optional display name for the identity' })
  @IsOptional()
  @IsString()
  name?: string;
}

export class IdentityResponseDto {
  @ApiProperty({ description: 'dMail address' })
  address: string;

  @ApiProperty({ description: 'Public signing key (base64)' })
  publicKey: string;

  @ApiProperty({ description: 'Public encryption key (base64)' })
  encryptionPublicKey: string;

  @ApiPropertyOptional({ description: 'Display name' })
  name?: string;

  @ApiProperty({ description: 'Creation timestamp' })
  createdAt: number;
}

export class LookupRecipientDto {
  @ApiProperty({ description: 'Address or registered name to look up' })
  @IsString()
  addressOrName: string;
}

export class RecipientInfoDto {
  @ApiProperty()
  address: string;

  @ApiProperty()
  encryptionPublicKey: string;

  @ApiPropertyOptional()
  name?: string;
}
