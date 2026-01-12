import { createClient, RedisClientType } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';

const REDIS_TTL_SECONDS = 60;

/**
 * Creates a Redis client configured for ephemeral storage with 60s TTL
 * All keys automatically expire after 60 seconds
 */
export async function createRedisClient() {
  const client = createClient({
    socket: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
    },
    // Ephemeral mode - no persistence
    disableOfflineQueue: false,
  }) as RedisClientType;

  const subscriber = client.duplicate() as RedisClientType;

  await Promise.all([
    client.connect(),
    subscriber.connect(),
  ]);

  return { client, subscriber };
}

/**
 * Creates a Redis adapter for Socket.io
 */
export async function createRedisAdapter() {
  const { client, subscriber } = await createRedisClient();
  return createAdapter(client, subscriber);
}

/**
 * Stores a message in Redis with 60s TTL
 * Key format: user:{username}:message
 * Stores both encrypted payload and sender public key (JSON format)
 */
export async function storeMessage(
  redisClient: RedisClientType,
  username: string,
  encryptedPayload: string,
  senderPublicKey?: string
): Promise<void> {
  const key = `user:${username}:message`;
  const messageData = JSON.stringify({
    encryptedPayload,
    senderPublicKey: senderPublicKey || null,
  });
  await redisClient.setEx(key, REDIS_TTL_SECONDS, messageData);
}

/**
 * Retrieves and deletes a message from Redis
 * Returns parsed message data with encryptedPayload and senderPublicKey
 */
export async function retrieveMessage(
  redisClient: RedisClientType,
  username: string
): Promise<{ encryptedPayload: string; senderPublicKey: string | null } | null> {
  const key = `user:${username}:message`;
  const value = await redisClient.get(key);
  if (value) {
    await redisClient.del(key);
    try {
      return JSON.parse(value);
    } catch {
      // Legacy format: just encrypted payload
      return { encryptedPayload: value, senderPublicKey: null };
    }
  }
  return null;
}
