import type { Server } from 'socket.io';

declare module 'fastify' {
  interface FastifyInstance {
    io: Server;
  }
}

// Shared schemas — see ARCHITECTURE.md § Shared Schemas.

export type Presence = 'IN_CHAT' | 'DISCONNECTED';

export interface SlotState {
  socketId: string;
  nickname: string;
  publicKey: string;
  presence: Presence;
  screenshotDetection: boolean; // [v4]
}

export interface RoomState {
  roomId: string;
  createdAt: number;
  lastActivityAt: number;
  seq: number;
  slots: [SlotState | null, SlotState | null];
  everFilled: boolean;
}

export interface BufferedMessage {
  messageId: string;
  cipherText: string;
  seq: number;
}

// Client -> server payloads

export interface CreateRoomPayload {
  nickname: string;
  publicKey: string;
  screenshotDetection?: boolean;
}

export interface JoinRoomPayload {
  roomId: string;
}

export interface EnterChatPayload {
  roomId: string;
  nickname: string;
  publicKey: string;
  screenshotDetection?: boolean;
}

export interface SendMessagePayload {
  roomId: string;
  messageId: string;
  cipherText: string;
}

export interface LeaveChatPayload {
  roomId: string;
}

export interface GetPublicKeyPayload {
  roomId: string;
}

export interface ScreenshotTakenPayload {
  roomId: string;
}

// Server -> client payloads

export interface ReceiveMessagePayload {
  roomId: string;
  messageId: string;
  cipherText: string;
  seq: number;
}

export interface ChatStatePayload {
  roomId: string;
  peerPresent: boolean;
  peerNickname: string | null;
  peerPublicKey: string | null;
  screenshotAlertsActive: boolean;
}

export interface ConversationWaitingPayload {
  roomId: string;
  messageId: string;
}

export interface PeerLeftPayload {
  roomId: string;
}

export interface PeerReconnectingPayload {
  roomId: string;
  graceDeadline: number;
}

export interface PeerScreenshottedPayload {
  roomId: string;
  seq: number;
}

export interface ErrorPayload {
  error: string;
}

// eslint-disable-next-line @typescript-eslint/ban-types
export type Ack<T = {}> = ({ success: true } & T) | { success: false; error: string };

export type SlotIndex = 0 | 1;
