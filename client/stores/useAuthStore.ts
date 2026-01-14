import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { getOrGenerateKeys, publicKeyToBase64, type KeyPair } from '../services/CryptoService';
import { log } from '../utils/logger';

const AUTH_TOKEN_KEY = 'auth_token';
const AUTH_TOKEN_ALIAS = 'auth_token';

interface AuthState {
  // Key pair in memory (loaded from secure store)
  keyPair: KeyPair | null;
  publicKeyBase64: string | null;
  // Auth token (persisted)
  token: string | null;
  userId: string | null;
  isLoading: boolean;
  isInitialized: boolean;
  
  // Actions
  initialize: () => Promise<void>;
  setAuthToken: (token: string, userId: string) => Promise<void>;
  getAuthToken: () => Promise<string | null>;
  clearKeys: () => void;
  clearToken: () => Promise<void>;
}

/**
 * Zustand store for authentication and key management
 * Loads key pair from expo-secure-store into memory on app launch
 */
export const useAuthStore = create<AuthState>((set, get) => ({
  keyPair: null,
  publicKeyBase64: null,
  token: null,
  userId: null,
  isLoading: false,
  isInitialized: false,

  /**
   * Initialize the store by loading keys and token from secure store
   * Should be called on app launch
   */
  initialize: async () => {
    const state = get();
    
    // Prevent multiple initializations
    if (state.isLoading || state.isInitialized) {
      return;
    }

    set({ isLoading: true });

    try {
      // Get or generate key pair (loads from secure store)
      const keyPair = await getOrGenerateKeys();
      const publicKeyBase64 = publicKeyToBase64(keyPair.publicKey);

      // Get token from secure store
      let token: string | null = null;
      if (Platform.OS === 'web') {
        token = localStorage.getItem(AUTH_TOKEN_ALIAS);
      } else {
        token = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
      }

      set({
        keyPair,
        publicKeyBase64,
        token,
        isLoading: false,
        isInitialized: true,
      });

      log.info('[AuthStore] initialized');
    } catch (error) {
      log.error('[AuthStore] failed to initialize', error);
      set({
        isLoading: false,
        isInitialized: false,
      });
    }
  },

  /**
   * Set auth token and save to SecureStore
   */
  setAuthToken: async (token: string, userId: string) => {
    try {
      if (Platform.OS === 'web') {
        localStorage.setItem(AUTH_TOKEN_ALIAS, token);
      } else {
        await SecureStore.setItemAsync(AUTH_TOKEN_KEY, token);
      }

      set({ token, userId });
      log.info('[AuthStore] token saved');
    } catch (error) {
      log.error('[AuthStore] failed to save token', error);
      throw error;
    }
  },

  /**
   * Get auth token from SecureStore
   */
  getAuthToken: async () => {
    try {
      let token: string | null = null;
      if (Platform.OS === 'web') {
        token = localStorage.getItem(AUTH_TOKEN_ALIAS);
      } else {
        token = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
      }
      return token;
    } catch (error) {
      log.error('[AuthStore] failed to get token', error);
      return null;
    }
  },

  /**
   * Clear keys from memory (does NOT delete from secure store)
   * Used when app goes to background per project rules
   */
  clearKeys: () => {
    set({
      keyPair: null,
      publicKeyBase64: null,
      isInitialized: false,
    });
    log.info('[AuthStore] keys cleared from memory');
  },

  /**
   * Clear token from memory and SecureStore
   */
  clearToken: async () => {
    try {
      if (Platform.OS === 'web') {
        localStorage.removeItem(AUTH_TOKEN_ALIAS);
      } else {
        await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
      }

      set({ token: null, userId: null });
      log.info('[AuthStore] token cleared');
    } catch (error) {
      log.error('[AuthStore] failed to clear token', error);
    }
  },
}));
