#!/usr/bin/env node
/**
 * dMail SMTP Gateway - Standalone Server
 *
 * Bridges traditional email to dMail network.
 *
 * Usage:
 *   GATEWAY_DOMAIN=yourdomain.com npm run gateway
 *
 * Required DNS Setup (for yourdomain.com):
 *   MX  10  mail.yourdomain.com
 *   A       mail.yourdomain.com → your-server-ip
 *
 * Then anyone can send to user@yourdomain.com and it
 * will be delivered to the linked dMail address.
 */

import { SMTPGateway } from './smtp-gateway.js';
import { Identity, IdentityStore } from '../crypto/identity.js';
import { DMailNode } from '../network/node.js';

async function main() {
  console.log('Starting dMail SMTP Gateway...\n');

  // Load or create gateway identity
  const store = new IdentityStore();
  let identity = await store.getIdentity('gateway');

  if (!identity) {
    console.log('Creating gateway identity...');
    identity = Identity.generate();
    await store.saveIdentity('gateway', identity);
    console.log(`Gateway dMail address: ${identity.address}\n`);
  } else {
    console.log(`Using existing gateway identity: ${identity.address}\n`);
  }

  // Start P2P node
  console.log('Starting P2P node...');
  const node = new DMailNode(identity);
  await node.start();

  // Start SMTP gateway
  const gateway = new SMTPGateway({
    dmailNode: node,
    gatewayIdentity: identity,
    domain: process.env.GATEWAY_DOMAIN || 'dmail.network'
  });

  await gateway.start();

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await gateway.stop();
    await node.stop();
    process.exit(0);
  });

  console.log(`
═══════════════════════════════════════════════════════════════
  Gateway is running!

  To receive emails from Gmail/Outlook:

  1. Register your address via API:
     curl -X POST http://localhost:3001/api/gateway/register \\
       -H "Content-Type: application/json" \\
       -d '{"localPart": "yourname"}'

  2. Configure DNS for your domain:
     MX  10  mail.${gateway.domain}
     A      mail.${gateway.domain} → <this-server-ip>

  3. Now yourname@${gateway.domain} will forward to your dMail!

═══════════════════════════════════════════════════════════════
  `);
}

main().catch(console.error);
