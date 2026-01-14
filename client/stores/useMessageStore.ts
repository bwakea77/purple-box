import { create } from 'zustand';
import { decrypt } from '../services/CryptoService';
import { useAuthStore } from './useAuthStore';
import { log } from '../utils/logger';

interface MessageState {
  // Message state (RAM only - never persisted)
  hasMessage: boolean;
  decryptedMessage: string | null;
  isLoading: boolean;
  error: string | null;
  
  // Actions
  setHasMessage: (hasMessage: boolean) => void;
  setDecryptedMessage: (message: string | null) => void;
  fetchAndDecryptMessage: (encryptedPayload: string, senderPublicKeyBase64?: string) => Promise<void>;
  wipe: () => void;
}

/**
 * Zustand store for message state (RAM only)
 * Messages are NEVER persisted - only exist in memory
 */
export const useMessageStore = create<MessageState>((set, get) => ({
  hasMessage: false,
  decryptedMessage: null,
  isLoading: false,
  error: null,

  /**
   * Set whether a message is waiting
   */
  setHasMessage: (hasMessage: boolean) => {
    set({ hasMessage });
  },

  /**
   * Set the decrypted message
   */
  setDecryptedMessage: (message: string | null) => {
    set({ decryptedMessage: message });
  },

  /**
   * Fetch and decrypt a message
   * The encryptedPayload already contains the sender's public key (first 32 bytes)
   */
  fetchAndDecryptMessage: async (encryptedPayload: string, senderPublicKeyBase64?: string) => {
    set({ isLoading: true, error: null });

    try {
      const authStore = useAuthStore.getState();
      const keyPair = authStore.keyPair;

      if (!keyPair) {
        throw new Error('Key pair not available');
      }

      // Decrypt the message (sender public key is included in ciphertext)
      const decrypted = decrypt(encryptedPayload, keyPair.secretKey);

      set({
        decryptedMessage: decrypted,
        isLoading: false,
        hasMessage: false, // Message has been retrieved
      });
    } catch (error) {
      log.error('[MessageStore] failed to decrypt message', error);
      set({
        error: error instanceof Error ? error.message : 'Failed to decrypt message',
        isLoading: false,
      });
    }
  },

  /**
   * Wipe all message data from memory
   * Called when AppState goes to background
   */
  wipe: () => {
    set({
      hasMessage: false,
      decryptedMessage: null,
      isLoading: false,
      error: null,
    });
    log.info('[MessageStore] all messages wiped from memory');
  },
}));
