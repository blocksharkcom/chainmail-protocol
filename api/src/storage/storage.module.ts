import { Module, Global } from '@nestjs/common';
import { DHTStorageService } from './dht-storage.service';

@Global()
@Module({
  providers: [DHTStorageService],
  exports: [DHTStorageService],
})
export class StorageModule {}
