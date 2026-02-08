import { Module, Global } from '@nestjs/common';
import { IdentityService } from './identity.service';
import { EncryptionService } from './encryption.service';
import { DoubleRatchetService } from './double-ratchet.service';

@Global()
@Module({
  providers: [IdentityService, EncryptionService, DoubleRatchetService],
  exports: [IdentityService, EncryptionService, DoubleRatchetService],
})
export class CryptoModule {}
