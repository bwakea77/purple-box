import nacl from 'tweetnacl';
import * as naclUtil from 'tweetnacl-util';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { log } from '../utils/logger';

const KEY_PAIR_STORAGE_KEY = 'user_keypair';
const KEY_PAIR_ALIAS = 'user_keypair';

/**
 * KeyPair interface for storing public and secret keys
 */
export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/**
 * Gets or generates a key pair
 * - Checks expo-secure-store for an existing key pair
 * - If found, decodes from Base64 and returns
 * - If not, generates a new key pair, encodes to Base64, saves to SecureStore, and returns
 * 
 * @returns The key pair (either retrieved or newly generated)
 */
export async function getOrGenerateKeys(): Promise<KeyPair> {
  try {
    let storedKeyPair: string | null = null;

    // Platform-specific storage
    if (Platform.OS === 'web') {
      // Use localStorage for web
      storedKeyPair = localStorage.getItem(KEY_PAIR_ALIAS);
    } else {
      // Use SecureStore for native (iOS/Android)
      storedKeyPair = await SecureStore.getItemAsync(KEY_PAIR_STORAGE_KEY);
    }
    
    if (storedKeyPair) {
      // Decode from Base64
      const decoded = naclUtil.decodeBase64(storedKeyPair);
      
      // Extract public key (first 32 bytes) and secret key (next 32 bytes)
      const publicKey = decoded.slice(0, 32);
      const secretKey = decoded.slice(32, 64);
      
      return {
        publicKey,
        secretKey,
      };
    }
    
    // Generate new key pair
    const keyPair = nacl.box.keyPair();
    
    // Encode to Base64: [publicKey(32 bytes) + secretKey(32 bytes)]
    const combined = new Uint8Array(64);
    combined.set(keyPair.publicKey, 0);
    combined.set(keyPair.secretKey, 32);
    const encoded = naclUtil.encodeBase64(combined);
    
    // Save to platform-specific storage
    if (Platform.OS === 'web') {
      // Use localStorage for web
      localStorage.setItem(KEY_PAIR_ALIAS, encoded);
    } else {
      // Use SecureStore for native (iOS/Android)
      await SecureStore.setItemAsync(KEY_PAIR_STORAGE_KEY, encoded);
    }
    
    return {
      publicKey: keyPair.publicKey,
      secretKey: keyPair.secretKey,
    };
  } catch (error) {
    log.error('[CryptoService] error in getOrGenerateKeys', error);
    throw new Error('Failed to get or generate keys');
  }
}

/**
 * Encrypts a message using ephemeral key pair encryption
 * - Generates a ONE-TIME ephemeral key pair and a random nonce
 * - Encrypts the message using nacl.box
 * - Returns a Base64 string that packs: [nonce + ephemeralPublicKey + encryptedMessage]
 * 
 * @param message - The plaintext message to encrypt
 * @param recipientPublicKeyBase64 - The recipient's public key as Base64 string
 * @returns Base64 encoded string containing: [nonce(24 bytes) + ephemeralPublicKey(32 bytes) + encryptedMessage]
 */
export function encrypt(
  message: string,
  recipientPublicKeyBase64: string
): string {
  try {
    // Decode recipient's public key from Base64
    const recipientPublicKey = naclUtil.decodeBase64(recipientPublicKeyBase64);
    
    // Generate a ONE-TIME ephemeral key pair
    const ephemeralKeyPair = nacl.box.keyPair();
    
    // Generate a random nonce (24 bytes)
    const nonce = nacl.randomBytes(24);
    
    // Convert message to bytes
    const messageBytes = naclUtil.decodeUTF8(message);
    
    // Encrypt using nacl.box
    const encryptedMessage = nacl.box(
      messageBytes,
      nonce,
      recipientPublicKey,
      ephemeralKeyPair.secretKey
    );
    
    if (!encryptedMessage) {
      throw new Error('Encryption failed');
    }
    
    // Pack: [nonce(24 bytes) + ephemeralPublicKey(32 bytes) + encryptedMessage]
    const packed = new Uint8Array(24 + 32 + encryptedMessage.length);
    packed.set(nonce, 0);
    packed.set(ephemeralKeyPair.publicKey, 24);
    packed.set(encryptedMessage, 24 + 32);
    
    // Return Base64 encoded string
    return naclUtil.encodeBase64(packed);
  } catch (error) {
    log.error('[CryptoService] encryption error', error);
    throw new Error('Failed to encrypt message');
  }
}

/**
 * Decrypts a ciphertext message
 * - Decodes Base64
 * - Slices the array to extract the nonce, ephemeral public key, and the encrypted box
 * - Uses nacl.box.open to decrypt
 * - Returns the UTF8 string or null if failed
 * 
 * @param cipherTextBase64 - Base64 encoded ciphertext containing: [nonce + ephemeralPublicKey + encryptedMessage]
 * @param mySecretKey - The recipient's secret key (Uint8Array)
 * @returns The decrypted plaintext message as UTF8 string, or null if decryption failed
 */
export function decrypt(
  cipherTextBase64: string,
  mySecretKey: Uint8Array
): string | null {
  try {
    // Decode Base64
    const packed = naclUtil.decodeBase64(cipherTextBase64);
    
    // Extract components:
    // - nonce: first 24 bytes
    // - ephemeralPublicKey: next 32 bytes
    // - encryptedMessage: remaining bytes
    const nonce = packed.slice(0, 24);
    const ephemeralPublicKey = packed.slice(24, 56);
    const encryptedMessage = packed.slice(56);
    
    // Decrypt using nacl.box.open
    const decrypted = nacl.box.open(
      encryptedMessage,
      nonce,
      ephemeralPublicKey,
      mySecretKey
    );
    
    if (!decrypted) {
      // Decryption failed
      return null;
    }
    
    // Convert decrypted bytes to UTF8 string
    return naclUtil.encodeUTF8(decrypted);
  } catch (error) {
    log.error('[CryptoService] decryption error', error);
    return null;
  }
}

/**
 * Converts a public key Uint8Array to Base64 string
 * @param publicKey - The public key as Uint8Array
 * @returns Base64 encoded public key
 */
export function publicKeyToBase64(publicKey: Uint8Array): string {
  return naclUtil.encodeBase64(publicKey);
}

/**
 * Converts a Base64 string to public key Uint8Array
 * @param base64 - Base64 encoded public key
 * @returns The public key as Uint8Array
 */
export function publicKeyFromBase64(base64: string): Uint8Array {
  return naclUtil.decodeBase64(base64);
}
