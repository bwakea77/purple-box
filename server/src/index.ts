import 'dotenv/config';
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifySocketIO from 'fastify-socket.io';
import Redis from 'ioredis';
import { Expo } from 'expo-server-sdk';
import type { Server as SocketIOServer, Socket } from 'socket.io';
import { parsePhoneNumber } from 'libphonenumber-js';

// Initialize Expo push notification service
const expo = new Expo();

// Message buffer TTL: 14 days (1209600 seconds) for asynchronous messaging
const MESSAGE_TTL = 1209600;

// Data models
interface UserProfile {
  id: string;
  phoneNumber: string;
  publicKey: string;
  pushToken: string | null;
}

interface OTPData {
  code: string;
  expiresAt: number;
}

// Presence states (server-tracked)
type PresenceState = 'OFFLINE' | 'ONLINE_IDLE' | { type: 'IN_CHAT'; conversationId: string };

// In-memory user socket mapping (zero persistence)
// Maps userId to { socketId, publicKey, pushToken, presence }
interface UserSocketInfo {
  socketId: string;
  publicKey: string;
  pushToken: string | null;
  userId: string;
  presence: PresenceState;
}
const userSockets: Record<string, UserSocketInfo> = {};

// Conversation sequence counters (per conversation, in-memory only)
// Maps conversationId to the next sequence number
const conversationSequenceCounters: Record<string, number> = {};

// Ephemeral message buffer (replaces inbox)
// Key: conversationId, Value: Array of { messageId, cipherText, seq }
// TTL: 14 days (1209600 seconds), no size limit - grows until delivered
interface BufferedMessage {
  messageId: string;
  cipherText: string;
  seq: number;
}
const messageBuffers: Record<string, BufferedMessage[]> = {};

// Helper functions
function generateOTP(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateSessionToken(userId: string): string {
  // Simple token: just userId for MVP
  return userId;
}

/**
 * Simple hash function for generating conversation IDs (deterministic)
 * Uses djb2 algorithm - matches client implementation
 */
function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash; // Convert to 32-bit integer
  }
  // Convert to positive hex string (matches client)
  return Math.abs(hash).toString(16).padStart(8, '0');
}

/**
 * Generate conversation ID by hashing two user IDs
 * Always produces the same ID for the same two users (order-independent)
 * Uses simple hash to match client implementation (no native modules required)
 */
function generateConversationId(userA: string, userB: string): string {
  // Sort to ensure consistent ordering
  const [s1, s2] = userA < userB ? [userA, userB] : [userB, userA];
  const combined = `${s1}|${s2}`;
  return simpleHash(combined);
}

/**
 * Get next sequence number for a conversation
 */
function getNextSequenceNumber(conversationId: string): number {
  if (!conversationSequenceCounters[conversationId]) {
    conversationSequenceCounters[conversationId] = 0;
  }
  return conversationSequenceCounters[conversationId]++;
}

/**
 * Get presence state for a user
 */
function getUserPresence(userId: string): PresenceState {
  const userInfo = userSockets[userId];
  if (!userInfo) {
    return 'OFFLINE';
  }
  return userInfo.presence;
}

/**
 * Normalize phone number to E.164 format
 * This ensures consistency between registration and contact sync
 */
function normalizePhoneNumber(phoneNumber: string): string | null {
  try {
    // Try parsing with Tanzania as default country code, fallback to international format
    let parsedNumber;
    try {
      // First try with Tanzania country code (TZ = +255)
      parsedNumber = parsePhoneNumber(phoneNumber, 'TZ');
    } catch {
      // If parsing with country code fails, try without (for already formatted numbers)
      try {
        parsedNumber = parsePhoneNumber(phoneNumber);
      } catch {
        // If that also fails, try with digits only and country code
        const digitsOnly = phoneNumber.replace(/\D/g, '');
        if (digitsOnly.length < 10) {
          return null; // Too short to be valid
        }
        parsedNumber = parsePhoneNumber(digitsOnly, 'TZ');
      }
    }

    if (parsedNumber && parsedNumber.isValid()) {
      return parsedNumber.format('E.164');
    }
    return null;
  } catch (error) {
    console.error('[Server] Error normalizing phone number:', phoneNumber, error);
    return null;
  }
}

async function getUserByToken(token: string): Promise<UserProfile | null> {
  try {
    // Token is userId for MVP
    const userId = token;
    
    // Get all user keys to find the one matching this userId
    const keys = await redis.keys('user:*');
    for (const key of keys) {
      const userData = await redis.get(key);
      if (userData) {
        const user: UserProfile = JSON.parse(userData);
        if (user.id === userId) {
          return user;
        }
      }
    }
    return null;
  } catch (error) {
    console.error('[Server] Error getting user by token:', error);
    return null;
  }
}

// Initialize Fastify
const fastify = Fastify({
  logger: {
    level: 'info',
    // Ensure no sensitive data is logged
    redact: ['cipherText', 'message', 'payload', 'data'],
  },
});

// Initialize Redis client with zero persistence
// Support REDIS_URL for cloud deployment (e.g., Redis Cloud, Railway, etc.)
// Falls back to REDIS_HOST/REDIS_PORT for local development
const RedisConstructor = Redis as any;
const redis = process.env.REDIS_URL
  ? new RedisConstructor(process.env.REDIS_URL, {
      enableOfflineQueue: false,
    })
  : new RedisConstructor({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      // No persistence - ephemeral mode
      enableOfflineQueue: false,
    });

// Register CORS plugin for HTTP routes
fastify.register(fastifyCors, {
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true,
});

// Register Socket.io plugin
fastify.register(fastifySocketIO as any, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Auth routes
// POST /auth/request-otp
fastify.post('/auth/request-otp', async (request, reply) => {
  try {
    const { phoneNumber } = request.body as { phoneNumber?: string };

    if (!phoneNumber || typeof phoneNumber !== 'string') {
      return reply.status(400).send({ success: false, error: 'Invalid phone number' });
    }

    // Normalize phone number to E.164 format
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    if (!normalizedPhone) {
      return reply.status(400).send({ success: false, error: 'Invalid phone number format' });
    }

    console.log(`[Server] Phone number normalized: ${phoneNumber} -> ${normalizedPhone}`);

    // Generate 6-digit OTP code
    const code = generateOTP();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes from now

    // Store OTP in Redis with TTL of 5 minutes (300 seconds)
    // Use normalized phone number as key
    const otpKey = `otp:${normalizedPhone}`;
    const otpData: OTPData = { code, expiresAt };
    await redis.setex(otpKey, 300, JSON.stringify(otpData));

    // Log the code to console (Mock SMS)
    console.log(`[Server] OTP for ${normalizedPhone}: ${code}`);

    return { success: true };
  } catch (error) {
    console.error('[Server] Error requesting OTP:', error);
    return reply.status(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to request OTP',
    });
  }
});

// POST /auth/verify-otp
fastify.post('/auth/verify-otp', async (request, reply) => {
  try {
    const { phoneNumber, code, publicKey, pushToken } = request.body as {
      phoneNumber?: string;
      code?: string;
      publicKey?: string;
      pushToken?: string | null;
    };

    if (!phoneNumber || typeof phoneNumber !== 'string') {
      return reply.status(400).send({ success: false, error: 'Invalid phone number' });
    }

    if (!code || typeof code !== 'string') {
      return reply.status(400).send({ success: false, error: 'Invalid OTP code' });
    }

    if (!publicKey || typeof publicKey !== 'string') {
      return reply.status(400).send({ success: false, error: 'Invalid public key' });
    }

    // Normalize phone number to E.164 format
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    if (!normalizedPhone) {
      return reply.status(400).send({ success: false, error: 'Invalid phone number format' });
    }

    console.log(`[Server] Phone number normalized: ${phoneNumber} -> ${normalizedPhone}`);

    // Retrieve OTP from Redis (use normalized phone number)
    const otpKey = `otp:${normalizedPhone}`;
    const otpDataStr = await redis.get(otpKey);

    if (!otpDataStr) {
      return reply.status(400).send({ success: false, error: 'OTP not found or expired' });
    }

    const otpData: OTPData = JSON.parse(otpDataStr);

    // Check if OTP matches
    if (otpData.code !== code) {
      return reply.status(400).send({ success: false, error: 'Invalid OTP code' });
    }

    // Check if OTP has expired
    if (Date.now() > otpData.expiresAt) {
      await redis.del(otpKey); // Clean up expired OTP
      return reply.status(400).send({ success: false, error: 'OTP expired' });
    }

    // Delete OTP after successful verification
    await redis.del(otpKey);

    // Get or create user (use normalized phone number)
    let userKey = `user:${normalizedPhone}`;
    let existingUserStr = await redis.get(userKey);
    
    // Migration: If user not found with normalized key, check if they exist with non-normalized key
    // This handles existing users who registered before normalization was added
    if (!existingUserStr && phoneNumber !== normalizedPhone) {
      const oldUserKey = `user:${phoneNumber}`;
      const oldUserStr = await redis.get(oldUserKey);
      if (oldUserStr) {
        console.log(`[Server] Migrating user from non-normalized key: ${phoneNumber} -> ${normalizedPhone}`);
        // Migrate: delete old key, create with normalized key
        const oldUser: UserProfile = JSON.parse(oldUserStr);
        await redis.del(oldUserKey);
        // Update phone number to normalized format
        const migratedUser: UserProfile = {
          ...oldUser,
          phoneNumber: normalizedPhone,
          publicKey,
          pushToken: pushToken || null,
        };
        await redis.set(userKey, JSON.stringify(migratedUser));
        existingUserStr = JSON.stringify(migratedUser);
        console.log(`[Server] User migrated successfully: ${normalizedPhone} (userId: ${oldUser.id})`);
      }
    }
    
    let userId: string;
    if (existingUserStr) {
      const existingUser: UserProfile = JSON.parse(existingUserStr);
      userId = existingUser.id;
      // Update user profile (ensure phone number is normalized)
      const updatedUser: UserProfile = {
        ...existingUser,
        phoneNumber: normalizedPhone, // Ensure normalized format
        publicKey,
        pushToken: pushToken || null,
      };
      await redis.set(userKey, JSON.stringify(updatedUser));
      console.log(`[Server] Updated existing user: ${normalizedPhone} (userId: ${userId})`);
    } else {
      // Create new user
      userId = `user_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      const newUser: UserProfile = {
        id: userId,
        phoneNumber: normalizedPhone, // Store normalized phone number
        publicKey,
        pushToken: pushToken || null,
      };
      await redis.set(userKey, JSON.stringify(newUser));
      console.log(`[Server] Created new user: ${normalizedPhone} (userId: ${userId})`);
    }

    // Generate session token
    const token = generateSessionToken(userId);

    return { success: true, token, userId };
  } catch (error) {
    console.error('[Server] Error verifying OTP:', error);
    return reply.status(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to verify OTP',
    });
  }
});

// POST /contacts/sync
fastify.post('/contacts/sync', async (request, reply) => {
  try {
    const { phoneNumbers } = request.body as { phoneNumbers?: string[] };

    if (!phoneNumbers || !Array.isArray(phoneNumbers)) {
      return reply.status(400).send({ success: false, error: 'Invalid phone numbers array' });
    }

    // Validate all phone numbers are strings
    if (!phoneNumbers.every((num) => typeof num === 'string')) {
      return reply.status(400).send({ success: false, error: 'All phone numbers must be strings' });
    }

    const foundUsers: Array<{ phoneNumber: string; publicKey: string; userId: string }> = [];

    console.log(`[Server] Contact sync: Checking ${phoneNumbers.length} phone numbers`);

    // Loop through each phone number and check if user exists in Redis
    for (const phoneNumber of phoneNumbers) {
      const userKey = `user:${phoneNumber}`;
      const userDataStr = await redis.get(userKey);

      if (userDataStr) {
        try {
          const user: UserProfile = JSON.parse(userDataStr);
          // Only return users that match the provided numbers (privacy requirement)
          foundUsers.push({
            phoneNumber: user.phoneNumber,
            publicKey: user.publicKey,
            userId: user.id,
          });
          console.log(`[Server] Found user: ${user.phoneNumber} (userId: ${user.id})`);
        } catch (parseError) {
          // Skip invalid JSON entries
          console.error(`[Server] Error parsing user data for ${phoneNumber}:`, parseError);
        }
      } else {
        console.log(`[Server] User not found for phone number: ${phoneNumber}`);
      }
    }

    console.log(`[Server] Contact sync: Found ${foundUsers.length} users out of ${phoneNumbers.length} phone numbers`);
    return { success: true, users: foundUsers };
  } catch (error) {
    console.error('[Server] Error syncing contacts:', error);
    return reply.status(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to sync contacts',
    });
  }
});

// Set up Socket.io after Fastify is ready
fastify.ready(async () => {
  const io = fastify.io;

  // Socket.io connection handler
  io.on('connection', (socket: Socket) => {
    console.log(`[Server] Client connected: ${socket.id}`);

    // Identify: Verify token and map userId to socket ID, public key, and push token, join room
    socket.on('identify', async (payload: { token: string }) => {
      try {
        if (!payload || typeof payload !== 'object') {
          socket.emit('error', { message: 'Invalid payload' });
          return;
        }

        const { token } = payload;

        if (!token || typeof token !== 'string') {
          socket.emit('error', { message: 'Invalid token' });
          return;
        }

        // Verify token against Redis
        const user = await getUserByToken(token);

        if (!user) {
          socket.emit('error', { message: 'Invalid or expired token' });
          return;
        }

        // Map userId to socket info (socketId, publicKey, pushToken, userId, and presence)
        userSockets[user.id] = {
          socketId: socket.id,
          publicKey: user.publicKey,
          pushToken: user.pushToken,
          userId: user.id,
          presence: 'ONLINE_IDLE', // Initial presence state
        };
        
        // Join room with userId
        socket.join(user.id);
        
        console.log(`[Server] User identified: ${user.id} (phone: ${user.phoneNumber}, socket: ${socket.id}, pushToken: ${user.pushToken ? 'present' : 'none'}, presence: ONLINE_IDLE)`);
      } catch (error) {
        console.error('[Server] Error in identify:', error instanceof Error ? error.message : 'Unknown error');
        socket.emit('error', {
          message: error instanceof Error ? error.message : 'Failed to identify',
        });
      }
    });

    // Send message: New logic based on recipient presence
    socket.on('send_message', async (payload: { conversationId: string; messageId: string; cipherText: string; to: string }) => {
      try {
        const { conversationId, messageId, cipherText, to } = payload;

        if (!conversationId || !messageId || !cipherText || !to) {
          socket.emit('error', { message: 'Missing required fields: conversationId, messageId, cipherText, to' });
          return;
        }

        // Get sender userId from socket
        const senderId = Object.keys(userSockets).find(
          (key) => userSockets[key]?.socketId === socket.id
        );
        if (!senderId) {
          socket.emit('error', { message: 'Sender not identified' });
          return;
        }

        const recipientPresence = getUserPresence(to);
        const seq = getNextSequenceNumber(conversationId);

        // Decision-based delivery
        // 1. If recipient presence is IN_CHAT (and conversation IDs match): deliver directly via socket
        if (typeof recipientPresence === 'object' && recipientPresence.type === 'IN_CHAT' && recipientPresence.conversationId === conversationId) {
          const recipientInfo = userSockets[to];
          if (recipientInfo) {
            io.to(recipientInfo.socketId).emit('receive_message', {
              conversationId,
              messageId,
              cipherText,
              seq,
            });
            console.log(`[Server] Message delivered directly via socket to ${to} (IN_CHAT)`);
          }
        } else {
          // 2. If recipient presence is anything else (ONLINE_IDLE or OFFLINE): buffer in Redis
          const bufferKey = `buffer:${conversationId}`;

          // Store message with sequence number (JSON format)
          const bufferedMsg = JSON.stringify({ messageId, cipherText, seq });
          await redis.rpush(bufferKey, bufferedMsg);
          
          // Refresh expiration to MESSAGE_TTL on every push
          await redis.expire(bufferKey, MESSAGE_TTL);
          
          // Emit the message_sent ack to the sender
          socket.emit('message_sent', { messageId: payload.messageId, timestamp: Date.now() });

          // Handle notification based on presence state
          if (recipientPresence === 'ONLINE_IDLE') {
            // If they are ONLINE_IDLE, emit conversation_waiting
            const recipientInfo = userSockets[to];
            if (recipientInfo) {
              io.to(recipientInfo.socketId).emit('conversation_waiting', { conversationId });
              console.log(`[Server] conversation_waiting event emitted to ${to} (ONLINE_IDLE)`);
            }
          } else if (recipientPresence === 'OFFLINE') {
            // If they are OFFLINE, send the Push Notification
            const recipientInfo = userSockets[to];
            if (recipientInfo && recipientInfo.pushToken) {
              try {
                if (Expo.isExpoPushToken(recipientInfo.pushToken)) {
                  await expo.sendPushNotificationsAsync([
                    {
                      to: recipientInfo.pushToken,
                      sound: 'default',
                      title: 'Purple Box',
                      body: 'Someone wants to chat',
                      data: { conversationId },
                    },
                  ]);
                  console.log(`[Server] Push notification sent to: ${to} (OFFLINE)`);
                }
              } catch (error) {
                console.error(`[Server] Error sending push notification to ${to}:`, error instanceof Error ? error.message : 'Unknown error');
              }
            }
          }

          console.log(`[Server] Message buffered for conversation ${conversationId} (recipient: ${recipientPresence})`);
        }
      } catch (error) {
        console.error('[Server] Error sending message:', error instanceof Error ? error.message : 'Unknown error');
        socket.emit('error', {
          message: error instanceof Error ? error.message : 'Failed to send message',
        });
      }
    });

    // Get public key: Look up user's public key
    socket.on('get_public_key', (targetUserId: string, callback: (response: { success: boolean; publicKey?: string | null; error?: string }) => void) => {
      try {
        if (!targetUserId || typeof targetUserId !== 'string') {
          callback({ success: false, error: 'Invalid target user ID' });
          return;
        }

        // Look up the user in userSockets
        const userInfo = userSockets[targetUserId];

        if (!userInfo) {
          // User is offline - try to get from Redis
          getUserByToken(targetUserId)
            .then((user) => {
              if (user) {
                callback({ success: true, publicKey: user.publicKey });
              } else {
                callback({ success: true, publicKey: null });
              }
            })
            .catch(() => {
              callback({ success: true, publicKey: null });
            });
          return;
        }

        // Return the public key
        callback({ success: true, publicKey: userInfo.publicKey });

        console.log(`[Server] Public key requested for user: ${targetUserId}`);
      } catch (error) {
        console.error('[Server] Error getting public key:', error instanceof Error ? error.message : 'Unknown error');
        callback({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get public key',
        });
      }
    });

    // Get contacts: Return list of all connected user IDs
    socket.on('get_contacts', (callback: (response: { success: boolean; contacts?: string[]; error?: string }) => void) => {
      try {
        // Return all user IDs (keys of userSockets)
        const contacts = Object.keys(userSockets);
        
        callback({ success: true, contacts });
        
        console.log(`[Server] Contacts requested: ${contacts.length} users online`);
      } catch (error) {
        console.error('[Server] Error getting contacts:', error instanceof Error ? error.message : 'Unknown error');
        callback({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get contacts',
        });
      }
    });

    // Enter chat: Update presence to IN_CHAT, flush buffer for conversation
    socket.on('enter_chat', async (payload: { conversationId: string }, callback?: (response: { success: boolean; messages?: Array<{ messageId: string; cipherText: string; seq: number }>; error?: string }) => void) => {
      try {
        const { conversationId } = payload;
        if (!conversationId || typeof conversationId !== 'string') {
          if (callback) callback({ success: false, error: 'Invalid conversation ID' });
          return;
        }

        // Get userId from socket
        const userId = Object.keys(userSockets).find(
          (key) => userSockets[key]?.socketId === socket.id
        );
        if (!userId) {
          if (callback) callback({ success: false, error: 'User not identified' });
          return;
        }

        // Update presence to IN_CHAT
        if (userSockets[userId]) {
          userSockets[userId].presence = { type: 'IN_CHAT', conversationId };
        }

        // Flush buffer for this conversation
        const bufferKey = `buffer:${conversationId}`;
        const bufferedMessagesStr = await redis.lrange(bufferKey, 0, -1);
        
        // Delete buffer
        await redis.del(bufferKey);

        // Parse and return messages in order
        const messages = bufferedMessagesStr.map((msgStr) => {
          return JSON.parse(msgStr) as { messageId: string; cipherText: string; seq: number };
        });

        // Sort by sequence number
        messages.sort((a, b) => a.seq - b.seq);

        if (callback) {
          callback({ success: true, messages });
        }

        console.log(`[Server] User ${userId} entered chat ${conversationId}, flushed ${messages.length} buffered messages`);
      } catch (error) {
        console.error('[Server] Error entering chat:', error instanceof Error ? error.message : 'Unknown error');
        if (callback) {
          callback({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to enter chat',
          });
        }
      }
    });

    // Leave chat: Update presence back to ONLINE_IDLE
    socket.on('leave_chat', async (payload: { conversationId: string }) => {
      try {
        // Get userId from socket
        const userId = Object.keys(userSockets).find(
          (key) => userSockets[key]?.socketId === socket.id
        );
        if (!userId || !userSockets[userId]) {
          return;
        }

        // Update presence to ONLINE_IDLE
        userSockets[userId].presence = 'ONLINE_IDLE';

        console.log(`[Server] User ${userId} left chat`);
      } catch (error) {
        console.error('[Server] Error leaving chat:', error instanceof Error ? error.message : 'Unknown error');
      }
    });

    // Legacy fetch_inbox: Keep for backwards compatibility (deprecated)
    socket.on('fetch_inbox', async (userId: string, callback: (response: { success: boolean; messages?: Array<{ encryptedMessage: string; order: number }>; error?: string }) => void) => {
      try {
        if (!userId || typeof userId !== 'string') {
          callback({ success: false, error: 'Invalid user ID' });
          return;
        }

        const redisKey = `inbox:${userId}`;
        
        // Retrieve all messages from Redis list (LRANGE 0 -1 gets all items)
        const encryptedMessages = await redis.lrange(redisKey, 0, -1);

        if (!encryptedMessages || encryptedMessages.length === 0) {
          callback({ success: true, messages: [] });
          return;
        }

        // Immediately delete the inbox key (prevent re-reading)
        await redis.del(redisKey);

        // Legacy ordering - use conversation sequence if available, else use user counter
        // This is for backwards compatibility only
        const messagesWithOrder = encryptedMessages.map((encryptedMessage, index) => {
          return { encryptedMessage, order: index };
        });

        // Return array of messages with ordering tokens
        callback({ success: true, messages: messagesWithOrder });

        console.log(`[Server] Legacy inbox retrieved for user: ${userId} (${encryptedMessages.length} messages)`);
      } catch (error) {
        console.error('[Server] Error fetching inbox:', error instanceof Error ? error.message : 'Unknown error');
        callback({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to retrieve inbox',
        });
      }
    });

    // Disconnect: Clean up userSockets map and sequence counters
    socket.on('disconnect', () => {
      // Find and remove userId from userSockets map
      const userId = Object.keys(userSockets).find(
        (key) => userSockets[key]?.socketId === socket.id
      );

      if (userId && userSockets[userId]) {
        delete userSockets[userId];
        console.log(`[Server] User disconnected: ${userId} (socket: ${socket.id}), presence cleared`);
      } else {
        console.log(`[Server] Client disconnected: ${socket.id}`);
      }
    });
  });

  console.log('[Server] Socket.io initialized');
});

// Root endpoint
fastify.get('/', async () => {
  return {
    name: 'Purple Box API',
    version: '1.0.0',
    endpoints: {
      health: 'GET /health',
      requestOTP: 'POST /auth/request-otp',
      verifyOTP: 'POST /auth/verify-otp',
      syncContacts: 'POST /contacts/sync',
    },
  };
});

// Health check endpoint
fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// 404 handler for unmatched routes
fastify.setNotFoundHandler(async (request, reply) => {
  return reply.status(404).send({
    success: false,
    error: 'Route not found',
    path: request.url,
    method: request.method,
  });
});

// Start server
const port = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';

const start = async () => {
  try {
    await fastify.listen({ port, host: HOST });
    console.log(`Server is running on port ${port}`);
    console.log('[Server] Zero-persistence mode: All data is ephemeral');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
