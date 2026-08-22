// Wire schemas — mirrors ARCHITECTURE.md § Shared Schemas (server/src/types.d.ts is the other side).

export interface SendMessagePayload {
  roomId: string;
  messageId: string;
  cipherText: string;
}

export interface EnterChatPayload {
  roomId: string;
  nickname: string;
  publicKey: string;
  screenshotDetection: boolean; // [v4] deferred; always false in v1
}

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

export interface ErrorPayload {
  error: string;
}

// eslint-disable-next-line @typescript-eslint/ban-types
export type Ack<T = {}> = ({ success: true } & T) | { success: false; error: string };
