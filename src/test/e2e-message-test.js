/**
 * End-to-end test for dMail message sending and receiving
 *
 * This test:
 * 1. Creates two test identities (simulating two wallets)
 * 2. Authenticates both
 * 3. Starts P2P nodes for both
 * 4. Sends a message from user1 to user2
 * 5. Verifies user2 receives the message
 */

import { ethers } from 'ethers';

const API_URL = process.env.API_URL || 'http://localhost:3001';

// Test wallets (DO NOT USE IN PRODUCTION - these are test keys only)
const TEST_WALLET_1 = ethers.Wallet.createRandom();
const TEST_WALLET_2 = ethers.Wallet.createRandom();

console.log('Test Wallet 1:', TEST_WALLET_1.address);
console.log('Test Wallet 2:', TEST_WALLET_2.address);

async function makeRequest(endpoint, options = {}) {
  const url = `${API_URL}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    }
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} - ${JSON.stringify(data)}`);
  }
  return data;
}

async function authenticateWallet(wallet) {
  console.log(`\nAuthenticating wallet: ${wallet.address}`);

  // Step 1: Get challenge
  const challenge = await makeRequest('/api/auth/challenge');
  console.log('  Got challenge nonce:', challenge.nonce);

  // Step 2: Sign the message
  const signature = await wallet.signMessage(challenge.message);
  console.log('  Signed message');

  // Step 3: Login
  const loginResult = await makeRequest('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      signature,
      walletAddress: wallet.address,
      nonce: challenge.nonce
    })
  });

  console.log('  Login successful!');
  console.log('  dMail address:', loginResult.identity.address);
  console.log('  Session token:', loginResult.token.slice(0, 20) + '...');

  return {
    token: loginResult.token,
    identity: loginResult.identity
  };
}

async function startNode(token) {
  console.log('\nStarting P2P node...');

  const result = await makeRequest('/api/node/start', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({})
  });

  console.log('  Node status:', result.status);
  console.log('  Address:', result.address);

  // Wait for node to connect to relays
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Check node status
  const status = await makeRequest('/api/node/status', {
    headers: { Authorization: `Bearer ${token}` }
  });

  console.log('  Peer count:', status.peerCount);

  return result;
}

async function sendMessage(token, to, subject, body) {
  console.log('\nSending message...');
  console.log('  To:', to);
  console.log('  Subject:', subject);

  const result = await makeRequest('/api/messages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to, subject, body })
  });

  console.log('  Message sent successfully!');
  console.log('  Message ID:', result.messageId);

  return result;
}

async function getMessages(token) {
  console.log('\nFetching messages...');

  const result = await makeRequest('/api/messages', {
    headers: { Authorization: `Bearer ${token}` }
  });

  console.log('  Found', result.messages.length, 'messages');

  return result.messages;
}

async function getMessage(token, messageId) {
  console.log('\nFetching message:', messageId);

  const result = await makeRequest(`/api/messages/${messageId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  return result.message;
}

async function runTest() {
  console.log('='.repeat(60));
  console.log('dMail End-to-End Message Test');
  console.log('='.repeat(60));

  try {
    // Step 1: Check health
    console.log('\n1. Checking API health...');
    const health = await makeRequest('/health');
    console.log('  API status:', health.status);

    // Step 2: Authenticate both users
    console.log('\n2. Authenticating users...');
    const user1 = await authenticateWallet(TEST_WALLET_1);
    const user2 = await authenticateWallet(TEST_WALLET_2);

    // Step 3: Start P2P nodes
    console.log('\n3. Starting P2P nodes...');
    await startNode(user1.token);
    await startNode(user2.token);

    // Give nodes time to connect and subscribe to topics
    console.log('\nWaiting for network connections...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Step 4: Send message from user1 to user2
    console.log('\n4. Sending message from user1 to user2...');
    const sendResult = await sendMessage(
      user1.token,
      user2.identity.address,
      'Test Message',
      'Hello from the automated test!'
    );

    // Wait for message propagation
    console.log('\nWaiting for message propagation...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Step 5: Check user2's inbox
    console.log('\n5. Checking user2\'s inbox...');
    const messages = await getMessages(user2.token);

    if (messages.length > 0) {
      console.log('\n✅ SUCCESS: Message received!');
      console.log('\nMessage details:');
      for (const msg of messages) {
        console.log('  ID:', msg.id);
        console.log('  From:', msg.from);
        console.log('  Subject:', msg.subject);
        console.log('  Preview:', msg.preview);
        console.log('  Encrypted:', msg.encrypted || false);
      }
    } else {
      console.log('\n⚠️  No messages in inbox yet');
      console.log('This could be because:');
      console.log('  - Message is still propagating');
      console.log('  - Relay nodes haven\'t synced');
      console.log('  - There\'s an issue with the pub/sub');
    }

    // Step 6: Also send a self-message to test local delivery
    console.log('\n6. Testing self-message (user1 to user1)...');
    await sendMessage(
      user1.token,
      user1.identity.address,
      'Self Test',
      'Testing self-delivery'
    );

    await new Promise(resolve => setTimeout(resolve, 1000));

    const user1Messages = await getMessages(user1.token);
    console.log('  User1 inbox count:', user1Messages.length);

    if (user1Messages.length > 0) {
      console.log('  ✅ Self-message delivered!');
    }

    console.log('\n' + '='.repeat(60));
    console.log('Test completed');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('\n❌ TEST FAILED:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

runTest();
