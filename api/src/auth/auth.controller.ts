import { Controller, Post, Body, Get, Headers, HttpException, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiHeader } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { IsString, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class RequestChallengeDto {
  @ApiPropertyOptional({ description: 'Wallet address (optional)' })
  @IsOptional()
  @IsString()
  address?: string;
}

class VerifySignatureDto {
  @ApiProperty({ description: 'The challenge that was signed' })
  @IsString()
  challenge: string;

  @ApiProperty({ description: 'The signature from the wallet' })
  @IsString()
  signature: string;

  @ApiPropertyOptional({ description: 'Expected wallet address (optional)' })
  @IsOptional()
  @IsString()
  address?: string;
}

class ChallengeResponseDto {
  @ApiProperty()
  challenge: string;

  @ApiProperty()
  message: string;

  @ApiProperty()
  expiresAt: number;
}

class AuthResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiPropertyOptional()
  token?: string;

  @ApiPropertyOptional()
  address?: string;

  @ApiPropertyOptional()
  error?: string;
}

@ApiTags('auth')
@Controller('api/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('challenge')
  @ApiOperation({ summary: 'Request an authentication challenge' })
  @ApiResponse({ status: 200, description: 'Challenge generated', type: ChallengeResponseDto })
  async requestChallenge(@Body() dto: RequestChallengeDto): Promise<ChallengeResponseDto> {
    const challenge = this.authService.generateChallenge(dto.address);
    const message = this.authService.getMessageToSign(challenge.challenge);

    return {
      challenge: challenge.challenge,
      message: message || '',
      expiresAt: challenge.expiresAt,
    };
  }

  @Post('verify')
  @ApiOperation({ summary: 'Verify a signed challenge' })
  @ApiResponse({ status: 200, description: 'Verification result', type: AuthResponseDto })
  async verifySignature(@Body() dto: VerifySignatureDto): Promise<AuthResponseDto> {
    const result = await this.authService.verifySignature(
      dto.challenge,
      dto.signature,
      dto.address,
    );

    if (!result.valid) {
      return {
        success: false,
        error: result.error,
      };
    }

    // Create a session token
    const token = this.authService.createSession(result.address!);

    return {
      success: true,
      token,
      address: result.address,
    };
  }

  @Get('session')
  @ApiOperation({ summary: 'Validate current session' })
  @ApiHeader({ name: 'Authorization', description: 'Bearer token' })
  @ApiResponse({ status: 200, description: 'Session info' })
  @ApiResponse({ status: 401, description: 'Invalid or expired session' })
  async validateSession(
    @Headers('authorization') authHeader: string,
  ): Promise<{ valid: boolean; address?: string }> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new HttpException('Missing authorization header', HttpStatus.UNAUTHORIZED);
    }

    const token = authHeader.slice(7);
    const result = this.authService.validateSession(token);

    if (!result.valid) {
      throw new HttpException('Invalid or expired session', HttpStatus.UNAUTHORIZED);
    }

    return result;
  }

  @Post('logout')
  @ApiOperation({ summary: 'Invalidate current session' })
  @ApiHeader({ name: 'Authorization', description: 'Bearer token' })
  @ApiResponse({ status: 200, description: 'Session invalidated' })
  async logout(@Headers('authorization') authHeader: string): Promise<{ success: boolean }> {
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      this.authService.invalidateSession(token);
    }

    return { success: true };
  }
}
