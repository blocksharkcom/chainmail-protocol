/**
 * Connection Pool Manager for dMail
 *
 * Manages and optimizes libp2p connections for better performance.
 * Features:
 * - Connection pooling with priorities
 * - Automatic reconnection with exponential backoff
 * - Health checking and dead connection pruning
 * - Relay node discovery and ranking
 * - Load balancing across multiple relays
 */

/**
 * Connection Pool Manager
 */
export class ConnectionPool {
  constructor(node, options = {}) {
    this.node = node;
    this.maxConnections = options.maxConnections || 50;
    this.minRelayConnections = options.minRelayConnections || 3;
    this.healthCheckInterval = options.healthCheckInterval || 30000;
    this.reconnectBackoffBase = options.reconnectBackoffBase || 1000;
    this.maxReconnectBackoff = options.maxReconnectBackoff || 60000;

    // Connection tracking
    this.connections = new Map(); // peerId -> ConnectionInfo
    this.relayNodes = new Map(); // peerId -> RelayNodeInfo
    this.failedAttempts = new Map(); // peerId -> {count, lastAttempt}

    // Metrics
    this.metrics = {
      totalConnections: 0,
      activeConnections: 0,
      failedConnections: 0,
      bytesTransferred: 0,
      messagesRouted: 0
    };

    this.healthCheckTimer = null;
    this.isRunning = false;
  }

  /**
   * Start the connection pool manager
   */
  async start() {
    this.isRunning = true;

    // Listen for connection events
    this.node.addEventListener('peer:connect', (evt) => {
      this.onPeerConnect(evt.detail);
    });

    this.node.addEventListener('peer:disconnect', (evt) => {
      this.onPeerDisconnect(evt.detail);
    });

    // Start health check interval
    this.healthCheckTimer = setInterval(() => this.healthCheck(), this.healthCheckInterval);

    // Initial connection to bootstrap nodes
    await this.bootstrapConnections();

    console.log('Connection pool started');
  }

  /**
   * Stop the connection pool manager
   */
  stop() {
    this.isRunning = false;

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }
  }

  /**
   * Handle new peer connection
   */
  onPeerConnect(peerId) {
    const peerIdStr = peerId.toString();

    // Reset failed attempts on successful connection
    this.failedAttempts.delete(peerIdStr);

    // Track connection
    this.connections.set(peerIdStr, {
      peerId,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      messagesReceived: 0,
      messagesSent: 0,
      bytesReceived: 0,
      bytesSent: 0,
      latency: null,
      isRelay: false
    });

    this.metrics.totalConnections++;
    this.metrics.activeConnections = this.connections.size;

    console.log(`Peer connected: ${peerIdStr.slice(0, 16)}... (${this.connections.size} total)`);

    // Check if this is a relay node
    this.checkIfRelay(peerIdStr);
  }

  /**
   * Handle peer disconnection
   */
  onPeerDisconnect(peerId) {
    const peerIdStr = peerId.toString();

    this.connections.delete(peerIdStr);
    this.metrics.activeConnections = this.connections.size;

    console.log(`Peer disconnected: ${peerIdStr.slice(0, 16)}... (${this.connections.size} remaining)`);

    // If this was a relay, try to reconnect
    if (this.relayNodes.has(peerIdStr)) {
      this.scheduleReconnect(peerIdStr);
    }
  }

  /**
   * Check if a peer is a relay node
   */
  async checkIfRelay(peerIdStr) {
    try {
      // Try to identify the peer's protocols
      const connection = this.node.getConnections().find(
        c => c.remotePeer.toString() === peerIdStr
      );

      if (connection) {
        // Check if peer supports dmail storage protocol
        const protocols = await this.node.services.identify?.identify?.(connection);
        if (protocols?.protocols?.includes('/dmail/storage/1.0.0/store')) {
          this.markAsRelay(peerIdStr);
        }
      }
    } catch (e) {
      // Not a relay or couldn't identify
    }
  }

  /**
   * Mark a peer as a relay node
   */
  markAsRelay(peerIdStr) {
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
        score: 100 // Initial score
      });

      console.log(`Relay node discovered: ${peerIdStr.slice(0, 16)}...`);
    }
  }

  /**
   * Bootstrap initial connections
   */
  async bootstrapConnections() {
    // Bootstrap nodes (can be configured)
    const bootstrapNodes = [
      // Add your bootstrap relay nodes here
      // '/ip4/127.0.0.1/tcp/4001/p2p/12D3KooW...'
    ];

    for (const addr of bootstrapNodes) {
      try {
        await this.node.dial(addr);
      } catch (e) {
        console.log(`Failed to connect to bootstrap: ${addr.slice(0, 32)}...`);
      }
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  scheduleReconnect(peerIdStr) {
    if (!this.isRunning) return;

    const attempts = this.failedAttempts.get(peerIdStr) || { count: 0, lastAttempt: 0 };
    const backoff = Math.min(
      this.reconnectBackoffBase * Math.pow(2, attempts.count),
      this.maxReconnectBackoff
    );

    console.log(`Scheduling reconnect to ${peerIdStr.slice(0, 16)}... in ${backoff}ms`);

    setTimeout(async () => {
      if (!this.isRunning) return;

      try {
        const relayInfo = this.relayNodes.get(peerIdStr);
        if (relayInfo?.multiaddr) {
          await this.node.dial(relayInfo.multiaddr);
        }
      } catch (e) {
        this.failedAttempts.set(peerIdStr, {
          count: attempts.count + 1,
          lastAttempt: Date.now()
        });
        this.metrics.failedConnections++;

        // Schedule another attempt if still needed
        if (attempts.count < 5) {
          this.scheduleReconnect(peerIdStr);
        }
      }
    }, backoff);
  }

  /**
   * Health check all connections
   */
  async healthCheck() {
    if (!this.isRunning) return;

    const now = Date.now();
    const staleThreshold = 5 * 60 * 1000; // 5 minutes

    for (const [peerIdStr, info] of this.connections.entries()) {
      // Check for stale connections
      if (now - info.lastActivity > staleThreshold) {
        // Ping to check if still alive
        try {
          const latency = await this.pingPeer(peerIdStr);
          info.lastActivity = now;
          info.latency = latency;

          // Update relay score if applicable
          if (info.isRelay) {
            this.updateRelayScore(peerIdStr, latency);
          }
        } catch (e) {
          console.log(`Stale connection detected: ${peerIdStr.slice(0, 16)}...`);
          // Let libp2p handle the disconnection
        }
      }
    }

    // Ensure minimum relay connections
    await this.ensureMinRelayConnections();

    // Log stats
    this.logStats();
  }

  /**
   * Ping a peer and measure latency
   */
  async pingPeer(peerIdStr) {
    const start = Date.now();
    try {
      await this.node.services.ping.ping(peerIdStr);
      return Date.now() - start;
    } catch (e) {
      throw e;
    }
  }

  /**
   * Update relay node score based on performance
   */
  updateRelayScore(peerIdStr, latency) {
    const relay = this.relayNodes.get(peerIdStr);
    if (!relay) return;

    // Update average latency
    if (relay.averageLatency === null) {
      relay.averageLatency = latency;
    } else {
      relay.averageLatency = (relay.averageLatency * 0.8) + (latency * 0.2);
    }

    // Calculate score (lower latency = higher score)
    const latencyScore = Math.max(0, 100 - (relay.averageLatency / 10));
    const reliabilityScore = relay.successfulRequests /
      (relay.successfulRequests + relay.failedRequests + 1) * 100;

    relay.score = (latencyScore * 0.4) + (reliabilityScore * 0.6);
  }

  /**
   * Record successful request to relay
   */
  recordRelaySuccess(peerIdStr, latency) {
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
  recordRelayFailure(peerIdStr) {
    const relay = this.relayNodes.get(peerIdStr);
    if (relay) {
      relay.failedRequests++;
      relay.score = Math.max(0, relay.score - 10);
    }
  }

  /**
   * Ensure minimum relay connections
   */
  async ensureMinRelayConnections() {
    const activeRelays = Array.from(this.connections.values())
      .filter(c => c.isRelay).length;

    if (activeRelays < this.minRelayConnections) {
      console.log(`Only ${activeRelays} relay connections, need ${this.minRelayConnections}`);

      // Try to reconnect to known relays
      for (const [peerIdStr, relayInfo] of this.relayNodes.entries()) {
        if (!this.connections.has(peerIdStr)) {
          this.scheduleReconnect(peerIdStr);
        }
      }
    }
  }

  /**
   * Get best relay nodes for message routing
   * @param {number} count - Number of relays to return
   */
  getBestRelays(count = 3) {
    const activeRelays = Array.from(this.relayNodes.entries())
      .filter(([id]) => this.connections.has(id))
      .map(([id, info]) => ({ peerId: id, ...info }))
      .sort((a, b) => b.score - a.score);

    return activeRelays.slice(0, count);
  }

  /**
   * Get a relay for load-balanced routing
   */
  getRelayForRouting() {
    const relays = this.getBestRelays(5);
    if (relays.length === 0) return null;

    // Weighted random selection based on score
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
   * Log connection pool stats
   */
  logStats() {
    const relayCount = Array.from(this.connections.values())
      .filter(c => c.isRelay).length;

    console.log(`
┌─────────────────────────────────────────┐
│         Connection Pool Stats           │
├─────────────────────────────────────────┤
│ Active Connections: ${this.connections.size.toString().padStart(17)} │
│ Relay Connections:  ${relayCount.toString().padStart(17)} │
│ Total Established:  ${this.metrics.totalConnections.toString().padStart(17)} │
│ Failed Attempts:    ${this.metrics.failedConnections.toString().padStart(17)} │
│ Messages Routed:    ${this.metrics.messagesRouted.toString().padStart(17)} │
└─────────────────────────────────────────┘
    `);
  }

  /**
   * Get pool status
   */
  getStatus() {
    return {
      activeConnections: this.connections.size,
      relayConnections: Array.from(this.connections.values())
        .filter(c => c.isRelay).length,
      knownRelays: this.relayNodes.size,
      bestRelays: this.getBestRelays(3),
      metrics: { ...this.metrics }
    };
  }
}

/**
 * Message Queue for outbound messages
 * Handles message batching and prioritization
 */
export class MessageQueue {
  constructor(options = {}) {
    this.maxQueueSize = options.maxQueueSize || 1000;
    this.batchSize = options.batchSize || 10;
    this.batchIntervalMs = options.batchIntervalMs || 100;

    this.queue = [];
    this.processing = false;
    this.onBatchReady = null;
  }

  /**
   * Add message to queue
   * @param {Object} message - Message to queue
   * @param {number} priority - Priority (0 = highest)
   */
  enqueue(message, priority = 5) {
    if (this.queue.length >= this.maxQueueSize) {
      throw new Error('Message queue full');
    }

    this.queue.push({
      message,
      priority,
      enqueuedAt: Date.now()
    });

    // Sort by priority
    this.queue.sort((a, b) => a.priority - b.priority);

    // Trigger batch processing if not already running
    this.scheduleBatchProcess();
  }

  /**
   * Schedule batch processing
   */
  scheduleBatchProcess() {
    if (this.processing) return;

    this.processing = true;
    setTimeout(() => this.processBatch(), this.batchIntervalMs);
  }

  /**
   * Process a batch of messages
   */
  async processBatch() {
    if (this.queue.length === 0) {
      this.processing = false;
      return;
    }

    const batch = this.queue.splice(0, this.batchSize);

    if (this.onBatchReady) {
      await this.onBatchReady(batch.map(b => b.message));
    }

    // Continue processing if more messages
    if (this.queue.length > 0) {
      setTimeout(() => this.processBatch(), this.batchIntervalMs);
    } else {
      this.processing = false;
    }
  }

  /**
   * Get queue status
   */
  getStatus() {
    return {
      queueLength: this.queue.length,
      maxSize: this.maxQueueSize,
      processing: this.processing
    };
  }

  /**
   * Clear the queue
   */
  clear() {
    this.queue = [];
  }
}

export default ConnectionPool;
