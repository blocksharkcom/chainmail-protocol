import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { WalletGuard } from './wallet.guard';

@Module({
  controllers: [AuthController],
  providers: [AuthService, WalletGuard],
  exports: [AuthService, WalletGuard],
})
export class AuthModule {}
