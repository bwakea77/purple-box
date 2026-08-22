import Fastify, { type FastifyInstance } from 'fastify';
import fastifySocketIO from 'fastify-socket.io';
import type { Socket } from 'socket.io';
import * as db from './redis.js';
import { RoomManager } from './rooms.js';
import {
  checkRoomCreation,
  circuitBreakerTripped,
  issuePowChallenge,
  recordRoomCreated,
  verifyPowSolution,
} from './rateLimit.js';
import type { Ack, EnterChatPayload, SendMessagePayload } from './types.js';

function clientIp(socket: Socket): string {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]!.trim();
  }
  return socket.handshake.address;
}

export interface BuiltServer {
  app: FastifyInstance;
  rooms: RoomManager;
}

export async function buildServer(corsOrigin = '*'): Promise<BuiltServer> {
  const app = Fastify({ logger: false });

  await app.register(fastifySocketIO, {
    cors: { origin: corsOrigin },
    transports: ['websocket', 'polling'],
  });

  app.get('/health', async (_req, reply) => {
    const redisReachable = await db.isReachable();
    reply.send({ process: 'ok', redis: redisReachable ? 'ok' : 'unreachable' });
  });

  await app.ready();

  const io = app.io;
  const rooms = new RoomManager(io);

  io.on('connection', (socket: Socket) => {
    socket.on(
      'create_room',
      (
        payload: { nickname: string; publicKey: string; pow?: { challenge: string; nonce: string } },
        ack: (res: Ack<{ roomId: string }>) => void,
      ) => {
        void (async () => {
          if (circuitBreakerTripped()) {
            ack({ success: false, error: 'at capacity, try again in a moment' });
            return;
          }
          const ip = clientIp(socket);
          const limit = checkRoomCreation(ip);
          if (!limit.allowed) {
            ack({ success: false, error: 'rate limited, try again later' });
            return;
          }
          if (limit.requirePow) {
            if (!payload.pow) {
              const { challenge, difficulty } = issuePowChallenge(ip);
              ack({ success: false, error: `pow_required:${challenge}:${difficulty}` });
              return;
            }
            if (!verifyPowSolution(ip, payload.pow.challenge, payload.pow.nonce)) {
              ack({ success: false, error: 'pow_invalid' });
              return;
            }
          }
          recordRoomCreated(ip);
          await rooms.createRoom(socket, payload, ack);
        })();
      },
    );

    socket.on(
      'join_room',
      (payload: { roomId: string; nickname: string; publicKey: string }, ack: (res: Ack) => void) => {
        void rooms.joinRoom(socket, payload, ack);
      },
    );

    socket.on(
      'enter_chat',
      (payload: EnterChatPayload, ack: (res: Ack<{ chatState: unknown }>) => void) => {
        void rooms.enterChat(socket, payload, ack as never);
      },
    );

    socket.on(
      'send_message',
      (payload: SendMessagePayload, ack: (res: Ack<{ delivered: boolean; seq: number }>) => void) => {
        void rooms.sendMessage(socket, payload, ack);
      },
    );

    socket.on('leave_chat', (payload: { roomId: string }) => {
      void rooms.leaveChat(socket, payload);
    });

    socket.on(
      'get_public_key',
      (payload: { roomId: string }, ack: (res: Ack<{ publicKey: string | null }>) => void) => {
        void rooms.getPublicKey(socket, payload, ack);
      },
    );

    socket.on('disconnect', () => {
      void rooms.handleDisconnect(socket);
    });
  });

  return { app, rooms };
}
