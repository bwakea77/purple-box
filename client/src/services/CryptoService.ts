import nacl from 'tweetnacl';
import { decodeBase64, decodeUTF8, encodeBase64, encodeUTF8 } from 'tweetnacl-util';

// Wire format (see ARCHITECTURE.md § Shared Schemas):
//   base64( nonce(24 bytes) | senderEphemeralPublicKey(32 bytes) | box(plaintext) )
// Embedding the sender's public key in every message keeps a message
// self-decryptable even if ChatStatePayload's peerPublicKey is momentarily
// stale right after a reconnect.

export const MAX_CIPHERTEXT_B64_LENGTH = Math.ceil((4 * 1024 * 4) / 3); // 4 KB binary as base64
const NONCE_LENGTH = nacl.box.nonceLength; // 24
const PUBLIC_KEY_LENGTH = nacl.box.publicKeyLength; // 32
const ENVELOPE_OVERHEAD = NONCE_LENGTH + PUBLIC_KEY_LENGTH + nacl.box.overheadLength;
export const MAX_PLAINTEXT_BYTES = 4 * 1024 - ENVELOPE_OVERHEAD;

export function fitsWithinCiphertextLimit(plaintext: string): boolean {
  return new TextEncoder().encode(plaintext).length <= MAX_PLAINTEXT_BYTES;
}

export function generateKeyPair(): nacl.BoxKeyPair {
  return nacl.box.keyPair();
}

export function publicKeyToBase64(keyPair: nacl.BoxKeyPair): string {
  return encodeBase64(keyPair.publicKey);
}

export function encryptMessage(
  plaintext: string,
  recipientPublicKeyB64: string,
  keyPair: nacl.BoxKeyPair,
): string {
  const nonce = nacl.randomBytes(NONCE_LENGTH);
  const recipientPublicKey = decodeBase64(recipientPublicKeyB64);
  const messageBytes = decodeUTF8(plaintext);
  const box = nacl.box(messageBytes, nonce, recipientPublicKey, keyPair.secretKey);

  const combined = new Uint8Array(NONCE_LENGTH + PUBLIC_KEY_LENGTH + box.length);
  combined.set(nonce, 0);
  combined.set(keyPair.publicKey, NONCE_LENGTH);
  combined.set(box, NONCE_LENGTH + PUBLIC_KEY_LENGTH);
  return encodeBase64(combined);
}

export interface DecryptedMessage {
  plaintext: string;
  senderPublicKey: string;
}

export function decryptMessage(cipherTextB64: string, keyPair: nacl.BoxKeyPair): DecryptedMessage | null {
  try {
    const combined = decodeBase64(cipherTextB64);
    if (combined.length < NONCE_LENGTH + PUBLIC_KEY_LENGTH) return null;
    const nonce = combined.slice(0, NONCE_LENGTH);
    const senderPublicKey = combined.slice(NONCE_LENGTH, NONCE_LENGTH + PUBLIC_KEY_LENGTH);
    const box = combined.slice(NONCE_LENGTH + PUBLIC_KEY_LENGTH);
    const opened = nacl.box.open(box, nonce, senderPublicKey, keyPair.secretKey);
    if (!opened) return null;
    return { plaintext: encodeUTF8(opened), senderPublicKey: encodeBase64(senderPublicKey) };
  } catch {
    return null;
  }
}

// --- SAS (Short Authentication String) key verification --------------------
// See DECISIONS.md § 2.3: a fingerprint of both public keys, rendered
// identically on both screens, that the two users compare out-of-band (voice
// call, in person). A match rules out a server that substituted its own key
// during relay. Emoji, not words, per DECISIONS.md's multilingual-audience
// rationale — no wordlist translation problem, and it survives a voice call.
// 32 entries so each one encodes exactly 5 bits (2^5 = 32); fixed and never
// reordered, since both peers must derive the same string independently.
const SAS_EMOJI_ALPHABET = [
  '🍎', '🍋', '🍇', '🍓', '🍑', '🍒', '🍉', '🍌',
  '🐶', '🐱', '🐵', '🐸', '🐧', '🦊', '🐢', '🦁',
  '⭐', '🌙', '☀️', '⚡', '🔥', '❄️', '🌈', '☂️',
  '⚽', '🎈', '🎁', '🎵', '🔑', '💎', '🚀', '⚓',
] as const;

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}

function readBits(bytes: Uint8Array, bitOffset: number, bitLength: number): number {
  let value = 0;
  for (let i = 0; i < bitLength; i++) {
    const idx = bitOffset + i;
    const bit = (bytes[idx >> 3]! >> (7 - (idx % 8))) & 1;
    value = (value << 1) | bit;
  }
  return value;
}

// crypto.subtle only exists in secure contexts (https:// or localhost) — a
// plain-http deployment on a raw IP/hostname has `crypto.subtle === undefined`.
// Checked explicitly so the UI can say why verification is unavailable rather
// than the button silently never activating (see the "never imply protection
// you don't have" principle DECISIONS.md § 2.1.1 applies to screenshots too).
export function isSasSupported(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle;
}

/** Both peers must compute an identical sequence regardless of who calls this
 * "my" key vs. "their" key — sorting the pair before hashing is what makes
 * that order-independence hold. */
export async function computeSasCode(
  myPublicKey: Uint8Array,
  peerPublicKeyB64: string,
): Promise<string[]> {
  if (!isSasSupported()) {
    throw new Error('SAS verification requires a secure context (HTTPS or localhost)');
  }
  const peerPublicKey = decodeBase64(peerPublicKeyB64);
  const [first, second] = [myPublicKey, peerPublicKey].sort(compareBytes);
  const combined = new Uint8Array(first!.length + second!.length);
  combined.set(first!, 0);
  combined.set(second!, first!.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', combined));
  const emoji: string[] = [];
  for (let i = 0; i < 6; i++) {
    emoji.push(SAS_EMOJI_ALPHABET[readBits(digest, i * 5, 5)]!);
  }
  return emoji;
}
