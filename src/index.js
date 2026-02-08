/**
 * dMail - Decentralized P2P Email
 *
 * A truly decentralized email system with:
 * - No central servers
 * - End-to-end encryption
 * - P2P message delivery
 * - Blockchain identity registration
 * - Proof-of-work spam prevention
 * - IPFS attachment storage
 */

export * from './crypto/index.js';
export * from './network/index.js';
export * from './blockchain/index.js';
export * from './protocol/index.js';
export * from './storage/index.js';

// Quick start example
export async function quickStart() {
  const { Identity, IdentityStore } = await import('./crypto/index.js');
  const { DMailNode } = await import('./network/index.js');
  const { createMessage, parseMessage } = await import('./protocol/index.js');

  // Create or load identity
  const store = new IdentityStore();
  let identity = await store.getDefaultIdentity();

  if (!identity) {
    console.log('Creating new identity...');
    identity = Identity.generate();
    await store.saveIdentity('default', identity);
  }

  console.log('Your dMail address:', identity.address);

  // Start P2P node
  const node = new DMailNode(identity);
  await node.start();

  // Handle incoming messages
  node.onMessage('main', async (envelope) => {
    try {
      const message = await parseMessage(identity, envelope);
      console.log('New message from:', message.from);
      console.log('Subject:', message.subject);
      console.log('Body:', message.body);
    } catch (e) {
      console.error('Failed to decrypt:', e.message);
    }
  });

  return { identity, node, store, createMessage, parseMessage };
}
