import { Module } from '@nestjs/common';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { IdentityController } from './identity.controller';

@Module({
  controllers: [MessagesController, IdentityController],
  providers: [MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}
