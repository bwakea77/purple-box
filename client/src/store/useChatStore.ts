import { create } from 'zustand';
import type nacl from 'tweetnacl';

export type PeerPresence = 'PEER_IN_CHAT' | 'PEER_RECONNECTING' | 'PEER_LEFT';
export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'failed';

export interface ChatMessage {
  messageId: string;
  text: string;
  sender: 'me' | 'peer' | 'system';
  seq: number;
  status: MessageStatus;
  timestamp: number;
}

// RAM only — never persisted to localStorage/sessionStorage/IndexedDB.
// Everything here must be wiped by `wipeAndReset` on leave.
interface ChatState {
  roomId: string | null;
  nickname: string;
  peerPresence: PeerPresence;
  /** True once the peer has occupied the room at least once — distinguishes
   * the Waiting screen (nobody has ever joined) from the Chat screen's own
   * PEER_LEFT/PEER_RECONNECTING states (someone joined, then something changed). */
  peerHasJoined: boolean;
  peerNickname: string | null;
  reconnectDeadline: number | null;
  keyPair: nacl.BoxKeyPair | null;
  peerPublicKey: string | null;
  messages: ChatMessage[];
  /** True once this client's own socket has exhausted its 60s reconnect
   * budget (room-client_spec.md § Reconnect behaviour) — distinct from the
   * peer's own presence, which PeerPresence already covers. */
  connectionLost: boolean;
  lastError: string | null;

  setNickname: (nickname: string) => void;
  enterRoom: (params: { roomId: string; keyPair: nacl.BoxKeyPair }) => void;
  setPeerPresence: (presence: PeerPresence, reconnectDeadline?: number | null) => void;
  setPeerInfo: (nickname: string | null, publicKey: string | null) => void;
  addMessage: (message: ChatMessage) => void;
  updateMessageStatus: (messageId: string, status: MessageStatus, seq?: number) => void;
  markFailed: (messageId: string) => void;
  setConnectionLost: (lost: boolean) => void;
  setLastError: (error: string | null) => void;
  wipeAndReset: () => void;
}

const initial = {
  roomId: null as string | null,
  nickname: '',
  peerPresence: 'PEER_IN_CHAT' as PeerPresence,
  peerHasJoined: false,
  peerNickname: null as string | null,
  reconnectDeadline: null as number | null,
  keyPair: null as nacl.BoxKeyPair | null,
  peerPublicKey: null as string | null,
  messages: [] as ChatMessage[],
  connectionLost: false,
  lastError: null as string | null,
};

export const useChatStore = create<ChatState>((set) => ({
  ...initial,

  setNickname: (nickname) => set({ nickname }),

  enterRoom: ({ roomId, keyPair }) => set({ roomId, keyPair, peerPresence: 'PEER_IN_CHAT' }),

  setPeerPresence: (peerPresence, reconnectDeadline = null) =>
    set((s) => ({
      peerPresence,
      reconnectDeadline,
      peerHasJoined: s.peerHasJoined || peerPresence === 'PEER_IN_CHAT',
    })),

  setPeerInfo: (peerNickname, peerPublicKey) => set({ peerNickname, peerPublicKey }),

  addMessage: (message) => set((s) => ({ messages: [...s.messages, message].sort((a, b) => a.seq - b.seq) })),

  updateMessageStatus: (messageId, status, seq) =>
    set((s) => ({
      messages: s.messages
        .map((m) => (m.messageId === messageId ? { ...m, status, seq: seq ?? m.seq } : m))
        .sort((a, b) => a.seq - b.seq),
    })),

  markFailed: (messageId) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.messageId === messageId ? { ...m, status: 'failed' as const } : m)),
    })),

  setConnectionLost: (connectionLost) => set({ connectionLost }),
  setLastError: (lastError) => set({ lastError }),

  wipeAndReset: () =>
    set({
      roomId: null,
      nickname: '',
      peerPresence: 'PEER_IN_CHAT',
      peerHasJoined: false,
      peerNickname: null,
      reconnectDeadline: null,
      keyPair: null,
      peerPublicKey: null,
      messages: [],
      connectionLost: false,
      lastError: null,
    }),
}));
