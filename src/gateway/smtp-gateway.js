/**
 * SMTP Gateway for dMail
 *
 * Bridges traditional email (Gmail, Outlook, etc.) to dMail.
 *
 * How it works:
 * 1. User registers a dMail address: user@dmail.network (or custom domain)
 * 2. Configure DNS MX records to point to this gateway
 * 3. Gateway receives SMTP emails and forwards to P2P network
 * 4. Gateway can also send emails to traditional addresses
 *
 * Security considerations:
 * - Incoming emails from legacy systems are NOT end-to-end encrypted
 * - They are encrypted at the gateway before delivery to P2P
 * - Outgoing emails to legacy systems lose encryption at the gateway
 * - For full privacy, use dMail-to-dMail communication
 */

import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { createMessage } from '../protocol/message.js';
import { addressToPublicKey, Identity } from '../crypto/identity.js';
import { Level } from 'level';
import { join } from 'path';
import { DMAIL_DIR } from '../crypto/identity.js';

const GATEWAY_DOMAIN = process.env.GATEWAY_DOMAIN || 'dmail.network';
const SMTP_PORT = process.env.SMTP_PORT || 25;
const SUBMISSION_PORT = process.env.SUBMISSION_PORT || 587;

/**
 * SMTP Gateway Service
 */
export class SMTPGateway {
  constructor(options = {}) {
    this.domain = options.domain || GATEWAY_DOMAIN;
    this.dmailNode = options.dmailNode;
    this.gatewayIdentity = options.gatewayIdentity;

    // Database for address mappings
    this.db = new Level(join(DMAIL_DIR, 'gateway'), { valueEncoding: 'json' });

    // Mapping: legacy email → dmail address
    this.addressMap = new Map();

    this.smtpServer = null;
    this.outboundTransport = null;
  }

  /**
   * Start the SMTP gateway server
   */
  async start() {
    await this.loadAddressMappings();

    // Inbound SMTP server (receives emails from Gmail, etc.)
    this.smtpServer = new SMTPServer({
      secure: false,
      authOptional: true,
      disabledCommands: ['AUTH'], // Accept all incoming mail
      onConnect: this.onConnect.bind(this),
      onMailFrom: this.onMailFrom.bind(this),
      onRcptTo: this.onRcptTo.bind(this),
      onData: this.onData.bind(this),
      banner: `dMail Gateway - ${this.domain}`
    });

    this.smtpServer.listen(SMTP_PORT, '0.0.0.0', () => {
      console.log(`SMTP Gateway listening on port ${SMTP_PORT}`);
      console.log(`Accepting mail for *@${this.domain}`);
    });

    // Outbound transport (sends emails to Gmail, etc.)
    // This would typically use a proper SMTP relay in production
    this.outboundTransport = nodemailer.createTransport({
      host: process.env.SMTP_RELAY_HOST || 'localhost',
      port: process.env.SMTP_RELAY_PORT || 25,
      secure: false,
      tls: { rejectUnauthorized: false }
    });

    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                  dMail SMTP Gateway                       ║
╠═══════════════════════════════════════════════════════════╣
║  Inbound:  Port ${SMTP_PORT} (receiving from Gmail, etc.)       ║
║  Domain:   ${this.domain.padEnd(40)}║
║                                                           ║
║  To receive emails at yourname@${this.domain}:          ║
║  1. Register your dMail address                           ║
║  2. Link it to yourname@${this.domain}                  ║
║                                                           ║
║  Note: Emails from legacy systems are encrypted           ║
║  at the gateway. For full E2E, use dMail addresses.      ║
╚═══════════════════════════════════════════════════════════╝
    `);

    return this;
  }

  /**
   * Stop the gateway
   */
  async stop() {
    if (this.smtpServer) {
      this.smtpServer.close();
    }
    await this.db.close();
  }

  /**
   * Handle new SMTP connection
   */
  onConnect(session, callback) {
    console.log(`SMTP connection from ${session.remoteAddress}`);
    callback();
  }

  /**
   * Validate sender address
   */
  onMailFrom(address, session, callback) {
    session.from = address.address;
    callback();
  }

  /**
   * Validate recipient address
   */
  async onRcptTo(address, session, callback) {
    const email = address.address.toLowerCase();
    const [localPart, domain] = email.split('@');

    // Check if this is our domain
    if (domain !== this.domain) {
      return callback(new Error(`Relay not allowed for ${domain}`));
    }

    // Check if we have a dMail address mapped to this email
    const dmailAddress = await this.getDmailAddress(localPart);
    if (!dmailAddress) {
      return callback(new Error(`Unknown recipient: ${email}`));
    }

    session.to = session.to || [];
    session.to.push({ email, dmailAddress, localPart });
    callback();
  }

  /**
   * Process incoming email data
   */
  async onData(stream, session, callback) {
    try {
      // Parse the email
      const parsed = await simpleParser(stream);

      console.log(`Received email from ${session.from} to ${session.to.map(t => t.email).join(', ')}`);
      console.log(`Subject: ${parsed.subject}`);

      // Forward to each dMail recipient
      for (const recipient of session.to) {
        await this.forwardToDmail(parsed, session.from, recipient);
      }

      callback();
    } catch (error) {
      console.error('Error processing email:', error);
      callback(error);
    }
  }

  /**
   * Forward email to dMail network
   */
  async forwardToDmail(parsed, from, recipient) {
    if (!this.dmailNode || !this.gatewayIdentity) {
      console.error('dMail node not configured, cannot forward');
      return;
    }

    try {
      // Get recipient's public key
      const recipientPublicKey = addressToPublicKey(recipient.dmailAddress);

      // Create dMail message
      const builder = createMessage(this.gatewayIdentity)
        .to(recipient.dmailAddress)
        .subject(`[Gateway] ${parsed.subject || '(no subject)'}`)
        .body(`From: ${from}\n\n${parsed.text || ''}`);

      // Build encrypted envelope
      const envelope = await builder.build(recipientPublicKey);

      // Send via P2P network
      await this.dmailNode.sendMessage(envelope);

      console.log(`Forwarded to dMail: ${recipient.dmailAddress}`);
    } catch (error) {
      console.error(`Failed to forward to ${recipient.dmailAddress}:`, error.message);
    }
  }

  /**
   * Send email to legacy address (Gmail, etc.)
   */
  async sendToLegacy(dmailEnvelope, legacyEmail) {
    if (!this.outboundTransport) {
      throw new Error('Outbound transport not configured');
    }

    try {
      // Decrypt the dMail message (gateway has access to decrypt)
      // In production, you'd want users to explicitly opt-in to legacy forwarding

      const info = await this.outboundTransport.sendMail({
        from: `${dmailEnvelope.from}@${this.domain}`,
        to: legacyEmail,
        subject: dmailEnvelope.subject || '(no subject)',
        text: dmailEnvelope.body || '',
        headers: {
          'X-DMail-From': dmailEnvelope.from,
          'X-DMail-Signature': dmailEnvelope.signature
        }
      });

      console.log(`Sent to legacy: ${legacyEmail} (${info.messageId})`);
      return info;
    } catch (error) {
      console.error(`Failed to send to ${legacyEmail}:`, error.message);
      throw error;
    }
  }

  /**
   * Register a mapping: legacy email → dmail address
   */
  async registerAddress(localPart, dmailAddress) {
    const key = localPart.toLowerCase();

    // Verify the dMail address is valid
    try {
      addressToPublicKey(dmailAddress);
    } catch {
      throw new Error('Invalid dMail address');
    }

    await this.db.put(`addr:${key}`, { dmailAddress, registeredAt: Date.now() });
    this.addressMap.set(key, dmailAddress);

    console.log(`Registered: ${localPart}@${this.domain} → ${dmailAddress}`);
    return `${localPart}@${this.domain}`;
  }

  /**
   * Get dMail address for a local part
   */
  async getDmailAddress(localPart) {
    const key = localPart.toLowerCase();

    // Check cache first
    if (this.addressMap.has(key)) {
      return this.addressMap.get(key);
    }

    // Check database
    try {
      const record = await this.db.get(`addr:${key}`);
      this.addressMap.set(key, record.dmailAddress);
      return record.dmailAddress;
    } catch {
      return null;
    }
  }

  /**
   * Load all address mappings from database
   */
  async loadAddressMappings() {
    try {
      for await (const [key, value] of this.db.iterator()) {
        if (key.startsWith('addr:')) {
          const localPart = key.slice(5);
          this.addressMap.set(localPart, value.dmailAddress);
        }
      }
      console.log(`Loaded ${this.addressMap.size} address mappings`);
    } catch (error) {
      console.log('No existing address mappings found');
    }
  }

  /**
   * List all registered addresses
   */
  async listAddresses() {
    const addresses = [];
    for await (const [key, value] of this.db.iterator()) {
      if (key.startsWith('addr:')) {
        addresses.push({
          email: `${key.slice(5)}@${this.domain}`,
          dmailAddress: value.dmailAddress,
          registeredAt: value.registeredAt
        });
      }
    }
    return addresses;
  }
}

/**
 * Start standalone gateway server
 */
export async function startGateway(options = {}) {
  const gateway = new SMTPGateway(options);
  await gateway.start();
  return gateway;
}

export { GATEWAY_DOMAIN, SMTP_PORT };
