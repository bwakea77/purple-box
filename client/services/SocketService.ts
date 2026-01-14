import { io, Socket } from 'socket.io-client';
import { log } from '../utils/logger';

const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL || 'https://purple-box.onrender.com';

/**
 * Socket.io service for managing connection to the server
 */
class SocketService {
  private socket: Socket | null = null;
  private username: string | null = null;

  /**
   * Connect to the server and join user room
   */
  connect(username: string): Socket {
    if (this.socket?.connected) {
      return this.socket;
    }

    this.username = username;
    this.socket = io(SERVER_URL, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      enableOfflineQueue: true,
    } as any);

    // Join user room on connection
    this.socket.on('connect', () => {
      log.info('[SocketService] connected');
      this.socket?.emit('join', username);
    });

    this.socket.on('disconnect', () => {
      log.info('[SocketService] disconnected');
    });

    this.socket.on('connect_error', (error) => {
      log.error('[SocketService] connection error', error);
    });

    return this.socket;
  }

  /**
   * Disconnect from the server
   */
  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.username = null;
    }
  }

  /**
   * Get the current socket instance
   */
  getSocket(): Socket | null {
    return this.socket;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }
}

export const socketService = new SocketService();
