import type { Server as SocketIOServer } from 'socket.io';
import type { RedisClientType } from 'redis';
import { storeMessage } from './redis.js';

interface MessagePayload {
  recipient: string;
  encryptedPayload: string;
  senderPublicKey?: string; // Optional: sender's public key for decryption
}

/**
 * Handles incoming encrypted messages
 * - Validates the payload structure
 * - Stores message in Redis with recipient's username as key
 * - Emits 'box_full' event to the recipient
 * - NEVER logs the message payload
 */
export async function handleMessage(
  io: SocketIOServer,
  redisClient: RedisClientType,
  payload: MessagePayload
): Promise<void> {
  // Validate payload structure
  if (!payload.recipient || !payload.encryptedPayload) {
    throw new Error('Invalid message payload: missing recipient or encryptedPayload');
  }

  const { recipient, encryptedPayload, senderPublicKey } = payload;

  // Store encrypted payload and sender public key in Redis with 60s TTL
  // Key format: user:{username}:message
  await storeMessage(redisClient, recipient, encryptedPayload, senderPublicKey);

  // Emit 'box_full' event to the recipient
  // This will be received by all sockets connected to the recipient's room
  io.to(`user:${recipient}`).emit('box_full');

  // Log only metadata - NEVER the payload
  console.log(`[MessageHandler] Message stored for recipient: ${recipient}`);
  console.log(`[MessageHandler] box_full event emitted to user:${recipient}`);
}
