import Fastify from 'fastify';
import type { Server as SocketIOServer } from 'socket.io';
import fastifySocketIO from 'fastify-socket.io';
import { createRedisClient, createRedisAdapter } from './redis.js';
import { handleMessage } from './messageHandler.js';
import type { RedisClientType } from 'redis';

const fastify = Fastify({
  logger: {
    level: 'info',
    // Ensure no sensitive data is logged
    redact: ['payload', 'encryptedPayload', 'message', 'data'],
  },
});

// Initialize Redis
let redisClient: RedisClientType;
let io: SocketIOServer;

// Register Socket.io plugin
fastify.register(fastifySocketIO as any, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST'],
  },
});

// Set up Socket.io after Fastify is ready
fastify.ready(async () => {
  io = fastify.io;

  // Create Redis client for message storage
  const redis = await createRedisClient();
  redisClient = redis.client;

  // Set up Redis adapter for Socket.io (creates its own clients)
  const adapter = await createRedisAdapter();
  io.adapter(adapter);

  // Socket.io connection handling
  io.on('connection', (socket) => {
    console.log(`[Socket] Client connected: ${socket.id}`);

    // Join user room when authenticated
    socket.on('join', (username: string) => {
      if (username && typeof username === 'string') {
        socket.join(`user:${username}`);
        console.log(`[Socket] User ${username} joined room: user:${username}`);
      }
    });

    // Handle incoming messages
    socket.on('message', async (payload: { recipient: string; encryptedPayload: string; senderPublicKey?: string }) => {
      try {
        await handleMessage(io, redisClient, payload);
        socket.emit('message:ack', { status: 'success' });
      } catch (error) {
        // Log error without payload
        console.error('[Socket] Error handling message:', error instanceof Error ? error.message : 'Unknown error');
        socket.emit('message:ack', { 
          status: 'error', 
          error: error instanceof Error ? error.message : 'Unknown error' 
        });
      }
    });

    // Handle message fetch request
    socket.on('fetch_message', async (payload: { username: string }, callback) => {
      try {
        const { retrieveMessage } = await import('./redis.js');
        const messageData = await retrieveMessage(redisClient, payload.username);
        
        if (messageData) {
          callback({
            success: true,
            encryptedPayload: messageData.encryptedPayload,
            senderPublicKey: messageData.senderPublicKey,
          });
          console.log(`[Socket] Message fetched for user: ${payload.username}`);
        } else {
          callback({
            success: false,
            error: 'No message found',
          });
        }
      } catch (error) {
        console.error('[Socket] Error fetching message:', error instanceof Error ? error.message : 'Unknown error');
        callback({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // Handle message destroy request
    socket.on('destroy_message', async (payload: { username: string }) => {
      try {
        const { retrieveMessage } = await import('./redis.js');
        await retrieveMessage(redisClient, payload.username); // This deletes the message
        console.log(`[Socket] Message destroyed for user: ${payload.username}`);
      } catch (error) {
        console.error('[Socket] Error destroying message:', error instanceof Error ? error.message : 'Unknown error');
      }
    });

    socket.on('disconnect', () => {
      console.log(`[Socket] Client disconnected: ${socket.id}`);
    });
  });

  console.log('[Server] Socket.io initialized with Redis adapter');
});

// Health check endpoint
fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// Start server
const start = async () => {
  try {
    const port = parseInt(process.env.PORT || '3000');
    const host = process.env.HOST || '0.0.0.0';
    
    await fastify.listen({ port, host });
    console.log(`[Server] Fastify server listening on ${host}:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
