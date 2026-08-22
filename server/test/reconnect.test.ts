import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import type { FastifyInstance } from 'fastify';
import type { RoomManager } from '../src/rooms.js';
import type { Ack, ReceiveMessagePayload } from '../src/types.js';

// Required tests (reconnect race) — see room-server_spec.md § Required tests.
// GRACE_MS is shortened here so the suite runs in seconds, not minutes; the
// production default (60s) is untouched — see rooms.ts.
const GRACE_MS = 3000;
process.env.GRACE_MS = String(GRACE_MS);
process.env.WAITING_FOR_PEER_MS = '600000';
process.env.IDLE_WARN_MS = '600000';
process.env.IDLE_TIMEOUT_MS = '600000';
process.env.HARD_CAP_WARN_MS = '600000';
process.env.HARD_CAP_MS = '600000';
process.env.KEEP_ALIVE_INTERVAL_MS = '600000';
process.env.DISABLE_RATE_LIMIT = '1';

let app: FastifyInstance;
let rooms: RoomManager;
let db: typeof import('../src/redis.js');
let baseUrl: string;

beforeAll(async () => {
  const { buildServer } = await import('../src/server.js');
  db = await import('../src/redis.js');
  const built = await buildServer('*');
  app = built.app;
  rooms = built.rooms;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  // Let any still-pending grace timers from earlier tests fire against a
  // live Redis connection before tearing it down, so closing here doesn't
  // race a late setTimeout callback into an "already closed" error.
  await new Promise((resolve) => setTimeout(resolve, GRACE_MS + 2000));
  await app.close();
  await db.closeRedis();
});

function connect(): ClientSocket {
  return ioClient(baseUrl, { transports: ['websocket'], reconnection: false, forceNew: true });
}

function waitConnected(socket: ClientSocket): Promise<void> {
  return new Promise((resolve) => socket.on('connect', () => resolve()));
}

function emitAck<T = Record<string, unknown>>(
  socket: ClientSocket,
  event: string,
  payload: unknown,
): Promise<Ack<T>> {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function waitForEvent<T>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, resolve));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function keyPair(): string {
  return randomBytes(32).toString('base64');
}

interface Peer {
  socket: ClientSocket;
  nickname: string;
  publicKey: string;
}

async function createAndEnter(nickname: string): Promise<{ peer: Peer; roomId: string }> {
  const socket = connect();
  await waitConnected(socket);
  const publicKey = keyPair();
  const createAck = await emitAck<{ roomId: string }>(socket, 'create_room', { nickname, publicKey });
  if (!createAck.success) throw new Error(createAck.error);
  const roomId = createAck.roomId;
  const enterAck = await emitAck(socket, 'enter_chat', {
    roomId,
    nickname,
    publicKey,
    screenshotDetection: false,
  });
  if (!enterAck.success) throw new Error((enterAck as { error: string }).error);
  return { peer: { socket, nickname, publicKey }, roomId };
}

async function joinAndEnter(roomId: string, nickname: string): Promise<Peer> {
  const socket = connect();
  await waitConnected(socket);
  const publicKey = keyPair();
  const joinAck = await emitAck(socket, 'join_room', { roomId, nickname, publicKey });
  if (!joinAck.success) throw new Error((joinAck as { error: string }).error);
  const enterAck = await emitAck(socket, 'enter_chat', {
    roomId,
    nickname,
    publicKey,
    screenshotDetection: false,
  });
  if (!enterAck.success) throw new Error((enterAck as { error: string }).error);
  return { socket, nickname, publicKey };
}

async function resume(
  roomId: string,
  peer: Peer,
  onMessage?: (msg: ReceiveMessagePayload) => void,
): Promise<ClientSocket> {
  const socket = connect();
  await waitConnected(socket);
  // Buffered messages are emitted server-side before the enter_chat ack, so
  // the listener must be attached before the request goes out, not after.
  if (onMessage) socket.on('receive_message', onMessage);
  const enterAck = await emitAck(socket, 'enter_chat', {
    roomId,
    nickname: peer.nickname,
    publicKey: peer.publicKey,
    screenshotDetection: false,
  });
  if (!enterAck.success) throw new Error((enterAck as { error: string }).error);
  return socket;
}

describe('reconnect race (required tests)', () => {
  it('1. reconnect at t < grace with one buffered message → delivered exactly once', async () => {
    const { peer: a, roomId } = await createAndEnter('alice');
    const b = await joinAndEnter(roomId, 'bob');

    b.socket.disconnect();
    await sleep(50); // let the server register the disconnect before sending

    const sendAck = await emitAck<{ delivered: boolean }>(a.socket, 'send_message', {
      roomId,
      messageId: 'm1',
      cipherText: 'ciphertext-1',
    });
    expect(sendAck.success).toBe(true);
    if (sendAck.success) expect(sendAck.delivered).toBe(false);

    await sleep(GRACE_MS - 1000); // comfortably within the grace window

    const received: ReceiveMessagePayload[] = [];
    const b2 = await resume(roomId, b, (msg) => received.push(msg));

    await sleep(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.messageId).toBe('m1');

    a.socket.disconnect();
    b2.disconnect();
  });

  it('2. reconnect after grace expiry → clean peer_left, no zombie slot', async () => {
    const { peer: a, roomId } = await createAndEnter('alice2');
    const b = await joinAndEnter(roomId, 'bob2');

    const peerLeftPromise = waitForEvent(a.socket, 'peer_left');
    b.socket.disconnect();

    await peerLeftPromise; // fires once grace expires (~1000ms)

    const room = await db.getRoom(roomId);
    expect(room?.slots[1]).toBeNull(); // vacated, not a lingering zombie

    // A late "reconnect" attempt referencing the old identity must fail cleanly.
    const lateResume = await emitAck(connect(), 'enter_chat', {
      roomId,
      nickname: b.nickname,
      publicKey: b.publicKey,
      screenshotDetection: false,
    }).catch(() => null);
    // Either the socket never connected in time or the server rejects it —
    // either way it must not resurrect the vacated slot.
    if (lateResume) expect(lateResume.success).toBe(false);

    a.socket.disconnect();
  });

  it('3. a late disconnect from a superseded socket must not vacate the reoccupied slot', async () => {
    const { peer: a, roomId } = await createAndEnter('alice3');
    const b = await joinAndEnter(roomId, 'bob3');

    const oldSocketId = a.socket.id!;
    a.socket.disconnect();
    await sleep(50);

    const a2 = await resume(roomId, a);
    await sleep(50);

    const roomAfterResume = await db.getRoom(roomId);
    expect(roomAfterResume?.slots[0]?.socketId).toBe(a2.id);

    // Simulate the original socket's `disconnect` event arriving late.
    await rooms.handleDisconnect({ id: oldSocketId } as unknown as Parameters<RoomManager['handleDisconnect']>[0]);

    const roomAfterStaleDisconnect = await db.getRoom(roomId);
    expect(roomAfterStaleDisconnect?.slots[0]).not.toBeNull();
    expect(roomAfterStaleDisconnect?.slots[0]?.socketId).toBe(a2.id);
    expect(roomAfterStaleDisconnect?.slots[0]?.presence).toBe('IN_CHAT');

    a2.disconnect();
    b.socket.disconnect();
  });

  it('4. both peers reconnect around the same time → buffers flush independently, seq preserved', async () => {
    const { peer: a, roomId } = await createAndEnter('alice4');
    const b = await joinAndEnter(roomId, 'bob4');

    // A goes down; B (still connected) queues two messages for A.
    a.socket.disconnect();
    await sleep(50);
    const ack1 = await emitAck<{ delivered: boolean }>(b.socket, 'send_message', {
      roomId,
      messageId: 'm-to-a-1',
      cipherText: 'ct-1',
    });
    const ack2 = await emitAck<{ delivered: boolean }>(b.socket, 'send_message', {
      roomId,
      messageId: 'm-to-a-2',
      cipherText: 'ct-2',
    });
    expect(ack1.success && !ack1.delivered).toBe(true);
    expect(ack2.success && !ack2.delivered).toBe(true);

    // B goes down too, before A has resumed — both slots are now DISCONNECTED,
    // A's inbox holds two messages, B's inbox holds none.
    b.socket.disconnect();
    await sleep(50);

    const aReceived: ReceiveMessagePayload[] = [];
    const bReceived: ReceiveMessagePayload[] = [];

    const [a2, b2] = await Promise.all([
      resume(roomId, a, (m) => aReceived.push(m)),
      resume(roomId, b, (m) => bReceived.push(m)),
    ]);

    await sleep(200);

    expect(aReceived.map((m) => m.messageId)).toEqual(['m-to-a-1', 'm-to-a-2']);
    expect(aReceived[0]!.seq).toBeLessThan(aReceived[1]!.seq);
    expect(bReceived).toHaveLength(0); // nothing was ever queued for B

    const room = await db.getRoom(roomId);
    expect(room?.slots[0]?.presence).toBe('IN_CHAT');
    expect(room?.slots[1]?.presence).toBe('IN_CHAT');

    a2.disconnect();
    b2.disconnect();
  });

  it('5. flushBuffer called concurrently twice → second returns empty, no double delivery', async () => {
    const roomId = await db.createRoom();
    await db.bufferMessage(roomId, 1, { messageId: 'x1', cipherText: 'ct', seq: 1 });

    const [first, second] = await Promise.all([db.flushBuffer(roomId, 1), db.flushBuffer(roomId, 1)]);
    const combined = [...first, ...second];
    expect(combined).toHaveLength(1);
    expect(combined[0]?.messageId).toBe('x1');

    await db.deleteRoom(roomId);
  });

  it('6. seq is strictly monotonic across a reconnect, never reused', async () => {
    const { peer: a, roomId } = await createAndEnter('alice6');
    const b = await joinAndEnter(roomId, 'bob6');

    const seqs: number[] = [];
    const s1 = await emitAck<{ delivered: boolean }>(a.socket, 'send_message', {
      roomId,
      messageId: 'r1',
      cipherText: 'ct',
    });
    expect(s1.success).toBe(true);

    b.socket.disconnect();
    await sleep(50);

    const s2 = await emitAck<{ delivered: boolean }>(a.socket, 'send_message', {
      roomId,
      messageId: 'r2',
      cipherText: 'ct',
    });
    const s3 = await emitAck<{ delivered: boolean }>(a.socket, 'send_message', {
      roomId,
      messageId: 'r3',
      cipherText: 'ct',
    });
    expect(s2.success && !s2.delivered).toBe(true);
    expect(s3.success && !s3.delivered).toBe(true);

    const received: ReceiveMessagePayload[] = [];
    const b2 = await resume(roomId, b, (m) => {
      received.push(m);
      seqs.push(m.seq);
    });
    await sleep(200);

    expect(received.map((m) => m.messageId)).toEqual(['r2', 'r3']);
    expect(seqs[0]).toBeLessThan(seqs[1]!);
    // r1 (delivered directly, before the disconnect) consumed the first seq;
    // r2/r3 must continue strictly upward from it, never reusing 1.
    expect(seqs[0]).toBeGreaterThan(1);

    a.socket.disconnect();
    b2.disconnect();
  });
});
