/**
 * Proof of Work for spam prevention
 *
 * Uses Hashcash-style PoW - sender must compute a nonce that produces
 * a hash with N leading zero bits. This makes spam expensive.
 */

import { sha256 } from '@noble/hashes/sha256';

const DEFAULT_DIFFICULTY = 18; // ~262k hashes average, ~0.1-0.5 seconds on modern CPU

/**
 * Compute proof of work for a message
 *
 * @param {string} messageHash - Hash of the message content
 * @param {number} difficulty - Number of leading zero bits required
 * @returns {Object} - Proof containing nonce and hash
 */
export function computeProofOfWork(messageHash, difficulty = DEFAULT_DIFFICULTY) {
  let nonce = 0n;
  const target = BigInt(1) << BigInt(256 - difficulty);

  while (true) {
    const input = `${messageHash}:${nonce}`;
    const hash = sha256(new TextEncoder().encode(input));
    const hashValue = BigInt('0x' + Buffer.from(hash).toString('hex'));

    if (hashValue < target) {
      return {
        nonce: nonce.toString(),
        hash: Buffer.from(hash).toString('hex'),
        difficulty
      };
    }

    nonce++;

    // Safety limit - should never hit this with reasonable difficulty
    if (nonce > BigInt(2) ** BigInt(40)) {
      throw new Error('PoW computation exceeded maximum iterations');
    }
  }
}

/**
 * Verify proof of work
 *
 * @param {string} messageHash - Hash of the message content
 * @param {Object} proof - The proof to verify
 * @returns {boolean} - True if proof is valid
 */
export function verifyProofOfWork(messageHash, proof) {
  const { nonce, difficulty } = proof;
  const target = BigInt(1) << BigInt(256 - difficulty);

  const input = `${messageHash}:${nonce}`;
  const hash = sha256(new TextEncoder().encode(input));
  const hashValue = BigInt('0x' + Buffer.from(hash).toString('hex'));

  return hashValue < target;
}

/**
 * Calculate approximate time to compute PoW at given difficulty
 */
export function estimatePoWTime(difficulty) {
  const averageHashes = Math.pow(2, difficulty);
  const hashesPerSecond = 500000; // Rough estimate for modern CPU
  return averageHashes / hashesPerSecond;
}

export { DEFAULT_DIFFICULTY };
