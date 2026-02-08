import { Module, Global } from '@nestjs/common';
import { IdentityService } from './identity.service';
import { EncryptionService } from './encryption.service';
import { DoubleRatchetService } from './double-ratchet.service';
import { IdentityStoreService } from './identity-store.service';

@Global()
@Module({
  providers: [IdentityService, EncryptionService, DoubleRatchetService, IdentityStoreService],
  exports: [IdentityService, EncryptionService, DoubleRatchetService, IdentityStoreService],
})
export class CryptoModule {}
