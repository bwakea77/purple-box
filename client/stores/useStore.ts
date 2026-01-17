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
 * Contains sender, message text, timestamp, and ephemeral ordering token
 * 
 * EPHEMERAL ORDERING MODEL:
 * - order: Server-assigned monotonic ordering token (ephemeral, in-memory only)
 * - Order persists across inbox fetches within a session but resets on session end
 * - Optimistic messages have order = null/undefined and always come after server-confirmed messages
 * - Ordering is deterministic within a session but undefined across sessions (intentional)
 */
export interface SignedPayload {
  sender: string;
  message: string;
  timestamp: number;
  order?: number;        // ephemeral server order, monotonic within session
  optimistic?: boolean;  // true for optimistic messages, false/undefined for server-confirmed
  status?: 'pending' | 'sent' | 'delivered';  // Delivery status: pending = created locally, sent = acknowledged by server, delivered = downloaded by recipient
  messageId?: string;    // Client-generated message ID for tracking delivery status
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
  enterChat: (conversationId: string) => Promise<void>;
  leaveChat: (conversationId: string) => Promise<void>;
  exitSession: (userId: string) => void;
  wipe: () => void;
  connectSocket: () => Promise<void>;
  requestOtp: (phoneNumber: string) => Promise<{ success: boolean; error?: string }>;
  verifyOtp: (phoneNumber: string, code: string, publicKey: string, pushToken: string | null) => Promise<{ success: boolean; token?: string; userId?: string; error?: string }>;
}


/**
 * Simple hash function for generating conversation IDs (deterministic, no native modules required)
 * Based on djb2 hash algorithm - good enough for conversation ID generation
 */
function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash; // Convert to 32-bit integer
  }
  // Convert to positive hex string
  return Math.abs(hash).toString(16).padStart(8, '0');
}

/**
 * Generate conversation ID by hashing two user IDs (order-independent)
 */
function generateConversationId(userA: string, userB: string): string {
  // Sort to ensure consistent ordering
  const [s1, s2] = userA < userB ? [userA, userB] : [userB, userA];
  const combined = `${s1}|${s2}`;
  // Use simple hash - deterministic and no native modules required
  return simpleHash(combined);
}

/**
 * Helper function to create a stable message key for deduplication
 */
function getMessageKey(msg: SignedPayload): string {
  return `${msg.sender}:${msg.timestamp}:${msg.message}`;
}

/**
 * GLOBAL COMPARATOR - SINGLE SOURCE OF TRUTH for message ordering
 * 
 * CHRONOLOGICAL ORDERING RULES:
 * 1. Messages with server-assigned order values are sorted by order when both have order
 * 2. When comparing messages with mixed order status (one has order, one doesn't), use timestamp for chronological ordering
 * 3. Messages without order (optimistic) are sorted by timestamp
 * 
 * This ensures chronological ordering in conversations where sent messages (optimistic, no order)
 * are correctly positioned relative to received messages (server-confirmed, has order) based on when they were actually sent/received.
 */
function compareMessages(a: SignedPayload, b: SignedPayload): number {
  // Both have server order - compare by order (monotonic, deterministic)
  if (a.order != null && b.order != null) {
    return a.order - b.order;
  }

  // Mixed case: one has order, one doesn't - use timestamp for chronological ordering
  // This ensures sent messages (optimistic) appear in correct chronological position relative to received messages
  if (a.order != null || b.order != null) {
    return a.timestamp - b.timestamp;
  }

  // Neither has order (both optimistic) - sort by timestamp
  return a.timestamp - b.timestamp;
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

      // Listen for box_status updates (legacy event - just set hasUnread flag)
      socket.on('box_status', (status: string) => {
        if (status === 'FULL') {
          set({ hasUnread: true });
          log.debug('[Store] Box status: FULL - messages waiting');
        }
      });

      // Listen for incoming real-time messages (direct socket delivery when IN_CHAT)
      socket.on('receive_message', async (message: { conversationId: string; messageId: string; cipherText: string; seq: number }) => {
        try {
          const state = get();
          if (!state.keys || !state.userId) {
            log.error('[Store] Cannot process receive_message - keys or userId not available');
            return;
          }

          // Decrypt message
          const decrypted = decrypt(message.cipherText, state.keys.secretKey);
          if (!decrypted) {
            log.error('[Store] Failed to decrypt receive_message');
            return;
          }

          const payload: SignedPayload = JSON.parse(decrypted);
          // Map server seq to order for compatibility with existing ordering logic
          payload.order = message.seq;
          payload.optimistic = false;

          // Extract recipient userId from conversationId (we need to determine the other participant)
          // For now, we'll need to track conversationId -> userId mapping
          // Actually, we need the 'to' userId - let's add it to the message payload from server
          // For now, let's use a workaround: extract from conversationId or store mapping
          // Actually, the server knows who the recipient is, so we should include it in the message
          // But for MVP, let's use the sender from the payload and assume it's the other user
          // Wait - we need to know which conversation this is for. Let's derive it from conversationId
          // Actually, we need to store a mapping of conversationId -> otherUserId
          // For simplicity, let's add 'to' to the receive_message payload on server side
          // But for now, let's use a simpler approach: store conversations by conversationId instead of userId
          // Actually, let's keep it simple and use the sender from payload - the 'to' is implicit
          // We'll need to update the inbox structure or add conversation tracking
          // For now, let's keep the existing structure and use sender as the key (legacy support)
          const currentInbox = state.inbox[payload.sender] || [];
          const updatedMessages = [...currentInbox, payload].sort(compareMessages);
          
          set({
            inbox: {
              ...state.inbox,
              [payload.sender]: updatedMessages,
            },
          });

          log.debug('[Store] Received real-time message', { conversationId: message.conversationId, seq: message.seq });
        } catch (error) {
          log.error('[Store] Error processing receive_message', error);
        }
      });

      // Listen for conversation_waiting event (when ONLINE_IDLE and message is buffered)
      socket.on('conversation_waiting', (data: { conversationId: string }) => {
        log.debug('[Store] conversation_waiting event received', { conversationId: data.conversationId });
        // Can trigger UI notification or update state if needed
        set({ hasUnread: true });
      });

      // Listen for message_sent event (server acknowledgment)
      socket.on('message_sent', (data: { messageId: string; timestamp: number }) => {
        try {
          const state = get();
          const updatedInbox: Record<string, SignedPayload[]> = { ...state.inbox };
          let messageFound = false;

          // Search through all inbox entries to find the message by messageId
          for (const userId in updatedInbox) {
            const messages = updatedInbox[userId];
            const messageIndex = messages.findIndex(msg => msg.messageId === data.messageId);
            
            if (messageIndex !== -1) {
              // Update the message status to 'sent'
              updatedInbox[userId] = [
                ...messages.slice(0, messageIndex),
                { ...messages[messageIndex], status: 'sent' },
                ...messages.slice(messageIndex + 1),
              ];
              messageFound = true;
              log.debug('[Store] Message status updated to sent', { messageId: data.messageId, userId });
              break; // Message found, no need to continue searching
            }
          }

          if (messageFound) {
            set({ inbox: updatedInbox });
          } else {
            log.warn('[Store] message_sent event received but message not found', { messageId: data.messageId });
          }
        } catch (error) {
          log.error('[Store] Error processing message_sent event', error);
        }
      });

      // Listen for message_delivered event (when recipient downloads the buffer)
      socket.on('message_delivered', (data: { messageId: string }) => {
        try {
          const state = get();
          const updatedInbox: Record<string, SignedPayload[]> = { ...state.inbox };
          let messageFound = false;

          // Search through all inbox entries to find the message by messageId
          for (const userId in updatedInbox) {
            const messages = updatedInbox[userId];
            const messageIndex = messages.findIndex(msg => msg.messageId === data.messageId);
            
            if (messageIndex !== -1) {
              // Update the message status to 'delivered'
              updatedInbox[userId] = [
                ...messages.slice(0, messageIndex),
                { ...messages[messageIndex], status: 'delivered' },
                ...messages.slice(messageIndex + 1),
              ];
              messageFound = true;
              log.debug('[Store] Message status updated to delivered', { messageId: data.messageId, userId });
              break; // Message found, no need to continue searching
            }
          }

          if (messageFound) {
            set({ inbox: updatedInbox });
          } else {
            log.warn('[Store] message_delivered event received but message not found', { messageId: data.messageId });
          }
        } catch (error) {
          log.error('[Store] Error processing message_delivered event', error);
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

      // Get userId from current state, AuthStore, or extract from token
      let currentUserId = state.userId || useAuthStore.getState().userId;
      
      // If userId is still null, extract it from the token (token is just userId for MVP)
      if (!currentUserId && token) {
        currentUserId = token;
        log.debug('[Store] Extracted userId from token');
      }

      if (!currentUserId) {
        throw new Error('Unable to determine userId: token not available');
      }

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

    // If store is not initialized, try to initialize (regardless of auth state)
    if (!state.socket || !state.keys || !state.userId) {
      log.debug('[Store] Store not initialized, attempting to connect socket', {
        hasSocket: !!state.socket,
        hasKeys: !!state.keys,
        hasUserId: !!state.userId,
        isAuthenticated: state.isAuthenticated,
      });
      try {
        await get().connectSocket();
        // Re-get state after connecting
        const newState = get();
        if (!newState.socket || !newState.keys || !newState.userId) {
          log.error('[Store] Store still not initialized after connectSocket', {
            hasSocket: !!newState.socket,
            hasKeys: !!newState.keys,
            hasUserId: !!newState.userId,
          });
          throw new Error('Store not initialized after connection attempt');
        }
        log.debug('[Store] Store successfully initialized');
      } catch (error) {
        log.error('[Store] Failed to initialize store for sendMessage:', error);
        throw new Error(`Store not initialized: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    // Re-check initialization after potential reconnection
    const currentState = get();
    if (!currentState.socket || !currentState.keys || !currentState.userId) {
      log.error('[Store] Store validation failed', {
        hasSocket: !!currentState.socket,
        hasKeys: !!currentState.keys,
        hasUserId: !!currentState.userId,
      });
      throw new Error('Store not initialized');
    }

    if (!currentState.socket.connected) {
      throw new Error('Socket not connected');
    }

    try {
      // Construct SignedPayload with plaintext message.
      // It will be end-to-end encrypted via TweetNaCl when we encrypt `payloadJson`.
      const payload: SignedPayload = {
        sender: currentState.userId,
        message: text,
        timestamp: Date.now(),
      };

      // Serialize payload to JSON string
      const payloadJson = JSON.stringify(payload);

      // First, get the recipient's public key from the server
      const recipientPublicKeyBase64 = await new Promise<string>((resolve, reject) => {
        if (!currentState.socket) {
          reject(new Error('Socket not available'));
          return;
        }

        currentState.socket.emit('get_public_key', to, (response: {
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

      // Generate conversation ID
      const conversationId = generateConversationId(currentState.userId, to);
      
      // Generate message ID (UUID v4)
      const messageId = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;

      // Optimistically add to inbox[to] with original text (not encrypted) so user sees their own message
      // EPHEMERAL ORDERING: Optimistic messages have order = null/undefined and always come after server-confirmed messages
      const optimisticPayload: SignedPayload = {
        sender: currentState.userId,
        message: text, // Use original text for display
        timestamp: payload.timestamp,
        order: undefined, // Optimistic messages have no order (will be assigned by server on confirmation)
        optimistic: true, // Mark as optimistic
        status: 'pending', // New messages default to pending status (created locally, not yet on server)
        messageId: messageId, // Store messageId for tracking delivery status
      };
      const currentInbox = currentState.inbox[to] || [];
      const updatedMessages = [...currentInbox, optimisticPayload].sort(compareMessages);
      set({
        inbox: {
          ...currentState.inbox,
          [to]: updatedMessages,
        },
      });

      // Emit 'send_message' to socket with new payload format
      currentState.socket.emit('send_message', {
        conversationId,
        messageId,
        cipherText,
        to, // Keep 'to' for now for backwards compatibility with server
      });

      log.info('[Store] message sent', { to });
    } catch (error) {
      log.error('[Store] error sending message', error);
      throw error;
    }
  },


  /**
   * Enter chat: Emit enter_chat, flush buffer, update messages
   * @param conversationId - The conversation ID
   */
  enterChat: async (conversationId: string) => {
    const state = get();

    if (!state.socket || !state.keys || !state.userId) {
      log.error('[Store] Store not initialized for enterChat');
      return;
    }

    if (!state.socket.connected) {
      log.error('[Store] Socket not connected for enterChat');
      return;
    }

    try {
      const response = await new Promise<{ success: boolean; messages?: Array<{ messageId: string; cipherText: string; seq: number }>; error?: string }>((resolve, reject) => {
        if (!state.socket) {
          reject(new Error('Socket not available'));
          return;
        }

        state.socket.emit('enter_chat', { conversationId }, (response: {
          success: boolean;
          messages?: Array<{ messageId: string; cipherText: string; seq: number }>;
          error?: string;
        }) => {
          if (!response.success) {
            reject(new Error(response.error || 'Failed to enter chat'));
            return;
          }
          resolve(response);
        });
      });

      // Decrypt and add buffered messages to inbox
      if (response.messages && response.messages.length > 0) {
        // We need to determine which userId to use as the key
        // For now, we'll need to track conversationId -> otherUserId mapping
        // Actually, we can extract it from the decrypted payload (sender field)
        // But we need to know which conversation this is for
        // Let's decrypt first message to get sender
        const firstMsg = response.messages[0];
        const decrypted = decrypt(firstMsg.cipherText, state.keys!.secretKey);
        if (decrypted) {
          const payload: SignedPayload = JSON.parse(decrypted);
          const otherUserId = payload.sender;
          
          // Decrypt all messages and add to inbox
          const decryptedPayloads: SignedPayload[] = [];
          for (const msg of response.messages) {
            const dec = decrypt(msg.cipherText, state.keys!.secretKey);
            if (dec) {
              const p: SignedPayload = JSON.parse(dec);
              p.order = msg.seq;
              p.optimistic = false;
              decryptedPayloads.push(p);
            }
          }

          // Merge with existing messages
          const existingMessages = state.inbox[otherUserId] || [];
          const existingMap = new Map<string, SignedPayload>();
          existingMessages.forEach(msg => {
            existingMap.set(getMessageKey(msg), msg);
          });

          decryptedPayloads.forEach(msg => {
            const key = getMessageKey(msg);
            if (!existingMap.has(key)) {
              existingMap.set(key, msg);
            }
          });

          const updatedMessages = Array.from(existingMap.values()).sort(compareMessages);
          
          set({
            inbox: {
              ...state.inbox,
              [otherUserId]: updatedMessages,
            },
          });

          log.debug('[Store] Entered chat, flushed buffer', { conversationId, messages: response.messages.length });
        }
      }
    } catch (error) {
      log.error('[Store] Error entering chat:', error);
      throw error;
    }
  },

  /**
   * Leave chat: Emit leave_chat to update presence
   * @param conversationId - The conversation ID
   */
  leaveChat: async (conversationId: string) => {
    const state = get();

    if (!state.socket || !state.userId) {
      log.error('[Store] Store not initialized for leaveChat');
      return;
    }

    if (!state.socket.connected) {
      log.error('[Store] Socket not connected for leaveChat');
      return;
    }

    try {
      if (state.socket) {
        state.socket.emit('leave_chat', { conversationId });
        log.debug('[Store] Left chat', { conversationId });
      }
    } catch (error) {
      log.error('[Store] Error leaving chat:', error);
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
