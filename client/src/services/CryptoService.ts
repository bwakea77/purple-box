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
