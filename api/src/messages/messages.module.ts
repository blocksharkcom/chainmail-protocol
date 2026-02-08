import { Module } from '@nestjs/common';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { IdentityController } from './identity.controller';
import { NodeController } from '../network/node.controller';

@Module({
  controllers: [MessagesController, IdentityController, NodeController],
  providers: [MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}
