import { io, type Socket } from 'socket.io-client';
import { useChatStore } from '../store/useChatStore';
import * as Crypto from './CryptoService';
import type {
  Ack,
  ChatStatePayload,
  EnterChatPayload,
  ErrorPayload,
  PeerReconnectingPayload,
  ReceiveMessagePayload,
} from '../types';

// Undefined tells socket.io-client to connect to the page's own origin.
// That's deliberate: the client and server run on different ports, but only
// one origin needs to be reachable through a tunnel/proxy this way — Vite's
// dev proxy (see vite.config.ts) and nginx.conf both forward /socket.io to
// the real server. Set VITE_SERVER_URL to override (e.g. a split deployment).
const SERVER_URL = import.meta.env.VITE_SERVER_URL as string | undefined;
const ACK_TIMEOUT_MS = 8_000;

// Reconnect schedule per room-client_spec.md § Reconnect behaviour.
const BACKOFF_SCHEDULE_MS = [500, 1000, 2000, 4000, 8000];
const RECONNECT_BUDGET_MS = 60_000;

function jitter(ms: number): number {
  const delta = ms * 0.2;
  return Math.round(ms + (Math.random() * 2 - 1) * delta);
}

type Unsubscribe = () => void;

let socket: Socket | null = null;
let hasConnectedOnce = false;
let disconnectedAt: number | null = null;
let attemptIndex = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function clearReconnectTimer(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function scheduleReconnect(): void {
  if (!socket) return;
  if (disconnectedAt === null) disconnectedAt = Date.now();
  const elapsed = Date.now() - disconnectedAt;
  if (elapsed >= RECONNECT_BUDGET_MS) {
    giveUp();
    return;
  }
  const base = BACKOFF_SCHEDULE_MS[Math.min(attemptIndex, BACKOFF_SCHEDULE_MS.length - 1)]!;
  attemptIndex++;
  clearReconnectTimer();
  reconnectTimer = setTimeout(() => socket?.connect(), jitter(base));
}

function giveUp(): void {
  clearReconnectTimer();
  useChatStore.getState().setConnectionLost(true);
}

function emitAck<T = Record<string, unknown>>(event: string, payload: unknown): Promise<Ack<T>> {
  return new Promise((resolve, reject) => {
    if (!socket || !socket.connected) {
      reject(new Error('not connected'));
      return;
    }
    const timeout = setTimeout(() => reject(new Error('timed out, please try again')), ACK_TIMEOUT_MS);
    socket.emit(event, payload, (res: Ack<T>) => {
      clearTimeout(timeout);
      resolve(res);
    });
  });
}

async function resumeAfterReconnect(): Promise<void> {
  const { roomId, nickname, keyPair } = useChatStore.getState();
  if (!roomId || !keyPair) return;
  const payload: EnterChatPayload = {
    roomId,
    nickname,
    publicKey: Crypto.publicKeyToBase64(keyPair),
    screenshotDetection: false,
  };
  try {
    const ack = await emitAck<{ chatState: ChatStatePayload }>('enter_chat', payload);
    if (!ack.success) {
      giveUp();
      return;
    }
    applyChatState(ack.chatState);
    useChatStore.getState().setConnectionLost(false);
    disconnectedAt = null;
    attemptIndex = 0;
  } catch {
    scheduleReconnect();
  }
}

function applyChatState(state: ChatStatePayload): void {
  useChatStore.getState().setPeerInfo(state.peerNickname, state.peerPublicKey);
  if (state.peerPresent) {
    useChatStore.getState().setPeerPresence('PEER_IN_CHAT');
  }
}

export function connectSocket(): void {
  if (socket) return;
  socket = io(SERVER_URL, { transports: ['websocket'], reconnection: false });

  socket.on('connect', () => {
    if (hasConnectedOnce) {
      void resumeAfterReconnect();
    }
    hasConnectedOnce = true;
  });

  socket.on('disconnect', (reason) => {
    if (reason === 'io client disconnect') return; // we disconnected on purpose (leave)
    if (useChatStore.getState().roomId) {
      useChatStore.getState().setPeerPresence('PEER_RECONNECTING', Date.now() + RECONNECT_BUDGET_MS);
      scheduleReconnect();
    }
  });

  socket.on('connect_error', () => {
    if (useChatStore.getState().roomId) scheduleReconnect();
  });

  socket.on('server_restarting', () => {
    // Reconnect immediately rather than waiting for the transport to drop.
    socket?.disconnect();
    socket?.connect();
  });

  socket.on('chat_state', (payload: ChatStatePayload) => applyChatState(payload));

  socket.on('receive_message', (payload: ReceiveMessagePayload) => {
    const { keyPair } = useChatStore.getState();
    if (!keyPair) return;
    const decrypted = Crypto.decryptMessage(payload.cipherText, keyPair);
    if (!decrypted) return; // tampered or undecryptable — never surface ciphertext
    useChatStore.getState().addMessage({
      messageId: payload.messageId,
      text: decrypted.plaintext,
      sender: 'peer',
      seq: payload.seq,
      status: 'delivered',
      timestamp: Date.now(),
    });
  });

  socket.on('peer_left', () => {
    useChatStore.getState().setPeerPresence('PEER_LEFT');
  });

  socket.on('peer_reconnecting', (payload: PeerReconnectingPayload) => {
    useChatStore.getState().setPeerPresence('PEER_RECONNECTING', payload.graceDeadline);
  });

  socket.on('error', (payload: ErrorPayload) => {
    useChatStore.getState().setLastError(payload.error);
  });
}

export function isConnected(): boolean {
  return !!socket?.connected;
}

export async function createRoom(nickname: string): Promise<string> {
  connectSocket();
  await waitConnected();
  const keyPair = Crypto.generateKeyPair();
  const publicKey = Crypto.publicKeyToBase64(keyPair);
  const createAck = await emitAck<{ roomId: string }>('create_room', { nickname, publicKey });
  if (!createAck.success) throw new Error(createAck.error);
  const { roomId } = createAck;
  useChatStore.getState().enterRoom({ roomId, keyPair });
  useChatStore.getState().setNickname(nickname);

  const enterPayload: EnterChatPayload = { roomId, nickname, publicKey, screenshotDetection: false };
  const enterAck = await emitAck<{ chatState: ChatStatePayload }>('enter_chat', enterPayload);
  if (!enterAck.success) throw new Error(enterAck.error);
  applyChatState(enterAck.chatState);
  return roomId;
}

export async function joinRoom(roomId: string, nickname: string): Promise<void> {
  connectSocket();
  await waitConnected();
  const keyPair = Crypto.generateKeyPair();
  const publicKey = Crypto.publicKeyToBase64(keyPair);
  const joinAck = await emitAck('join_room', { roomId, nickname, publicKey });
  if (!joinAck.success) throw new Error(joinAck.error);
  useChatStore.getState().enterRoom({ roomId, keyPair });
  useChatStore.getState().setNickname(nickname);

  const enterPayload: EnterChatPayload = { roomId, nickname, publicKey, screenshotDetection: false };
  const enterAck = await emitAck<{ chatState: ChatStatePayload }>('enter_chat', enterPayload);
  if (!enterAck.success) throw new Error(enterAck.error);
  applyChatState(enterAck.chatState);
}

function waitConnected(): Promise<void> {
  if (socket?.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (!socket) {
      reject(new Error('could not reach the server'));
      return;
    }
    const timeout = setTimeout(() => {
      socket?.off('connect', onConnect);
      reject(new Error('could not reach the server'));
    }, ACK_TIMEOUT_MS);
    function onConnect(): void {
      clearTimeout(timeout);
      resolve();
    }
    socket.once('connect', onConnect);
  });
}

async function deliver(messageId: string, plaintext: string): Promise<void> {
  const { roomId, peerPublicKey, keyPair } = useChatStore.getState();
  if (!roomId || !peerPublicKey || !keyPair) {
    useChatStore.getState().markFailed(messageId);
    return;
  }
  const cipherText = Crypto.encryptMessage(plaintext, peerPublicKey, keyPair);
  if (cipherText.length > Crypto.MAX_CIPHERTEXT_B64_LENGTH) {
    useChatStore.getState().markFailed(messageId);
    throw new Error('message too large');
  }
  try {
    const ack = await emitAck<{ delivered: boolean; seq: number }>('send_message', {
      roomId,
      messageId,
      cipherText,
    });
    if (!ack.success) {
      useChatStore.getState().markFailed(messageId);
      return;
    }
    useChatStore.getState().updateMessageStatus(messageId, ack.delivered ? 'delivered' : 'sent', ack.seq);
  } catch {
    useChatStore.getState().markFailed(messageId);
  }
}

// crypto.randomUUID() only exists in secure contexts (https:// or localhost);
// a plain-http deployment on a raw IP/hostname has it undefined, which broke
// every send at the first line before the message ever reached the store.
// messageId is just a client-side correlation id, not security-sensitive, so
// a Math.random-based fallback is fine here.
function generateMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export async function sendMessage(plaintext: string): Promise<void> {
  const messageId = generateMessageId();
  useChatStore.getState().addMessage({
    messageId,
    text: plaintext,
    sender: 'me',
    seq: Number.MAX_SAFE_INTEGER, // provisional — resorted once the server assigns a real seq
    status: 'pending',
    timestamp: Date.now(),
  });
  await deliver(messageId, plaintext);
}

export function retryMessage(messageId: string): void {
  const message = useChatStore.getState().messages.find((m) => m.messageId === messageId);
  if (!message) return;
  useChatStore.getState().updateMessageStatus(messageId, 'pending');
  void deliver(messageId, message.text);
}

export function leaveChat(): void {
  const { roomId } = useChatStore.getState();
  if (roomId && socket?.connected) {
    socket.emit('leave_chat', { roomId });
  }
}

export function disconnectSocket(): void {
  clearReconnectTimer();
  hasConnectedOnce = false;
  disconnectedAt = null;
  attemptIndex = 0;
  socket?.disconnect();
  socket = null;
}

export type { Unsubscribe };
