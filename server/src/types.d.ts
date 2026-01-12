import { Server as SocketIOServer } from 'socket.io';
import { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    io: SocketIOServer;
  }
}
