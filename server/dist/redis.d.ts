import type { RedisClientType } from 'redis';
/**
 * Creates a Redis client configured for ephemeral storage with 60s TTL
 * All keys automatically expire after 60 seconds
 */
export declare function createRedisClient(): Promise<{
    client: RedisClientType;
    subscriber: RedisClientType;
}>;
/**
 * Creates a Redis adapter for Socket.io
 */
export declare function createRedisAdapter(): Promise<(nsp: any) => import("@socket.io/redis-adapter").RedisAdapter>;
/**
 * Stores a message in Redis with 60s TTL
 * Key format: user:{username}:message
 * Stores both encrypted payload and sender public key (JSON format)
 */
export declare function storeMessage(redisClient: RedisClientType, username: string, encryptedPayload: string, senderPublicKey?: string): Promise<void>;
/**
 * Retrieves and deletes a message from Redis
 * Returns parsed message data with encryptedPayload and senderPublicKey
 */
export declare function retrieveMessage(redisClient: RedisClientType, username: string): Promise<{
    encryptedPayload: string;
    senderPublicKey: string | null;
} | null>;
//# sourceMappingURL=redis.d.ts.map