import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import * as SecureStore from 'expo-secure-store';
import * as Contacts from 'expo-contacts';
import { parsePhoneNumber } from 'libphonenumber-js';
import { Platform } from 'react-native';
import { getOrGenerateKeys, encrypt, decrypt, type KeyPair, publicKeyToBase64 } from '../services/CryptoService';
import { useAuthStore } from './useAuthStore';
import { log } from '../utils/logger';

const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL || 'https://purple-box.onrender.com';
const AUTH_TOKEN_KEY = 'auth_token';
const AUTH_TOKEN_ALIAS = 'auth_token';

/**
 * SignedPayload interface for messages
 * Contains sender, message text, and timestamp
 */
export interface SignedPayload {
  sender: string;
  message: string;
  timestamp: number;
}

interface Contact {
  name: string;
  phoneNumber: string;
  userId: string;
}

interface StoreState {
  // State variables
  socket: Socket | null;
  keys: KeyPair | null;
  userId: string | null;
  phoneNumber: string | null;
  isAuthenticated: boolean;
  contacts: Contact[];
  inbox: Record<string, SignedPayload[]>;
  hasUnread: boolean;
  pushToken: string | null;

  // Actions
  checkLogin: () => Promise<boolean>;
  login: (phone: string, token: string, userId: string) => Promise<void>;
  logout: () => Promise<void>;
  initialize: () => Promise<void>;
  registerForPushNotifications: () => Promise<void>;
  fetchContacts: () => Promise<void>;
  syncContacts: () => Promise<void>;
  sendMessage: (to: string, text: string) => Promise<void>;
  checkInbox: () => Promise<void>;
  exitSession: (userId: string) => void;
  wipe: () => void;
  connectSocket: () => Promise<void>;
  requestOtp: (phoneNumber: string) => Promise<{ success: boolean; error?: string }>;
  verifyOtp: (phoneNumber: string, code: string, publicKey: string, pushToken: string | null) => Promise<{ success: boolean; token?: string; userId?: string; error?: string }>;
}


/**
 * Helper function to register for push notifications
 * Returns the push token or null
 */
async function registerForPushNotificationsHelper(): Promise<string | null> {
  try {
    // Check if running on a physical device
    if (!Device.isDevice) {
      log.debug('[Store] Push notifications not available on simulator/emulator');
      return null;
    }

    // Request permissions
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      log.debug('[Store] Push notification permission not granted');
      return null;
    }

    // Get the push token
    const tokenData = await Notifications.getExpoPushTokenAsync();
    const token = tokenData.data;

    log.debug('[Store] Push token registered:', token);
    return token;
  } catch (error) {
    log.error('[Store] Error registering for push notifications:', error);
    return null;
  }
}

/**
 * Zustand store for RAM-only session state
 * All data is ephemeral and never persisted
 */
export const useStore = create<StoreState>((set, get) => ({
  // Initial state
  socket: null,
  keys: null,
  userId: null,
  phoneNumber: null,
  isAuthenticated: false,
  contacts: [],
  inbox: {},
  hasUnread: false,
  pushToken: null,

  /**
   * Register for push notifications: Request permissions and get push token
   */
  registerForPushNotifications: async () => {
    const token = await registerForPushNotificationsHelper();
    set({ pushToken: token });
  },

  /**
   * Connect socket: Internal helper to establish socket connection
   */
  connectSocket: async () => {
    const state = get();

    // Prevent multiple connections
    if (state.socket?.connected) {
      return;
    }

    try {
      // Get token from SecureStore
      let token: string | null = null;
      if (Platform.OS === 'web') {
        token = localStorage.getItem(AUTH_TOKEN_ALIAS);
      } else {
        token = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
      }

      if (!token) {
        throw new Error('No auth token available');
      }

      // Register for push notifications
      const pushToken = await registerForPushNotificationsHelper();

      // Load keys via CryptoService
      const keys = await getOrGenerateKeys();

      // Connect socket
      const socket = io(SERVER_URL, {
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        enableOfflineQueue: true,
        autoConnect: true,
      } as any);

      // Handle socket connection
      socket.on('connect', () => {
        log.debug('✅ Socket connected:', socket.id);
        log.debug('[Store] Socket connected');
        // Identify with token immediately upon connection
        // Use a small delay to prevent rapid re-identification during navigation
        setTimeout(() => {
          if (socket.connected) {
            socket.emit('identify', { token });
            log.debug('[Store] Identified with token, push token:', pushToken || 'none');
          }
        }, 100);
      });

      // Listen for box_status updates
      socket.on('box_status', (status: string) => {
        if (status === 'FULL') {
          set({ hasUnread: true });
          log.debug('[Store] Box status: FULL');
        }
      });

      // Listen for incoming messages and decrypt them
      socket.on('receive_message', (message: { sender: string; content: string; timestamp: number }) => {
        try {
          // Server should never send plaintext; this handler is legacy.
          // Treat content as already-readable (no additional AES layer).
          const payload: SignedPayload = {
            sender: message.sender,
            message: message.content,
            timestamp: message.timestamp || Date.now(),
          };
          
          // Add message to inbox
          const state = get();
          const currentInbox = state.inbox[message.sender] || [];
          set({
            inbox: {
              ...state.inbox,
              [message.sender]: [...currentInbox, payload],
            },
            hasUnread: true,
          });
          
          log.info('[Store] message received', { from: message.sender });
        } catch (error) {
          log.error('[Store] error handling received message', error);
          // Fallback: add message with original content
          const payload: SignedPayload = {
            sender: message.sender,
            message: message.content,
            timestamp: message.timestamp || Date.now(),
          };
          
          const state = get();
          const currentInbox = state.inbox[message.sender] || [];
          set({
            inbox: {
              ...state.inbox,
              [message.sender]: [...currentInbox, payload],
            },
            hasUnread: true,
          });
        }
      });

      socket.on('disconnect', () => {
        log.debug('[Store] Socket disconnected');
      });

      socket.on('connect_error', (error) => {
        log.debug('❌ Socket connection error:', error);
        log.error('[Store] Socket connection error:', error);
      });

      socket.on('error', (error: { message?: string }) => {
        log.error('[Store] Socket error:', error);
        const errorMsg = error.message?.toLowerCase() || '';
        
        // Be VERY conservative - only logout on explicit, confirmed auth failures
        // Ignore identify errors, connection errors, and transient errors
        const isAuthError = (errorMsg.includes('unauthorized') || errorMsg.includes('forbidden')) &&
                           !errorMsg.includes('connection') && 
                           !errorMsg.includes('timeout') &&
                           !errorMsg.includes('identify') &&
                           !errorMsg.includes('invalid token') && // Identify errors use this
                           !errorMsg.includes('expired token'); // Identify errors use this
        if (isAuthError) {
          // Token invalid, user needs to re-authenticate
          log.error('[Store] Authentication failed, user needs to re-login');
          // Use longer timeout to prevent immediate state change during navigation
          setTimeout(() => {
            const currentState = get();
            // Double-check we're still authenticated and socket is still connected
            // This prevents logout during navigation transitions
            if (currentState.isAuthenticated && !currentState.socket?.connected) {
              // Only logout if socket is disconnected AND we got an auth error
              // This means the token is truly invalid
              get().logout();
            }
          }, 1000);
        } else {
          // For identify errors and other transient errors, just log them
          log.warn('[Store] Socket error (non-critical):', error.message);
        }
      });

      // Get userId from current state or AuthStore
      const currentUserId = state.userId || useAuthStore.getState().userId;

      set({
        socket,
        keys,
        pushToken,
        userId: currentUserId,
      });

      log.debug('[Store] Socket connected successfully');
    } catch (error) {
      log.error('[Store] Error connecting socket:', error);
      throw error;
    }
  },

  /**
   * Check login: Check SecureStore for authToken on app launch
   * Returns true if authenticated and socket connected, false otherwise
   * Prevents changing isAuthenticated from true to false during active sessions
   */
  checkLogin: async () => {
    log.debug('[DEBUG] checkLogin called, current isAuthenticated:', get().isAuthenticated);
    const state = get();
    
    // CRITICAL: If already authenticated, don't re-check - this prevents auth state from being reset during navigation
    if (state.isAuthenticated && state.userId) {
      log.debug('[DEBUG] Already authenticated, skipping checkLogin to prevent state reset');
      return true;
    }
    
    try {
      // Check SecureStore for token
      let token: string | null = null;
      if (Platform.OS === 'web') {
        token = localStorage.getItem(AUTH_TOKEN_ALIAS);
      } else {
        token = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
      }
      log.debug('[DEBUG] Token retrieved, hasToken:', !!token, 'current isAuthenticated:', state.isAuthenticated);

      if (!token) {
        // No token found - only set to false if we're not already authenticated
        // This prevents flickering during navigation
        log.debug('[DEBUG] No token found, but isAuthenticated is:', state.isAuthenticated, '- NOT changing state');
        if (!state.isAuthenticated) {
          log.debug('[DEBUG] Setting isAuthenticated to false (no token and not already authenticated)');
          set({
            isAuthenticated: false,
            phoneNumber: null,
            userId: null,
          });
        }
        return false;
      }

      // Token found - get userId from AuthStore
      const authStore = useAuthStore.getState();
      
      // CRITICAL: Only set authenticated state if we're not already authenticated
      // This prevents state changes during navigation that could trigger logout
      if (!state.isAuthenticated || !state.userId) {
        log.debug('[DEBUG] Setting isAuthenticated to true (token found, was not authenticated)');
        // Set authenticated state (only if not already authenticated)
        set({
          isAuthenticated: true,
          userId: authStore.userId || null,
          // Note: phoneNumber is not stored persistently, would need to fetch from server
          phoneNumber: null,
        });
      } else {
        log.debug('[DEBUG] Already authenticated, not changing state');
      }

      // Connect socket (this will also load keys and push token)
      // Only connect if not already connected to prevent reconnection loops
      if (!state.socket?.connected) {
        try {
          await get().connectSocket();
        } catch (socketError) {
          log.error('[Store] Error connecting socket during checkLogin:', socketError);
          // Don't set isAuthenticated to false on socket errors - token is still valid
        }
      }

      log.debug('[Store] Login checked: authenticated and socket connected');
      return true;
    } catch (error) {
      log.error('[Store] Error checking login:', error);
      // Only set to false if we're not already authenticated
      // This prevents navigation flickering
      if (!state.isAuthenticated) {
        set({
          isAuthenticated: false,
          phoneNumber: null,
          userId: null,
        });
      }
      return false;
    }
  },

  /**
   * Login: Save token to SecureStore, set state, and connect socket
   */
  login: async (phone: string, token: string, userId: string) => {
    try {
      // Save token to SecureStore
      if (Platform.OS === 'web') {
        localStorage.setItem(AUTH_TOKEN_ALIAS, token);
      } else {
        await SecureStore.setItemAsync(AUTH_TOKEN_KEY, token);
      }

      // Also update AuthStore
      await useAuthStore.getState().setAuthToken(token, userId);

      // Set state
      set({
        isAuthenticated: true,
        phoneNumber: phone,
        userId: userId,
      });

      // Connect socket
      await get().connectSocket();

      log.debug('[Store] Login successful:', phone, userId);
    } catch (error) {
      log.error('[Store] Error during login:', error);
      throw error;
    }
  },

  /**
   * Logout: Delete token from SecureStore, disconnect socket, and reset state
   */
  logout: async () => {
    log.debug('[DEBUG] logout() called - this will cause navigation to login screen');
    log.debug('[Store] logout() called');
    try {
      // Delete token from SecureStore
      if (Platform.OS === 'web') {
        localStorage.removeItem(AUTH_TOKEN_ALIAS);
      } else {
        await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
      }

      // Also clear from AuthStore
      await useAuthStore.getState().clearToken();

      // Disconnect socket
      const state = get();
      if (state.socket) {
        state.socket.disconnect();
      }

      // Reset state
      set({
        isAuthenticated: false,
        phoneNumber: null,
        userId: null,
        socket: null,
        keys: null,
        contacts: [],
        inbox: {},
        hasUnread: false,
        pushToken: null,
      });
      log.debug('[Store] Logout successful');
    } catch (error) {
      log.error('[Store] Error during logout:', error);
      throw error;
    }
  },

  /**
   * Initialize: Legacy method for backward compatibility
   * Now just ensures socket is connected if authenticated, without re-checking login
   */
  initialize: async () => {
    const state = get();

    // If already authenticated and socket connected, do nothing
    if (state.isAuthenticated && state.socket?.connected) {
      return;
    }

    // If authenticated but socket not connected, try to connect
    // But don't call checkLogin() as it might change auth state during navigation
    if (state.isAuthenticated && !state.socket?.connected) {
      try {
        await get().connectSocket();
      } catch (error) {
        log.error('[Store] Error connecting socket during initialize:', error);
        // Don't change auth state on socket connection errors
      }
    }
    // If not authenticated, do nothing - let App.tsx handle login check
  },

  /**
   * Fetch contacts: Emit 'get_contacts' and update contacts list
   * @deprecated Use syncContacts() instead for real contact sync with names
   */
  fetchContacts: async () => {
    const state = get();

    if (!state.socket || !state.socket.connected) {
      throw new Error('Socket not connected');
    }

    try {
      const userIds = await new Promise<string[]>((resolve, reject) => {
        if (!state.socket) {
          reject(new Error('Socket not available'));
          return;
        }

        state.socket.emit('get_contacts', (response: {
          success: boolean;
          contacts?: string[];
          error?: string;
        }) => {
          if (!response.success) {
            reject(new Error(response.error || 'Failed to get contacts'));
            return;
          }

          resolve(response.contacts || []);
        });
      });

      // Convert string[] to Contact[] format (without names since this is legacy method)
      const contacts: Contact[] = userIds.map((userId) => ({
        name: userId,
        phoneNumber: '',
        userId,
      }));

      set({ contacts });
      log.debug('[Store] Contacts fetched:', contacts.length);
    } catch (error) {
      log.error('[Store] Error fetching contacts:', error);
      throw error;
    }
  },

  /**
   * Sync contacts: Request permissions, fetch local contacts, normalize phone numbers,
   * sync with server, and merge with local contact names
   */
  syncContacts: async () => {
    log.debug('[DEBUG] syncContacts called, isAuthenticated:', get().isAuthenticated);
    try {
      // Request permissions
      const { status } = await Contacts.requestPermissionsAsync();
      if (status !== 'granted') {
        throw new Error('Contacts permission not granted');
      }

      // Fetch all contacts with phone numbers
      const { data: localContacts } = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.PhoneNumbers, Contacts.Fields.Name],
      });

      // Normalize phone numbers to E.164 format
      const normalizedNumbers: string[] = [];
      const phoneNumberToNameMap: Record<string, string> = {};

      for (const contact of localContacts) {
        if (contact.phoneNumbers && contact.phoneNumbers.length > 0) {
          const contactName = contact.name || 'Unknown';
          
          for (const phoneNumber of contact.phoneNumbers) {
            if (!phoneNumber.number) continue;

            try {
              // Parse and format to E.164
              // Try parsing with Tanzania as default country code, fallback to international format
              let parsedNumber;
              try {
                // First try with Tanzania country code (TZ = +255)
                parsedNumber = parsePhoneNumber(phoneNumber.number, 'TZ');
              } catch {
                // If parsing with country code fails, try without (for already formatted numbers)
                try {
                  parsedNumber = parsePhoneNumber(phoneNumber.number);
                } catch {
                  // If that also fails, try with digits only and country code
                  const digitsOnly = phoneNumber.number.replace(/\D/g, '');
                  parsedNumber = parsePhoneNumber(digitsOnly, 'TZ');
                }
              }

              if (parsedNumber && parsedNumber.isValid()) {
                const e164Number = parsedNumber.format('E.164');
                normalizedNumbers.push(e164Number);
                // Store the first name we encounter for this number (prefer mobile/iPhone labels)
                if (!phoneNumberToNameMap[e164Number] || phoneNumber.label === 'mobile' || phoneNumber.label === 'iPhone') {
                  phoneNumberToNameMap[e164Number] = contactName;
                }
              }
            } catch (parseError) {
              // Skip invalid phone numbers
              log.warn(`[Store] Failed to parse phone number: ${phoneNumber.number}`, parseError);
            }
          }
        }
      }

      // Remove duplicates from normalized numbers
      const uniqueNumbers = Array.from(new Set(normalizedNumbers));

      if (uniqueNumbers.length === 0) {
        set({ contacts: [] });
        log.debug('[Store] No valid phone numbers found in contacts');
        return;
      }

      // Get auth token for the API call
      let token: string | null = null;
      if (Platform.OS === 'web') {
        token = localStorage.getItem(AUTH_TOKEN_ALIAS);
      } else {
        token = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
      }
      if (!token) {
        throw new Error('Authentication required to sync contacts');
      }

      // API call to sync contacts
      const response = await fetch(`${SERVER_URL}/contacts/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ phoneNumbers: uniqueNumbers }),
      });

      // Handle authentication errors BEFORE parsing JSON to avoid parsing errors
      if (response.status === 401 || response.status === 403) {
        log.error('[Store] Authentication error syncing contacts - token may be invalid');
        // Don't throw error or trigger logout - just return empty contacts
        // The user can still use the app, they just won't see synced contacts
        set({ contacts: [] });
        return;
      }

      // Parse JSON only after checking status
      let data;
      try {
        data = await response.json();
      } catch (parseError) {
        // If JSON parsing fails, it's not an auth error - just a server error
        log.error('[Store] Failed to parse response JSON:', parseError);
        set({ contacts: [] });
        return;
      }
      if (!response.ok || !data.success) {
        // Don't throw for non-auth errors - just log and return empty contacts
        log.error('[Store] Failed to sync contacts:', data.error || 'Unknown error');
        set({ contacts: [] });
        return;
      }

      // Merge server data (verified users) with local contact names
      const mergedContacts: Contact[] = (data.users || []).map((user: { phoneNumber: string; publicKey: string; userId: string }) => ({
        name: phoneNumberToNameMap[user.phoneNumber] || user.phoneNumber,
        phoneNumber: user.phoneNumber,
        userId: user.userId,
      }));

      set({ contacts: mergedContacts });
      log.debug('[Store] Contacts synced:', mergedContacts.length, 'verified users found');
    } catch (error) {
      log.error('[Store] Error syncing contacts:', error);
      throw error;
    }
  },

  /**
   * Send message: Construct SignedPayload, encrypt, emit, and optimistically add to inbox
   * @param to - Recipient username
   * @param text - Plaintext message to send
   */
  sendMessage: async (to: string, text: string) => {
    const state = get();

    if (!state.socket || !state.keys || !state.userId) {
      throw new Error('Store not initialized');
    }

    if (!state.socket.connected) {
      throw new Error('Socket not connected');
    }

    try {
      // Construct SignedPayload with plaintext message.
      // It will be end-to-end encrypted via TweetNaCl when we encrypt `payloadJson`.
      const payload: SignedPayload = {
        sender: state.userId,
        message: text,
        timestamp: Date.now(),
      };

      // Serialize payload to JSON string
      const payloadJson = JSON.stringify(payload);

      // First, get the recipient's public key from the server
      const recipientPublicKeyBase64 = await new Promise<string>((resolve, reject) => {
        if (!state.socket) {
          reject(new Error('Socket not available'));
          return;
        }

        state.socket.emit('get_public_key', to, (response: {
          success: boolean;
          publicKey?: string | null;
          error?: string;
        }) => {
          if (!response.success) {
            reject(new Error(response.error || 'Failed to get public key'));
            return;
          }

          if (!response.publicKey) {
            reject(new Error('User is offline or not found.'));
            return;
          }

          resolve(response.publicKey);
        });
      });

      // Encrypt payload using CryptoService with the recipient's public key
      const cipherText = encrypt(payloadJson, recipientPublicKeyBase64);

      // Optimistically add to inbox[to] with original text (not encrypted) so user sees their own message
      const optimisticPayload: SignedPayload = {
        sender: state.userId,
        message: text, // Use original text for display
        timestamp: payload.timestamp,
      };
      const currentInbox = state.inbox[to] || [];
      set({
        inbox: {
          ...state.inbox,
          [to]: [...currentInbox, optimisticPayload],
        },
      });

      // Emit 'send_message' to socket
      state.socket.emit('send_message', {
        to,
        cipherText,
      });

      log.info('[Store] message sent', { to });
    } catch (error) {
      log.error('[Store] error sending message', error);
      throw error;
    }
  },

  /**
   * Check inbox: Emit 'fetch_inbox', decrypt all messages, group by sender, set hasUnread
   */
  checkInbox: async () => {
    const state = get();

    if (!state.socket || !state.keys || !state.userId) {
      throw new Error('Store not initialized');
    }

    if (!state.socket.connected) {
      throw new Error('Socket not connected');
    }

    try {
      const messages = await new Promise<string[]>((resolve, reject) => {
        if (!state.socket) {
          reject(new Error('Socket not available'));
          return;
        }

        state.socket.emit('fetch_inbox', state.userId, (response: {
          success: boolean;
          messages?: string[];
          error?: string;
        }) => {
          if (!response.success) {
            reject(new Error(response.error || 'Failed to fetch inbox'));
            return;
          }

          resolve(response.messages || []);
        });
      });

      // Decrypt all messages
      const decryptedPayloads: SignedPayload[] = [];
      for (const cipherText of messages) {
        try {
          const decrypted = decrypt(cipherText, state.keys!.secretKey);
          if (decrypted) {
            const payload: SignedPayload = JSON.parse(decrypted);
            decryptedPayloads.push(payload);
          }
        } catch (error) {
          log.error('[Store] failed to decrypt message payload', error);
          // Continue with other messages
        }
      }

      // Group messages by sender
      const groupedInbox: Record<string, SignedPayload[]> = { ...state.inbox };
      for (const payload of decryptedPayloads) {
        const sender = payload.sender;
        if (!groupedInbox[sender]) {
          groupedInbox[sender] = [];
        }
        groupedInbox[sender].push(payload);
      }

      // Sort messages by timestamp within each sender's array
      for (const sender in groupedInbox) {
        groupedInbox[sender].sort((a, b) => a.timestamp - b.timestamp);
      }

      // Set hasUnread to true if messages exist
      const hasUnread = decryptedPayloads.length > 0;

      set({
        inbox: groupedInbox,
        hasUnread,
      });

      log.info('[Store] inbox checked', { messages: decryptedPayloads.length, senders: Object.keys(groupedInbox).length });
    } catch (error) {
      log.error('[Store] error checking inbox', error);
      throw error;
    }
  },

  /**
   * Exit session: Delete inbox[userId] from state
   * Destroys the history when leaving the screen
   */
  exitSession: (userId: string) => {
    const state = get();
    const newInbox = { ...state.inbox };
    delete newInbox[userId];
    set({ inbox: newInbox });
    log.debug('[Store] Session exited for:', userId);
  },

  /**
   * Request OTP: Request OTP code for phone number
   */
  requestOtp: async (phoneNumber: string) => {
    const state = get();
    
    // Connection check: ensure socket is connected if it exists
    if (state.socket && !state.socket.connected) {
      state.socket.connect();
    }

    try {
      const response = await fetch(`${SERVER_URL}/auth/request-otp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ phoneNumber }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        return { success: false, error: data.error || 'Failed to request OTP' };
      }

      return { success: true };
    } catch (error) {
      log.error('[Store] Error requesting OTP:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to request OTP',
      };
    }
  },

  /**
   * Verify OTP: Verify OTP code and get auth token
   */
  verifyOtp: async (phoneNumber: string, code: string, publicKey: string, pushToken: string | null) => {
    const state = get();
    
    // Connection check: ensure socket is connected if it exists
    if (state.socket && !state.socket.connected) {
      state.socket.connect();
    }

    try {
      const response = await fetch(`${SERVER_URL}/auth/verify-otp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          phoneNumber,
          code,
          publicKey,
          pushToken,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        return { success: false, error: data.error || 'Failed to verify OTP' };
      }

      return {
        success: true,
        token: data.token,
        userId: data.userId,
      };
    } catch (error) {
      log.error('[Store] Error verifying OTP:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to verify OTP',
      };
    }
  },

  /**
   * Wipe: Reset session data to initial values (but preserve authentication state)
   * CRITICAL: According to project rules, authentication state persists across app restarts
   * Only session data (messages, contacts, inbox) should be wiped
   */
  wipe: () => {
    const state = get();
    log.debug('[DEBUG] wipe() called, current isAuthenticated:', state.isAuthenticated);

    // Disconnect socket if connected
    if (state.socket) {
      state.socket.disconnect();
    }

    // CRITICAL FIX: Preserve authentication state - only wipe session data
    // Authentication state (isAuthenticated, userId, phoneNumber) should persist
    // Only wipe ephemeral session data (contacts, inbox, socket, keys, pushToken)
    set({
      socket: null,
      keys: null,
      // DO NOT reset userId, phoneNumber, or isAuthenticated - these persist per project rules
      contacts: [],
      inbox: {},
      hasUnread: false,
      pushToken: null,
    });

    log.debug('[Store] Session data wiped from memory (auth state preserved)');
  },
}));
