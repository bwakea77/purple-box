import type { Server as SocketIOServer } from 'socket.io';
import type { RedisClientType } from 'redis';
interface MessagePayload {
    recipient: string;
    encryptedPayload: string;
    senderPublicKey?: string;
}
/**
 * Handles incoming encrypted messages
 * - Validates the payload structure
 * - Stores message in Redis with recipient's username as key
 * - Emits 'box_full' event to the recipient
 * - NEVER logs the message payload
 */
export declare function handleMessage(io: SocketIOServer, redisClient: RedisClientType, payload: MessagePayload): Promise<void>;
export {};
//# sourceMappingURL=messageHandler.d.ts.map