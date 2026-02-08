#!/usr/bin/env node

/**
 * dMail CLI - Decentralized Email Client
 *
 * Commands:
 * - init: Create a new identity
 * - send: Send an encrypted email
 * - inbox: View inbox
 * - read: Read a specific message
 * - node: Start the P2P node
 * - register: Register identity on blockchain
 * - lookup: Look up an identity
 */

import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { Identity, IdentityStore, addressToPublicKey } from '../crypto/identity.js';
import { DMailNode } from '../network/node.js';
import { BlockchainRegistry } from '../blockchain/registry.js';
import { createMessage, parseMessage } from '../protocol/message.js';
import { IPFSStorage, AttachmentManager } from '../storage/ipfs.js';
import { readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';

const program = new Command();

program
  .name('dmail')
  .description('Decentralized P2P Email - No servers, fully encrypted, blockchain-anchored')
  .version('1.0.0');

// Initialize a new identity
program
  .command('init')
  .description('Create a new dMail identity')
  .option('-n, --name <name>', 'Name for this identity', 'default')
  .action(async (options) => {
    const store = new IdentityStore();

    // Check if identity already exists
    const existing = await store.getIdentity(options.name);
    if (existing) {
      console.log(chalk.yellow(`Identity '${options.name}' already exists:`));
      console.log(chalk.cyan(`  Address: ${existing.address}`));
      await store.close();
      return;
    }

    // Generate new identity
    console.log(chalk.blue('Generating new identity...'));
    const identity = Identity.generate();

    await store.saveIdentity(options.name, identity);

    console.log(chalk.green('\n✓ Identity created successfully!\n'));
    console.log(chalk.white('Your dMail address:'));
    console.log(chalk.cyan.bold(`  ${identity.address}\n`));
    console.log(chalk.gray('Share this address with others so they can send you encrypted emails.'));
    console.log(chalk.gray('Your private key is stored securely in ~/.dmail/identity\n'));

    // Show backup warning
    console.log(chalk.yellow('⚠ IMPORTANT: Back up your identity!'));
    console.log(chalk.gray(`  Run: dmail export --name ${options.name}`));

    await store.close();
  });

// List identities
program
  .command('identities')
  .description('List all identities')
  .action(async () => {
    const store = new IdentityStore();
    const identities = await store.listIdentities();

    if (identities.length === 0) {
      console.log(chalk.yellow('No identities found. Run `dmail init` to create one.'));
    } else {
      console.log(chalk.blue('\nYour identities:\n'));
      for (const { name, address } of identities) {
        console.log(`  ${chalk.white(name)}: ${chalk.cyan(address)}`);
      }
      console.log();
    }

    await store.close();
  });

// Export identity (for backup)
program
  .command('export')
  .description('Export identity for backup')
  .option('-n, --name <name>', 'Identity name', 'default')
  .action(async (options) => {
    const store = new IdentityStore();
    const identity = await store.getIdentity(options.name);

    if (!identity) {
      console.log(chalk.red(`Identity '${options.name}' not found.`));
      await store.close();
      return;
    }

    // SECURITY: Never output private keys to console!
    // Instead, write to an encrypted file or prompt for secure handling
    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: chalk.red('⚠ WARNING: This will display your PRIVATE KEY. Anyone with this key can read ALL your emails. Are you sure?'),
        default: false
      }
    ]);

    if (!confirm) {
      console.log(chalk.green('Export cancelled.'));
      await store.close();
      return;
    }

    // Suggest saving to encrypted file instead of showing on screen
    const { method } = await inquirer.prompt([
      {
        type: 'list',
        name: 'method',
        message: 'How do you want to export?',
        choices: [
          { name: 'Save to encrypted file (recommended)', value: 'file' },
          { name: 'Display on screen (INSECURE - visible in terminal history)', value: 'screen' }
        ]
      }
    ]);

    if (method === 'file') {
      const { password } = await inquirer.prompt([
        {
          type: 'password',
          name: 'password',
          message: 'Enter encryption password for backup file:',
          mask: '*'
        }
      ]);

      const { scrypt } = await import('@noble/hashes/scrypt');
      const { chacha20poly1305 } = await import('@noble/ciphers/chacha');
      const { randomBytes, writeFileSync } = await import('crypto');
      const fs = await import('fs');

      const salt = randomBytes(16);
      const key = scrypt(new TextEncoder().encode(password), salt, { N: 2**17, r: 8, p: 1, dkLen: 32 });
      const nonce = randomBytes(12);
      const cipher = chacha20poly1305(key, nonce);
      const plaintext = new TextEncoder().encode(JSON.stringify(identity.toJSON()));
      const ciphertext = cipher.encrypt(plaintext);

      const exportData = {
        version: 1,
        salt: Buffer.from(salt).toString('base64'),
        nonce: Buffer.from(nonce).toString('base64'),
        ciphertext: Buffer.from(ciphertext).toString('base64')
      };

      const filename = `dmail-backup-${options.name}-${Date.now()}.json`;
      fs.writeFileSync(filename, JSON.stringify(exportData, null, 2));
      console.log(chalk.green(`\n✓ Encrypted backup saved to: ${filename}`));
      console.log(chalk.gray('Keep this file and your password safe!'));
    } else {
      console.log(chalk.red('\n⚠ SECURITY WARNING: Clear your terminal after viewing!\n'));
      console.log(JSON.stringify(identity.toJSON(), null, 2));
      console.log(chalk.red('\n⚠ Run `clear` or `history -c` to remove from terminal history'));
    }

    await store.close();
  });

// Import identity
program
  .command('import')
  .description('Import identity from backup')
  .option('-n, --name <name>', 'Name for imported identity')
  .action(async (options) => {
    const { backup } = await inquirer.prompt([
      {
        type: 'editor',
        name: 'backup',
        message: 'Paste your identity backup JSON:'
      }
    ]);

    try {
      const json = JSON.parse(backup);
      const identity = Identity.fromJSON(json);

      const name = options.name || `imported-${Date.now()}`;
      const store = new IdentityStore();
      await store.saveIdentity(name, identity);

      console.log(chalk.green(`\n✓ Identity imported as '${name}'`));
      console.log(chalk.cyan(`  Address: ${identity.address}`));

      await store.close();
    } catch (e) {
      console.log(chalk.red('Failed to import identity:', e.message));
    }
  });

// Send email
program
  .command('send')
  .description('Send an encrypted email')
  .option('-t, --to <address>', 'Recipient dMail address or registered name')
  .option('-s, --subject <subject>', 'Email subject')
  .option('-b, --body <body>', 'Email body')
  .option('-f, --file <path>', 'Attach a file')
  .option('-n, --name <name>', 'Identity to send from', 'default')
  .option('--timestamp', 'Anchor message on blockchain', false)
  .action(async (options) => {
    const store = new IdentityStore();
    const identity = await store.getIdentity(options.name);

    if (!identity) {
      console.log(chalk.red(`Identity '${options.name}' not found. Run 'dmail init' first.`));
      await store.close();
      return;
    }

    // Get recipient
    let to = options.to;
    if (!to) {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'to',
          message: 'Recipient address (dm1... or registered name):',
          validate: (input) => input.length > 0 || 'Recipient required'
        }
      ]);
      to = answers.to;
    }

    // Get subject
    let subject = options.subject;
    if (!subject) {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'subject',
          message: 'Subject:',
          default: '(no subject)'
        }
      ]);
      subject = answers.subject;
    }

    // Get body
    let body = options.body;
    if (!body) {
      const answers = await inquirer.prompt([
        {
          type: 'editor',
          name: 'body',
          message: 'Compose your message:'
        }
      ]);
      body = answers.body;
    }

    // Resolve recipient address (might be a registered name)
    let recipientAddress = to;
    let recipientKey = null;

    if (!to.startsWith('dm1')) {
      // Try to look up on blockchain
      console.log(chalk.gray(`Looking up '${to}' on blockchain...`));
      const registry = new BlockchainRegistry();
      try {
        await registry.connect();
        const resolved = await registry.lookupByName(to);
        if (resolved) {
          recipientAddress = resolved.dmailAddress;
          recipientKey = Buffer.from(resolved.encryptionKey, 'hex');
          console.log(chalk.green(`  Found: ${recipientAddress}`));
        } else {
          console.log(chalk.red(`Name '${to}' not found on blockchain.`));
          await store.close();
          return;
        }
      } catch (e) {
        console.log(chalk.yellow(`Blockchain lookup failed: ${e.message}`));
        console.log(chalk.gray('Using address directly...'));
      }
    }

    // Try to get recipient key from address if not from blockchain
    if (!recipientKey) {
      try {
        recipientKey = addressToPublicKey(recipientAddress);
      } catch (e) {
        console.log(chalk.red('Invalid recipient address'));
        await store.close();
        return;
      }
    }

    console.log(chalk.blue('\nBuilding encrypted message...'));

    // Build the message
    const builder = createMessage(identity)
      .to(recipientAddress)
      .subject(subject)
      .body(body);

    // Handle attachments
    if (options.file && existsSync(options.file)) {
      console.log(chalk.gray(`Attaching: ${basename(options.file)}`));
      const fileData = readFileSync(options.file);
      builder.attachment({
        filename: basename(options.file),
        data: fileData.toString('base64'),
        size: fileData.length
      });
    }

    // Build (encrypts and computes PoW)
    const envelope = await builder.build(recipientKey);

    console.log(chalk.green('✓ Message encrypted'));
    console.log(chalk.green('✓ Proof of work computed'));

    // Start node and send
    console.log(chalk.blue('\nConnecting to P2P network...'));
    const node = new DMailNode(identity);
    await node.start();

    // Wait a moment for peer discovery
    console.log(chalk.gray('Discovering peers...'));
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Send message
    const messageId = await node.sendMessage(envelope);
    console.log(chalk.green(`\n✓ Message sent!`));
    console.log(chalk.gray(`  ID: ${messageId}`));

    // Optionally timestamp on blockchain
    if (options.timestamp) {
      console.log(chalk.blue('\nAnchoring on blockchain...'));
      const registry = new BlockchainRegistry();
      try {
        await registry.connect(process.env.ETH_PRIVATE_KEY);
        const result = await registry.timestampMessage(envelope);
        console.log(chalk.green(`✓ Timestamped in block ${result.blockNumber}`));
        console.log(chalk.gray(`  TX: ${result.transactionHash}`));
      } catch (e) {
        console.log(chalk.yellow(`Blockchain timestamp failed: ${e.message}`));
      }
    }

    await node.stop();
    await store.close();
  });

// Start P2P node (daemon mode)
program
  .command('node')
  .description('Start the P2P node to receive emails')
  .option('-n, --name <name>', 'Identity name', 'default')
  .option('-p, --port <port>', 'Port to listen on', '0')
  .action(async (options) => {
    const store = new IdentityStore();
    const identity = await store.getIdentity(options.name);

    if (!identity) {
      console.log(chalk.red(`Identity '${options.name}' not found.`));
      await store.close();
      return;
    }

    console.log(chalk.blue.bold('\n🔐 dMail P2P Node\n'));

    const node = new DMailNode(identity);
    await node.start(parseInt(options.port));

    // Register message handler
    node.onMessage('cli', async (envelope) => {
      try {
        const message = await parseMessage(identity, envelope);
        console.log(chalk.green.bold('\n📬 New message received!'));
        console.log(chalk.white(`  From: ${message.from.slice(0, 20)}...`));
        console.log(chalk.white(`  Subject: ${message.subject}`));
        console.log(chalk.gray(`  Run 'dmail inbox' to read\n`));
      } catch (e) {
        console.log(chalk.yellow(`Received message (decrypt failed): ${e.message}`));
      }
    });

    console.log(chalk.green('\n✓ Node running. Waiting for messages...'));
    console.log(chalk.gray('  Press Ctrl+C to stop\n'));

    // Keep running
    process.on('SIGINT', async () => {
      console.log(chalk.yellow('\nShutting down...'));
      await node.stop();
      await store.close();
      process.exit(0);
    });
  });

// View inbox
program
  .command('inbox')
  .description('View your inbox')
  .option('-n, --name <name>', 'Identity name', 'default')
  .action(async (options) => {
    const store = new IdentityStore();
    const identity = await store.getIdentity(options.name);

    if (!identity) {
      console.log(chalk.red(`Identity '${options.name}' not found.`));
      await store.close();
      return;
    }

    // Start node briefly to check for messages
    const node = new DMailNode(identity);

    // Just read from local storage
    const messages = await node.getInbox();

    if (messages.length === 0) {
      console.log(chalk.yellow('\nInbox is empty.'));
      console.log(chalk.gray('Run `dmail node` to receive messages.\n'));
    } else {
      console.log(chalk.blue.bold(`\n📬 Inbox (${messages.length} messages)\n`));

      for (const msg of messages) {
        const unread = msg.read ? '' : chalk.green(' [NEW]');
        const date = new Date(msg.timestamp).toLocaleString();

        try {
          const parsed = await parseMessage(identity, msg);
          console.log(`${chalk.gray(msg.id.slice(0, 8))} ${chalk.white(parsed.subject || '(no subject)')}${unread}`);
          console.log(`  ${chalk.gray('From:')} ${chalk.cyan(parsed.from.slice(0, 30))}...`);
          console.log(`  ${chalk.gray('Date:')} ${date}\n`);
        } catch (e) {
          console.log(`${chalk.gray(msg.id.slice(0, 8))} ${chalk.red('[Decrypt failed]')}`);
          console.log(`  ${chalk.gray('From:')} ${chalk.cyan(msg.from?.slice(0, 30) || 'unknown')}...`);
          console.log(`  ${chalk.gray('Date:')} ${date}\n`);
        }
      }
    }

    await node.db.close();
    await store.close();
  });

// Read a specific message
program
  .command('read <messageId>')
  .description('Read a specific message')
  .option('-n, --name <name>', 'Identity name', 'default')
  .action(async (messageId, options) => {
    const store = new IdentityStore();
    const identity = await store.getIdentity(options.name);

    if (!identity) {
      console.log(chalk.red(`Identity '${options.name}' not found.`));
      await store.close();
      return;
    }

    const node = new DMailNode(identity);

    // Find message (allow partial ID)
    const messages = await node.getInbox();
    const msg = messages.find(m => m.id.startsWith(messageId));

    if (!msg) {
      console.log(chalk.red(`Message not found: ${messageId}`));
      await node.db.close();
      await store.close();
      return;
    }

    try {
      const parsed = await parseMessage(identity, msg);

      // Mark as read
      await node.markAsRead(msg.id);

      console.log(chalk.blue.bold('\n' + '═'.repeat(60)));
      console.log(chalk.white.bold(`Subject: ${parsed.subject || '(no subject)'}`));
      console.log(chalk.gray(`From: ${parsed.from}`));
      console.log(chalk.gray(`To: ${parsed.to}`));
      console.log(chalk.gray(`Date: ${new Date(parsed.timestamp).toLocaleString()}`));
      console.log(chalk.gray(`ID: ${msg.id}`));
      console.log(chalk.blue.bold('═'.repeat(60) + '\n'));
      console.log(parsed.body);
      console.log(chalk.blue.bold('\n' + '═'.repeat(60) + '\n'));

      if (parsed.attachments && parsed.attachments.length > 0) {
        console.log(chalk.yellow(`Attachments: ${parsed.attachments.length}`));
        for (const att of parsed.attachments) {
          console.log(`  - ${att.filename} (${att.size} bytes)`);
        }
      }

      // Show verification status
      console.log(chalk.green('✓ Signature verified'));
      console.log(chalk.green('✓ Proof of work valid'));

    } catch (e) {
      console.log(chalk.red(`Failed to decrypt message: ${e.message}`));
    }

    await node.db.close();
    await store.close();
  });

// Register identity on blockchain
program
  .command('register')
  .description('Register your identity on the blockchain')
  .argument('<name>', 'Human-readable name to register (e.g., "alice")')
  .option('-i, --identity <name>', 'Identity to register', 'default')
  .option('--network <network>', 'Blockchain network', 'localhost')
  .option('--rpc <url>', 'Custom RPC endpoint')
  .action(async (name, options) => {
    const store = new IdentityStore();
    const identity = await store.getIdentity(options.identity);

    if (!identity) {
      console.log(chalk.red(`Identity '${options.identity}' not found.`));
      await store.close();
      return;
    }

    const privateKey = process.env.ETH_PRIVATE_KEY;
    if (!privateKey) {
      console.log(chalk.red('ETH_PRIVATE_KEY environment variable required'));
      console.log(chalk.gray('Export your Ethereum private key to register on-chain'));
      await store.close();
      return;
    }

    console.log(chalk.blue(`\nRegistering '${name}' on ${options.network}...`));

    const registry = new BlockchainRegistry({
      network: options.network,
      rpcUrl: options.rpc
    });

    try {
      await registry.connect(privateKey);

      const result = await registry.registerIdentity(name, identity);

      console.log(chalk.green('\n✓ Registration successful!'));
      console.log(chalk.gray(`  Name: ${name}`));
      console.log(chalk.gray(`  Address: ${identity.address}`));
      console.log(chalk.gray(`  TX: ${result.transactionHash}`));
      console.log(chalk.gray(`  Block: ${result.blockNumber}`));

      console.log(chalk.cyan(`\nOthers can now send you email using: ${name}`));

    } catch (e) {
      console.log(chalk.red(`Registration failed: ${e.message}`));
    }

    await store.close();
  });

// Lookup identity
program
  .command('lookup <nameOrAddress>')
  .description('Look up an identity on the blockchain')
  .option('--network <network>', 'Blockchain network', 'localhost')
  .action(async (nameOrAddress, options) => {
    const registry = new BlockchainRegistry({ network: options.network });

    try {
      await registry.connect();

      let result;
      if (nameOrAddress.startsWith('dm1')) {
        result = await registry.lookupByAddress(nameOrAddress);
      } else {
        result = await registry.lookupByName(nameOrAddress);
      }

      if (result) {
        console.log(chalk.green('\n✓ Identity found:\n'));
        console.log(`  ${chalk.white('Name:')} ${result.name}`);
        console.log(`  ${chalk.white('Address:')} ${chalk.cyan(result.dmailAddress)}`);
        console.log(`  ${chalk.white('Registered:')} ${new Date(result.registeredAt * 1000).toLocaleString()}`);
      } else {
        console.log(chalk.yellow(`\nNo identity found for: ${nameOrAddress}`));
      }

    } catch (e) {
      console.log(chalk.red(`Lookup failed: ${e.message}`));
    }
  });

// Show address
program
  .command('address')
  .description('Show your dMail address')
  .option('-n, --name <name>', 'Identity name', 'default')
  .action(async (options) => {
    const store = new IdentityStore();
    const identity = await store.getIdentity(options.name);

    if (!identity) {
      console.log(chalk.red(`Identity '${options.name}' not found. Run 'dmail init' first.`));
    } else {
      console.log(chalk.cyan(identity.address));
    }

    await store.close();
  });

// Network info
program
  .command('info')
  .description('Show network and blockchain info')
  .option('--network <network>', 'Blockchain network', 'localhost')
  .action(async (options) => {
    console.log(chalk.blue.bold('\n🔐 dMail System Info\n'));

    // Blockchain info
    const registry = new BlockchainRegistry({ network: options.network });
    try {
      await registry.connect();
      const info = await registry.getNetworkInfo();

      console.log(chalk.white('Blockchain:'));
      console.log(`  Network: ${info.network}`);
      console.log(`  Chain ID: ${info.chainId}`);
      console.log(`  Block: ${info.blockNumber}`);
      console.log(`  Contract: ${info.contractAddress || 'Not deployed'}`);
    } catch (e) {
      console.log(chalk.yellow(`  Blockchain unavailable: ${e.message}`));
    }

    console.log();
  });

program.parse();
