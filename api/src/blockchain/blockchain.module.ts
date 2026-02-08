import { Module, Global } from '@nestjs/common';
import { RegistryService } from './registry.service';
import { TokenService } from './token.service';

@Global()
@Module({
  providers: [RegistryService, TokenService],
  exports: [RegistryService, TokenService],
})
export class BlockchainModule {}
