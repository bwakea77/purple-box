import type { Server, Socket } from 'socket.io';
import * as db from './redis.js';
import { checkMessageRate, clearSocketRateState } from './rateLimit.js';
import type {
  Ack,
  ChatStatePayload,
  EnterChatPayload,
  RoomState,
  SendMessagePayload,
  SlotIndex,
  SlotState,
} from './types.js';

// --- Normative limits & timers, see ARCHITECTURE.md § Limits & Timers ------
// Overridable via env for integration tests only — production defaults are
// exactly the spec's normative values.
const WAITING_FOR_PEER_MS = Number(process.env.WAITING_FOR_PEER_MS ?? 10 * 60 * 1000);
const IDLE_WARN_MS = Number(process.env.IDLE_WARN_MS ?? 25 * 60 * 1000);
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS ?? 30 * 60 * 1000);
const HARD_CAP_WARN_MS = Number(process.env.HARD_CAP_WARN_MS ?? (4 * 60 - 5) * 60 * 1000);
const HARD_CAP_MS = Number(process.env.HARD_CAP_MS ?? 4 * 60 * 60 * 1000);
const GRACE_MS = Number(process.env.GRACE_MS ?? 60 * 1000);
const MAX_CIPHERTEXT_B64_LEN = Math.ceil((4 * 1024 * 4) / 3); // 4 KB of binary as base64
// Keeps the Redis-side room key alive (its own TTL is a 5-min backstop, see
// redis.ts) for as long as an in-process timer still considers the room
// live — without this, an idle-but-open chat (no messages, just presence)
// would get garbage collected by Redis well before our own 30-min/4h timers
// ever fire.
const KEEP_ALIVE_INTERVAL_MS = Number(process.env.KEEP_ALIVE_INTERVAL_MS ?? 60 * 1000);

interface RoomTimers {
  waiting?: NodeJS.Timeout;
  idleWarn?: NodeJS.Timeout;
  idle?: NodeJS.Timeout;
  hardCapWarn?: NodeJS.Timeout;
  hardCap?: NodeJS.Timeout;
  keepAlive?: NodeJS.Timeout;
  grace: Map<SlotIndex, NodeJS.Timeout>;
}

interface SocketLocation {
  roomId: string;
  slot: SlotIndex;
}

export class RoomManager {
  private readonly io: Server;
  private readonly timers = new Map<string, RoomTimers>();
  // In-process index only — a write-through convenience, never authoritative
  // (see ARCHITECTURE.md "Statelessness"). Redis remains the source of truth.
  private readonly socketLocations = new Map<string, SocketLocation>();

  constructor(io: Server) {
    this.io = io;
  }

  private timersFor(roomId: string): RoomTimers {
    let t = this.timers.get(roomId);
    if (!t) {
      t = { grace: new Map() };
      this.timers.set(roomId, t);
    }
    return t;
  }

  private otherSlot(slot: SlotIndex): SlotIndex {
    return slot === 0 ? 1 : 0;
  }

  private buildChatState(room: RoomState, viewingSlot: SlotIndex): ChatStatePayload {
    const peer = room.slots[this.otherSlot(viewingSlot)];
    return {
      roomId: room.roomId,
      peerPresent: !!peer && peer.presence === 'IN_CHAT',
      peerNickname: peer?.nickname ?? null,
      peerPublicKey: peer?.publicKey ?? null,
      screenshotAlertsActive: false, // capture detection is [v4], deferred
    };
  }

  private async pushChatState(roomId: string, slot: SlotIndex): Promise<void> {
    const room = await db.getRoom(roomId);
    if (!room) return;
    const target = room.slots[slot];
    if (!target) return;
    this.io.to(target.socketId).emit('chat_state', this.buildChatState(room, slot));
  }

  private log(event: string, roomId: string): void {
    // Never log message content — event name + roomId + timestamp only.
    console.log(JSON.stringify({ event, roomId, at: Date.now() }));
  }

  // -------------------------------------------------------------------------
  // Room lifecycle timers
  // -------------------------------------------------------------------------

  private startRoomTimers(roomId: string): void {
    const t = this.timersFor(roomId);
    t.waiting = setTimeout(() => void this.onWaitingTimeout(roomId), WAITING_FOR_PEER_MS).unref();
    t.hardCapWarn = setTimeout(() => void this.onHardCapWarn(roomId), HARD_CAP_WARN_MS).unref();
    t.hardCap = setTimeout(() => void this.onHardCap(roomId), HARD_CAP_MS).unref();
    t.keepAlive = setInterval(() => void db.touchRoomTTL(roomId), KEEP_ALIVE_INTERVAL_MS).unref();
    this.resetIdleTimers(roomId);
  }

  private resetIdleTimers(roomId: string): void {
    const t = this.timersFor(roomId);
    if (t.idleWarn) clearTimeout(t.idleWarn);
    if (t.idle) clearTimeout(t.idle);
    t.idleWarn = setTimeout(() => this.io.to(roomId).emit('error', { error: 'idle timeout warning: room closes in 5 minutes' }), IDLE_WARN_MS).unref();
    t.idle = setTimeout(() => void this.onIdleTimeout(roomId), IDLE_TIMEOUT_MS).unref();
  }

  private clearRoomTimers(roomId: string): void {
    const t = this.timers.get(roomId);
    if (!t) return;
    clearTimeout(t.waiting);
    clearTimeout(t.idleWarn);
    clearTimeout(t.idle);
    clearTimeout(t.hardCapWarn);
    clearTimeout(t.hardCap);
    if (t.keepAlive) clearInterval(t.keepAlive);
    for (const g of t.grace.values()) clearTimeout(g);
    this.timers.delete(roomId);
  }

  private async onWaitingTimeout(roomId: string): Promise<void> {
    const room = await db.getRoom(roomId);
    if (!room || room.everFilled) return; // peer joined in time; nothing to do
    const stillWaiting = room.slots.some((s) => s !== null);
    if (!stillWaiting) return;
    this.io.to(roomId).emit('error', { error: 'no one joined, room closed' });
    await this.teardown(roomId);
  }

  private async onIdleTimeout(roomId: string): Promise<void> {
    this.io.to(roomId).emit('error', { error: 'idle timeout, room closed' });
    await this.teardown(roomId);
  }

  private async onHardCapWarn(roomId: string): Promise<void> {
    this.io.to(roomId).emit('error', { error: 'session limit warning: room closes in 5 minutes' });
  }

  private async onHardCap(roomId: string): Promise<void> {
    this.io.to(roomId).emit('error', { error: 'session limit reached, room closed' });
    await this.teardown(roomId);
  }

  /** Idempotent — safe to call twice (e.g. hard cap firing after idle already tore it down). */
  private async teardown(roomId: string): Promise<void> {
    this.clearRoomTimers(roomId);
    for (const [socketId, loc] of this.socketLocations) {
      if (loc.roomId === roomId) this.socketLocations.delete(socketId);
    }
    const sockets = await this.io.in(roomId).fetchSockets();
    for (const s of sockets) s.leave(roomId);
    await db.deleteRoom(roomId);
    this.log('room_teardown', roomId);
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  async createRoom(
    socket: Socket,
    payload: { nickname: string; publicKey: string },
    ack: (res: Ack<{ roomId: string }>) => void,
  ): Promise<void> {
    const roomId = await db.createRoom();
    const slotState: SlotState = {
      socketId: socket.id,
      nickname: payload.nickname,
      publicKey: payload.publicKey,
      presence: 'IN_CHAT',
      screenshotDetection: false,
    };
    const result = await db.occupySlot(roomId, 0, slotState);
    if (!result.ok) {
      ack({ success: false, error: 'failed to create room' });
      return;
    }
    socket.join(roomId);
    this.socketLocations.set(socket.id, { roomId, slot: 0 });
    this.startRoomTimers(roomId);
    this.log('create_room', roomId);
    ack({ success: true, roomId });
  }

  async joinRoom(
    socket: Socket,
    payload: { roomId: string; nickname: string; publicKey: string },
    ack: (res: Ack) => void,
  ): Promise<void> {
    const { roomId } = payload;
    const room = await db.getRoom(roomId);
    if (!room) {
      ack({ success: false, error: 'room not found' });
      return;
    }
    if (room.everFilled) {
      ack({ success: false, error: 'room closed' });
      return;
    }
    const targetSlot: SlotIndex | null = room.slots[0] === null ? 0 : room.slots[1] === null ? 1 : null;
    if (targetSlot === null) {
      ack({ success: false, error: 'room full' });
      return;
    }
    const slotState: SlotState = {
      socketId: socket.id,
      nickname: payload.nickname,
      publicKey: payload.publicKey,
      presence: 'IN_CHAT',
      screenshotDetection: false,
    };
    const result = await db.occupySlot(roomId, targetSlot, slotState);
    if (!result.ok) {
      const error = result.reason === 'locked' ? 'room closed' : result.reason === 'no_room' ? 'room not found' : 'room full';
      ack({ success: false, error });
      return;
    }
    socket.join(roomId);
    this.socketLocations.set(socket.id, { roomId, slot: targetSlot });
    await db.touchRoomTTL(roomId);
    const t = this.timers.get(roomId);
    if (t?.waiting) clearTimeout(t.waiting); // a peer arrived — no more waiting-for-peer countdown
    this.log('join_room', roomId);
    ack({ success: true });
    await this.pushChatState(roomId, this.otherSlot(targetSlot));
  }

  async enterChat(
    socket: Socket,
    payload: EnterChatPayload,
    ack: (res: Ack<{ chatState: ChatStatePayload }>) => void,
  ): Promise<void> {
    const { roomId } = payload;
    const room = await db.getRoom(roomId);
    if (!room) {
      ack({ success: false, error: 'room not found' });
      return;
    }

    let slot: SlotIndex | null = null;
    for (const idx of [0, 1] as const) {
      if (room.slots[idx]?.publicKey === payload.publicKey) {
        slot = idx;
        break;
      }
    }
    if (slot === null) {
      ack({ success: false, error: 'not a participant in this room' });
      return;
    }

    const existing = room.slots[slot]!;
    const wasDisconnected = existing.presence === 'DISCONNECTED';
    await db.updateSlot(roomId, slot, {
      ...existing,
      socketId: socket.id,
      presence: 'IN_CHAT',
    });
    socket.join(roomId);
    this.socketLocations.set(socket.id, { roomId, slot });
    await db.touchRoomTTL(roomId);

    if (wasDisconnected) {
      const t = this.timersFor(roomId);
      const g = t.grace.get(slot);
      if (g) clearTimeout(g);
      t.grace.delete(slot);
      await db.clearGraceTimer(roomId, slot);

      const buffered = await db.flushBuffer(roomId, slot);
      for (const msg of buffered) {
        socket.emit('receive_message', { roomId, messageId: msg.messageId, cipherText: msg.cipherText, seq: msg.seq });
      }
      this.log('resume', roomId);
    }

    const refreshed = await db.getRoom(roomId);
    if (!refreshed) {
      ack({ success: false, error: 'room not found' });
      return;
    }
    ack({ success: true, chatState: this.buildChatState(refreshed, slot) });
    if (wasDisconnected) {
      // The peer saw `peer_reconnecting`; now tell them presence is restored.
      await this.pushChatState(roomId, this.otherSlot(slot));
    }
  }

  async sendMessage(
    socket: Socket,
    payload: SendMessagePayload,
    ack: (res: Ack<{ delivered: boolean; seq: number }>) => void,
  ): Promise<void> {
    const loc = this.socketLocations.get(socket.id);
    if (!loc || loc.roomId !== payload.roomId) {
      ack({ success: false, error: 'not a participant in this room' });
      return;
    }
    if (Buffer.byteLength(payload.cipherText, 'utf8') > MAX_CIPHERTEXT_B64_LEN) {
      ack({ success: false, error: 'message too large' });
      return;
    }
    if (!checkMessageRate(socket.id)) {
      ack({ success: false, error: 'rate limited, slow down' });
      return;
    }

    const { roomId, slot } = loc;
    const room = await db.getRoom(roomId);
    if (!room) {
      ack({ success: false, error: 'room not found' });
      return;
    }
    const peer = room.slots[this.otherSlot(slot)];
    if (!peer) {
      ack({ success: false, error: 'peer offline, message not delivered' });
      return;
    }

    const seq = await db.nextSeq(roomId);
    await db.touchRoomTTL(roomId);
    this.resetIdleTimers(roomId);

    if (peer.presence === 'IN_CHAT') {
      this.io.to(peer.socketId).emit('receive_message', {
        roomId,
        messageId: payload.messageId,
        cipherText: payload.cipherText,
        seq,
      });
      ack({ success: true, delivered: true, seq });
      return;
    }

    const bufferResult = await db.bufferMessage(roomId, this.otherSlot(slot), {
      messageId: payload.messageId,
      cipherText: payload.cipherText,
      seq,
    });
    if (!bufferResult.ok) {
      ack({ success: false, error: 'peer offline, message not delivered' });
      return;
    }
    socket.emit('conversation_waiting', { roomId, messageId: payload.messageId });
    ack({ success: true, delivered: false, seq });
  }

  async leaveChat(socket: Socket, payload: { roomId: string }): Promise<void> {
    const loc = this.socketLocations.get(socket.id);
    if (!loc || loc.roomId !== payload.roomId) return;
    this.socketLocations.delete(socket.id);
    clearSocketRateState(socket.id);
    socket.leave(payload.roomId);

    const { roomId, slot } = loc;
    const t = this.timersFor(roomId);
    const g = t.grace.get(slot);
    if (g) clearTimeout(g);
    t.grace.delete(slot);
    await db.clearGraceTimer(roomId, slot);

    const { roomEmpty } = await db.vacateSlot(roomId, slot);
    this.io.to(roomId).emit('peer_left', { roomId });
    this.log('leave_chat', roomId);
    if (roomEmpty) await this.teardown(roomId);
  }

  /** Returns the caller's peer's public key — a convenience re-fetch for a
   * client that wants to confirm it still matches what it already has. */
  async getPublicKey(
    socket: Socket,
    payload: { roomId: string },
    ack: (res: Ack<{ publicKey: string | null }>) => void,
  ): Promise<void> {
    const loc = this.socketLocations.get(socket.id);
    if (!loc || loc.roomId !== payload.roomId) {
      ack({ success: false, error: 'not a participant in this room' });
      return;
    }
    const room = await db.getRoom(payload.roomId);
    if (!room) {
      ack({ success: false, error: 'room not found' });
      return;
    }
    const peer = room.slots[this.otherSlot(loc.slot)];
    ack({ success: true, publicKey: peer?.publicKey ?? null });
  }

  /** Stale-socket guard: only acts if `socket.id` still matches the slot's
   * current occupant — a late `disconnect` from a socket that was already
   * superseded by a resumed session must not vacate the reoccupied slot. */
  async handleDisconnect(socket: Socket): Promise<void> {
    const loc = this.socketLocations.get(socket.id);
    if (!loc) return;
    const { roomId, slot } = loc;

    const room = await db.getRoom(roomId);
    if (!room) {
      this.socketLocations.delete(socket.id);
      return;
    }
    const current = room.slots[slot];
    if (!current || current.socketId !== socket.id) {
      // Slot was already reoccupied by a newer socket; this disconnect is stale.
      this.socketLocations.delete(socket.id);
      return;
    }

    this.socketLocations.delete(socket.id);
    clearSocketRateState(socket.id);
    await db.updateSlot(roomId, slot, { ...current, presence: 'DISCONNECTED' });
    await db.setGraceTimer(roomId, slot);

    const graceDeadline = Date.now() + GRACE_MS;
    const t = this.timersFor(roomId);
    const timer = setTimeout(() => void this.onGraceExpired(roomId, slot, socket.id), GRACE_MS).unref();
    t.grace.set(slot, timer);

    this.io.to(roomId).emit('peer_reconnecting', { roomId, graceDeadline });
    this.log('disconnect_grace_start', roomId);
  }

  private async onGraceExpired(roomId: string, slot: SlotIndex, staleSocketId: string): Promise<void> {
    const room = await db.getRoom(roomId);
    if (!room) return;
    const current = room.slots[slot];
    if (!current || current.socketId !== staleSocketId) return; // already resumed
    if (current.presence !== 'DISCONNECTED') return;

    const t = this.timersFor(roomId);
    t.grace.delete(slot);
    await db.clearGraceTimer(roomId, slot);

    const { roomEmpty } = await db.vacateSlot(roomId, slot);
    this.io.to(roomId).emit('peer_left', { roomId });
    this.log('grace_expired', roomId);
    if (roomEmpty) await this.teardown(roomId);
  }

  async broadcastServerRestarting(): Promise<void> {
    this.io.emit('server_restarting', {});
  }
}
