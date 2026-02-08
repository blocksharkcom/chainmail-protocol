import { Module, Global } from '@nestjs/common';
import { P2PNodeService } from './p2p-node.service';
import { RateLimiterService } from './rate-limiter.service';
import { ConnectionPoolService } from './connection-pool.service';
import { OnionRoutingService } from './onion-routing.service';

@Global()
@Module({
  providers: [P2PNodeService, RateLimiterService, ConnectionPoolService, OnionRoutingService],
  exports: [P2PNodeService, RateLimiterService, ConnectionPoolService, OnionRoutingService],
})
export class NetworkModule {}
