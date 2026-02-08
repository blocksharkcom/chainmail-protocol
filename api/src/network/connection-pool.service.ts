import { Injectable, OnModuleDestroy } from '@nestjs/common';

export interface ConnectionInfo {
  peerId: any;
  connectedAt: number;
  lastActivity: number;
  messagesReceived: number;
  messagesSent: number;
  bytesReceived: number;
  bytesSent: number;
  latency: number | null;
  isRelay: boolean;
}

export interface RelayNodeInfo {
  peerId: string;
  discoveredAt: number;
  successfulRequests: number;
  failedRequests: number;
  averageLatency: number | null;
  score: number;
  multiaddr?: string;
}

export interface PoolMetrics {
  totalConnections: number;
  activeConnections: number;
  failedConnections: number;
  bytesTransferred: number;
  messagesRouted: number;
}

export interface PoolStatus {
  activeConnections: number;
  relayConnections: number;
  knownRelays: number;
  bestRelays: RelayNodeInfo[];
  metrics: PoolMetrics;
}

export interface QueuedMessage {
  message: unknown;
  priority: number;
  enqueuedAt: number;
}

@Injectable()
export class ConnectionPoolService implements OnModuleDestroy {
  private node: any = null;
  private maxConnections = 50;
  private minRelayConnections = 3;
  private healthCheckInterval = 30000;
  private reconnectBackoffBase = 1000;
  private maxReconnectBackoff = 60000;

  private connections: Map<string, ConnectionInfo> = new Map();
  private relayNodes: Map<string, RelayNodeInfo> = new Map();
  private failedAttempts: Map<string, { count: number; lastAttempt: number }> = new Map();

  private metrics: PoolMetrics = {
    totalConnections: 0,
    activeConnections: 0,
    failedConnections: 0,
    bytesTransferred: 0,
    messagesRouted: 0,
  };

  private healthCheckTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

  // Message queue
  private queue: QueuedMessage[] = [];
  private maxQueueSize = 1000;
  private batchSize = 10;
  private batchIntervalMs = 100;
  private processing = false;
  private onBatchReady: ((messages: unknown[]) => Promise<void>) | null = null;

  onModuleDestroy(): void {
    this.stop();
  }

  /**
   * Initialize with libp2p node
   */
  initialize(node: any): void {
    this.node = node;
  }

  /**
   * Start the connection pool manager
   */
  async start(): Promise<void> {
    if (!this.node) {
      throw new Error('Node not initialized');
    }

    this.isRunning = true;

    this.node.addEventListener('peer:connect', (evt: any) => {
      this.onPeerConnect(evt.detail);
    });

    this.node.addEventListener('peer:disconnect', (evt: any) => {
      this.onPeerDisconnect(evt.detail);
    });

    this.healthCheckTimer = setInterval(() => this.healthCheck(), this.healthCheckInterval);

    await this.bootstrapConnections();
  }

  /**
   * Stop the connection pool manager
   */
  stop(): void {
    this.isRunning = false;

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Handle new peer connection
   */
  private onPeerConnect(peerId: any): void {
    const peerIdStr = peerId.toString();

    this.failedAttempts.delete(peerIdStr);

    this.connections.set(peerIdStr, {
      peerId,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      messagesReceived: 0,
      messagesSent: 0,
      bytesReceived: 0,
      bytesSent: 0,
      latency: null,
      isRelay: false,
    });

    this.metrics.totalConnections++;
    this.metrics.activeConnections = this.connections.size;

    this.checkIfRelay(peerIdStr);
  }

  /**
   * Handle peer disconnection
   */
  private onPeerDisconnect(peerId: any): void {
    const peerIdStr = peerId.toString();

    this.connections.delete(peerIdStr);
    this.metrics.activeConnections = this.connections.size;

    if (this.relayNodes.has(peerIdStr)) {
      this.scheduleReconnect(peerIdStr);
    }
  }

  /**
   * Check if a peer is a relay node
   */
  private async checkIfRelay(peerIdStr: string): Promise<void> {
    if (!this.node) return;

    try {
      const connection = this.node.getConnections().find(
        (c: any) => c.remotePeer.toString() === peerIdStr,
      );

      if (connection) {
        // Check if peer supports dmail storage protocol
        const identify = this.node.services.identify as {
          identify?: (conn: unknown) => Promise<{ protocols?: string[] }>;
        };
        if (identify?.identify) {
          const protocols = await identify.identify(connection);
          if (protocols?.protocols?.includes('/dmail/storage/1.0.0/store')) {
            this.markAsRelay(peerIdStr);
          }
        }
      }
    } catch {
      // Not a relay or couldn't identify
    }
  }

  /**
   * Mark a peer as a relay node
   */
  markAsRelay(peerIdStr: string): void {
    const connInfo = this.connections.get(peerIdStr);
    if (connInfo) {
      connInfo.isRelay = true;
    }

    if (!this.relayNodes.has(peerIdStr)) {
      this.relayNodes.set(peerIdStr, {
        peerId: peerIdStr,
        discoveredAt: Date.now(),
        successfulRequests: 0,
        failedRequests: 0,
        averageLatency: null,
        score: 100,
      });
    }
  }

  /**
   * Bootstrap initial connections
   */
  private async bootstrapConnections(): Promise<void> {
    // Bootstrap nodes can be configured via environment
    const bootstrapNodes: string[] = [];

    for (const addr of bootstrapNodes) {
      try {
        await this.node?.dial(addr as any);
      } catch {
        // Failed to connect to bootstrap
      }
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(peerIdStr: string): void {
    if (!this.isRunning) return;

    const attempts = this.failedAttempts.get(peerIdStr) || { count: 0, lastAttempt: 0 };
    const backoff = Math.min(
      this.reconnectBackoffBase * Math.pow(2, attempts.count),
      this.maxReconnectBackoff,
    );

    setTimeout(async () => {
      if (!this.isRunning) return;

      try {
        const relayInfo = this.relayNodes.get(peerIdStr);
        if (relayInfo?.multiaddr) {
          await this.node?.dial(relayInfo.multiaddr as any);
        }
      } catch {
        this.failedAttempts.set(peerIdStr, {
          count: attempts.count + 1,
          lastAttempt: Date.now(),
        });
        this.metrics.failedConnections++;

        if (attempts.count < 5) {
          this.scheduleReconnect(peerIdStr);
        }
      }
    }, backoff);
  }

  /**
   * Health check all connections
   */
  private async healthCheck(): Promise<void> {
    if (!this.isRunning) return;

    const now = Date.now();
    const staleThreshold = 5 * 60 * 1000;

    for (const [peerIdStr, info] of this.connections.entries()) {
      if (now - info.lastActivity > staleThreshold) {
        try {
          const latency = await this.pingPeer(peerIdStr);
          info.lastActivity = now;
          info.latency = latency;

          if (info.isRelay) {
            this.updateRelayScore(peerIdStr, latency);
          }
        } catch {
          // Stale connection
        }
      }
    }

    await this.ensureMinRelayConnections();
  }

  /**
   * Ping a peer and measure latency
   */
  private async pingPeer(peerIdStr: string): Promise<number> {
    const start = Date.now();
    const ping = this.node?.services.ping as { ping?: (id: string) => Promise<void> };
    if (ping?.ping) {
      await ping.ping(peerIdStr);
    }
    return Date.now() - start;
  }

  /**
   * Update relay node score based on performance
   */
  updateRelayScore(peerIdStr: string, latency: number): void {
    const relay = this.relayNodes.get(peerIdStr);
    if (!relay) return;

    if (relay.averageLatency === null) {
      relay.averageLatency = latency;
    } else {
      relay.averageLatency = relay.averageLatency * 0.8 + latency * 0.2;
    }

    const latencyScore = Math.max(0, 100 - relay.averageLatency / 10);
    const reliabilityScore =
      (relay.successfulRequests / (relay.successfulRequests + relay.failedRequests + 1)) * 100;

    relay.score = latencyScore * 0.4 + reliabilityScore * 0.6;
  }

  /**
   * Record successful request to relay
   */
  recordRelaySuccess(peerIdStr: string, latency: number): void {
    const relay = this.relayNodes.get(peerIdStr);
    if (relay) {
      relay.successfulRequests++;
      this.updateRelayScore(peerIdStr, latency);
    }

    const conn = this.connections.get(peerIdStr);
    if (conn) {
      conn.lastActivity = Date.now();
      conn.messagesSent++;
    }

    this.metrics.messagesRouted++;
  }

  /**
   * Record failed request to relay
   */
  recordRelayFailure(peerIdStr: string): void {
    const relay = this.relayNodes.get(peerIdStr);
    if (relay) {
      relay.failedRequests++;
      relay.score = Math.max(0, relay.score - 10);
    }
  }

  /**
   * Ensure minimum relay connections
   */
  private async ensureMinRelayConnections(): Promise<void> {
    const activeRelays = Array.from(this.connections.values()).filter((c) => c.isRelay).length;

    if (activeRelays < this.minRelayConnections) {
      for (const [peerIdStr] of this.relayNodes.entries()) {
        if (!this.connections.has(peerIdStr)) {
          this.scheduleReconnect(peerIdStr);
        }
      }
    }
  }

  /**
   * Get best relay nodes for message routing
   */
  getBestRelays(count = 3): RelayNodeInfo[] {
    const activeRelays = Array.from(this.relayNodes.entries())
      .filter(([id]) => this.connections.has(id))
      .map(([id, info]) => ({ ...info, peerId: id }))
      .sort((a, b) => b.score - a.score);

    return activeRelays.slice(0, count);
  }

  /**
   * Get a relay for load-balanced routing
   */
  getRelayForRouting(): string | null {
    const relays = this.getBestRelays(5);
    if (relays.length === 0) return null;

    const totalScore = relays.reduce((sum, r) => sum + r.score, 0);
    let random = Math.random() * totalScore;

    for (const relay of relays) {
      random -= relay.score;
      if (random <= 0) {
        return relay.peerId;
      }
    }

    return relays[0].peerId;
  }

  /**
   * Get pool status
   */
  getStatus(): PoolStatus {
    return {
      activeConnections: this.connections.size,
      relayConnections: Array.from(this.connections.values()).filter((c) => c.isRelay).length,
      knownRelays: this.relayNodes.size,
      bestRelays: this.getBestRelays(3),
      metrics: { ...this.metrics },
    };
  }

  // Message queue methods

  /**
   * Set batch ready callback
   */
  setBatchHandler(handler: (messages: unknown[]) => Promise<void>): void {
    this.onBatchReady = handler;
  }

  /**
   * Add message to queue
   */
  enqueue(message: unknown, priority = 5): void {
    if (this.queue.length >= this.maxQueueSize) {
      throw new Error('Message queue full');
    }

    this.queue.push({
      message,
      priority,
      enqueuedAt: Date.now(),
    });

    this.queue.sort((a, b) => a.priority - b.priority);
    this.scheduleBatchProcess();
  }

  /**
   * Schedule batch processing
   */
  private scheduleBatchProcess(): void {
    if (this.processing) return;

    this.processing = true;
    setTimeout(() => this.processBatch(), this.batchIntervalMs);
  }

  /**
   * Process a batch of messages
   */
  private async processBatch(): Promise<void> {
    if (this.queue.length === 0) {
      this.processing = false;
      return;
    }

    const batch = this.queue.splice(0, this.batchSize);

    if (this.onBatchReady) {
      await this.onBatchReady(batch.map((b) => b.message));
    }

    if (this.queue.length > 0) {
      setTimeout(() => this.processBatch(), this.batchIntervalMs);
    } else {
      this.processing = false;
    }
  }

  /**
   * Get queue status
   */
  getQueueStatus(): { queueLength: number; maxSize: number; processing: boolean } {
    return {
      queueLength: this.queue.length,
      maxSize: this.maxQueueSize,
      processing: this.processing,
    };
  }

  /**
   * Clear the queue
   */
  clearQueue(): void {
    this.queue = [];
  }
}
