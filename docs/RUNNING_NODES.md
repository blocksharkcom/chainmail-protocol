# Running dMail Nodes

This guide explains how to run dMail relay nodes to help the network and earn DMAIL token rewards.

## What is a Relay Node?

Relay nodes are the backbone of the dMail network. They:

- **Store messages** for offline recipients (up to 7 days)
- **Relay messages** across the network
- **Help with NAT traversal** so users behind firewalls can receive messages
- **Earn DMAIL tokens** for their service

Anyone can run a relay node - the more nodes, the more resilient the network.

## Reward System

Relay node operators earn DMAIL tokens based on:

| Activity | Reward Rate |
|----------|-------------|
| Messages relayed | 0.001 DMAIL per message |
| Bandwidth | 0.01 DMAIL per MB |
| Uptime | 0.1 DMAIL per hour |
| Unique peers served | 0.005 DMAIL per peer |

**Example earnings** (estimated, 24/7 operation):
- Small node (100 msgs/day): ~3 DMAIL/day
- Medium node (1000 msgs/day): ~15 DMAIL/day
- Large node (10000 msgs/day): ~100 DMAIL/day

## Requirements

### Minimum Requirements
- 1 CPU core
- 512MB RAM
- 10GB storage
- Static IP address (recommended)
- Open ports: 4001 (TCP), 4002 (WebSocket)

### Recommended Requirements
- 2+ CPU cores
- 2GB RAM
- 50GB SSD
- High-bandwidth connection
- Static IP with DNS

## Quick Start with Docker

The easiest way to run a relay node:

```bash
# Clone the repository
git clone https://github.com/yourusername/dmail.git
cd dmail

# Set your wallet address for rewards
export RELAY1_WALLET=0xYourEthereumAddress

# Start the relay node
docker-compose up relay1 -d

# View logs
docker-compose logs -f relay1
```

## Manual Installation

### 1. Install Node.js

```bash
# Using nvm (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 20
nvm use 20
```

### 2. Clone and Install

```bash
git clone https://github.com/yourusername/dmail.git
cd dmail
npm install
```

### 3. Run the Relay Node

```bash
# Set environment variables
export PORT=4001
export WS_PORT=4002
export WALLET_ADDRESS=0xYourEthereumAddress

# Start the node
npm run relay
```

### 4. Run as a Service (Linux)

Create a systemd service file:

```bash
sudo nano /etc/systemd/system/dmail-relay.service
```

```ini
[Unit]
Description=dMail Relay Node
After=network.target

[Service]
Type=simple
User=dmail
WorkingDirectory=/opt/dmail
Environment=PORT=4001
Environment=WS_PORT=4002
Environment=WALLET_ADDRESS=0xYourEthereumAddress
ExecStart=/usr/bin/node src/network/relay-node.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl enable dmail-relay
sudo systemctl start dmail-relay
sudo systemctl status dmail-relay
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 4001 | TCP port for libp2p |
| `WS_PORT` | 4002 | WebSocket port |
| `WALLET_ADDRESS` | - | Your Ethereum address for rewards |
| `ANNOUNCE_IP` | - | Public IP to announce (optional) |

### Port Forwarding

If behind a router, forward these ports:
- TCP 4001 → Your machine's local IP:4001
- TCP 4002 → Your machine's local IP:4002

### Firewall Rules

```bash
# UFW (Ubuntu)
sudo ufw allow 4001/tcp
sudo ufw allow 4002/tcp

# firewalld (CentOS/RHEL)
sudo firewall-cmd --permanent --add-port=4001/tcp
sudo firewall-cmd --permanent --add-port=4002/tcp
sudo firewall-cmd --reload
```

## Claiming Rewards

### 1. Register Your Node On-Chain

First, stake DMAIL tokens to register as a node operator:

```javascript
// Using ethers.js
const token = new ethers.Contract(TOKEN_ADDRESS, TOKEN_ABI, signer);

// Your libp2p peer ID (found in ~/.dmail-relay/peer-id.txt)
const peerId = ethers.encodeBytes32String("QmYourPeerIdHere");

// Register (requires 10,000 DMAIL stake)
await token.registerRelayNode(peerId);
```

### 2. Claim Accumulated Rewards

```javascript
// Check pending rewards
const rewards = await token.calculateRewards(yourWallet);
console.log("Pending rewards:", ethers.formatEther(rewards), "DMAIL");

// Claim rewards
await token.claimRewards();
```

### 3. View Your Stats

```bash
# Check your node stats
curl http://localhost:4001/stats
```

## Monitoring

### Health Checks

```bash
# Check if node is running
curl http://localhost:4001/health

# Get node info
curl http://localhost:4001/info
```

### Prometheus Metrics (Coming Soon)

Metrics endpoint at `/metrics` for Prometheus/Grafana monitoring.

## Troubleshooting

### Node won't start

1. Check if ports are already in use:
   ```bash
   lsof -i :4001
   lsof -i :4002
   ```

2. Check logs:
   ```bash
   docker-compose logs relay1
   # or
   journalctl -u dmail-relay -f
   ```

### No peers connecting

1. Verify port forwarding is working:
   ```bash
   # From outside your network
   nc -zv your-public-ip 4001
   ```

2. Check firewall rules

3. Ensure your IP is reachable

### Low rewards

- Ensure 24/7 uptime
- Check bandwidth - more traffic = more rewards
- Consider running in a datacenter for better connectivity

## Joining the Network

To be listed as an official bootstrap node:

1. Run your node for at least 7 days with >99% uptime
2. Stake minimum 10,000 DMAIL
3. Submit your node details to the dMail DAO

Your multiaddr will be added to the bootstrap list, bringing more peers to your node.

## Security Best Practices

1. **Keep software updated** - Run `git pull && npm install` regularly
2. **Use a dedicated user** - Don't run as root
3. **Enable firewall** - Only open required ports
4. **Monitor logs** - Watch for unusual activity
5. **Backup keys** - Save `~/.dmail-relay/node-key.json`

## Community

- Discord: [discord.gg/dmail](https://discord.gg/dmail)
- Forum: [forum.dmail.network](https://forum.dmail.network)
- GitHub: [github.com/dmail-network/dmail](https://github.com/dmail-network/dmail)

## License

MIT License - Run nodes freely, earn rewards, help decentralize email!
