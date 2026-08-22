import Redis from 'ioredis';
import { customAlphabet } from 'nanoid';
import type { RoomState, SlotState, BufferedMessage, SlotIndex } from './types.js';

// Unambiguous alphabet: excludes 0 O 1 l I (see ARCHITECTURE.md § Room codes).
const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const generateRoomId = customAlphabet(ROOM_CODE_ALPHABET, 12);

const ROOM_TTL_SECONDS = 5 * 60; // backstop cleanup; refreshed on activity via touchRoomTTL
const BUFFER_TTL_SECONDS = 60; // fixed from creation, never refreshed
const BUFFER_MAX_LEN = 50;
const GRACE_TTL_SECONDS = 60;
const CREATE_ROOM_MAX_RETRIES = 8;

const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

export const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});

redis.on('error', (err) => {
  // Never log message content; this is a connection-level error only.
  console.error(`[redis] connection error: ${err.message}`);
});

// ---------------------------------------------------------------------------
// Lua scripts — used wherever a MULTI cannot guarantee the required atomicity.
// ---------------------------------------------------------------------------

// Atomic create-if-absent for a hash-shaped room record. Plain SET NX only
// works on string keys; this script gives the same "never GET-then-SET" race
// guarantee for the hash shape the data model calls for.
const CREATE_ROOM_SCRIPT = `
local key = KEYS[1]
local now = ARGV[1]
local ttl = tonumber(ARGV[2])
if redis.call('EXISTS', key) == 1 then
  return 0
end
redis.call('HSET', key, 'createdAt', now, 'lastActivityAt', now, 'seq', 0, 'everFilled', 0, 'slot0', '', 'slot1', '')
redis.call('EXPIRE', key, ttl)
return 1
`;

// Atomic slot occupation: refuses a silent overwrite, and flips everFilled
// the instant both slots are simultaneously occupied — all in one round trip
// so two concurrent joins can't both believe they got the same open slot.
const OCCUPY_SLOT_SCRIPT = `
local key = KEYS[1]
local slotField = ARGV[1]
local otherField = ARGV[2]
local slotJson = ARGV[3]
local now = ARGV[4]
if redis.call('EXISTS', key) == 0 then
  return 'NO_ROOM'
end
if redis.call('HGET', key, 'everFilled') == '1' then
  return 'LOCKED'
end
local current = redis.call('HGET', key, slotField)
if current ~= false and current ~= '' then
  return 'OCCUPIED'
end
redis.call('HSET', key, slotField, slotJson, 'lastActivityAt', now)
local other = redis.call('HGET', key, otherField)
local bothFilled = 0
if other ~= false and other ~= '' then
  redis.call('HSET', key, 'everFilled', 1)
  bothFilled = 1
end
return 'OK:' .. bothFilled
`;

// Atomic slot clear + "is the room now fully empty" check, safe to call twice.
const VACATE_SLOT_SCRIPT = `
local key = KEYS[1]
local slotField = ARGV[1]
local otherField = ARGV[2]
if redis.call('EXISTS', key) == 0 then
  return 'GONE'
end
redis.call('HSET', key, slotField, '')
local other = redis.call('HGET', key, otherField)
local empty = 0
if other == false or other == '' then
  empty = 1
end
return 'OK:' .. empty
`;

// Push + cap-check in one round trip. Refuses the push once the cap is hit
// instead of trimming the oldest entry — an overflow must surface to the
// caller as an explicit failure, never a silently dropped message.
const BUFFER_MESSAGE_SCRIPT = `
local key = KEYS[1]
local msg = ARGV[1]
local maxLen = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local len = redis.call('LLEN', key)
if len >= maxLen then
  return -1
end
redis.call('RPUSH', key, msg)
if len == 0 then
  redis.call('EXPIRE', key, ttl)
end
return len + 1
`;

// Read-and-delete in one atomic step so two concurrent flushes cannot both
// return entries (at-most-once delivery on reconnect).
const FLUSH_BUFFER_SCRIPT = `
local key = KEYS[1]
local vals = redis.call('LRANGE', key, 0, -1)
redis.call('DEL', key)
return vals
`;

redis.defineCommand('createRoomScript', { numberOfKeys: 1, lua: CREATE_ROOM_SCRIPT });
redis.defineCommand('occupySlotScript', { numberOfKeys: 1, lua: OCCUPY_SLOT_SCRIPT });
redis.defineCommand('vacateSlotScript', { numberOfKeys: 1, lua: VACATE_SLOT_SCRIPT });
redis.defineCommand('bufferMessageScript', { numberOfKeys: 1, lua: BUFFER_MESSAGE_SCRIPT });
redis.defineCommand('flushBufferScript', { numberOfKeys: 1, lua: FLUSH_BUFFER_SCRIPT });

interface RedisWithScripts extends Redis {
  createRoomScript(key: string, now: string, ttl: number): Promise<number>;
  occupySlotScript(
    key: string,
    slotField: string,
    otherField: string,
    slotJson: string,
    now: string,
  ): Promise<string>;
  vacateSlotScript(key: string, slotField: string, otherField: string): Promise<string>;
  bufferMessageScript(key: string, msg: string, maxLen: number, ttl: number): Promise<number>;
  flushBufferScript(key: string): Promise<string[]>;
}

const scriptedRedis = redis as RedisWithScripts;

function roomKey(roomId: string): string {
  return `room:${roomId}`;
}
// Keyed per recipient slot, not just per room: a message is buffered only
// while its specific recipient is DISCONNECTED, and with two independent
// directions in a 2-slot room, a single shared list would let one peer's
// simultaneous reconnect accidentally flush messages addressed to the other.
function bufferKey(roomId: string, recipientSlot: SlotIndex): string {
  return `buffer:${roomId}:${recipientSlot}`;
}
function graceKey(roomId: string, slot: SlotIndex): string {
  return `grace:${roomId}:${slot}`;
}
function slotField(slot: SlotIndex): 'slot0' | 'slot1' {
  return slot === 0 ? 'slot0' : 'slot1';
}
function otherSlotField(slot: SlotIndex): 'slot0' | 'slot1' {
  return slot === 0 ? 'slot1' : 'slot0';
}

function parseSlot(raw: string | undefined): SlotState | null {
  if (!raw) return null;
  return JSON.parse(raw) as SlotState;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function createRoom(): Promise<string> {
  for (let attempt = 0; attempt < CREATE_ROOM_MAX_RETRIES; attempt++) {
    const roomId = generateRoomId();
    const created = await scriptedRedis.createRoomScript(
      roomKey(roomId),
      String(Date.now()),
      ROOM_TTL_SECONDS,
    );
    if (created === 1) return roomId;
  }
  throw new Error('failed to allocate a unique room code');
}

export async function getRoom(roomId: string): Promise<RoomState | null> {
  const hash = await redis.hgetall(roomKey(roomId));
  if (!hash || Object.keys(hash).length === 0) return null;
  return {
    roomId,
    createdAt: Number(hash.createdAt),
    lastActivityAt: Number(hash.lastActivityAt),
    seq: Number(hash.seq ?? 0),
    everFilled: hash.everFilled === '1',
    slots: [parseSlot(hash.slot0), parseSlot(hash.slot1)],
  };
}

export type OccupyResult =
  | { ok: true; everFilled: boolean }
  | { ok: false; reason: 'no_room' | 'locked' | 'occupied' };

export async function occupySlot(
  roomId: string,
  slot: SlotIndex,
  slotState: SlotState,
): Promise<OccupyResult> {
  const result = await scriptedRedis.occupySlotScript(
    roomKey(roomId),
    slotField(slot),
    otherSlotField(slot),
    JSON.stringify(slotState),
    String(Date.now()),
  );
  if (result === 'NO_ROOM') return { ok: false, reason: 'no_room' };
  if (result === 'LOCKED') return { ok: false, reason: 'locked' };
  if (result === 'OCCUPIED') return { ok: false, reason: 'occupied' };
  return { ok: true, everFilled: result === 'OK:1' };
}

/** Overwrites a slot unconditionally — used only to resume a slot already
 * owned by the reconnecting identity (new socketId, same slot). */
export async function updateSlot(
  roomId: string,
  slot: SlotIndex,
  slotState: SlotState,
): Promise<void> {
  await redis.hset(roomKey(roomId), slotField(slot), JSON.stringify(slotState));
}

export async function vacateSlot(
  roomId: string,
  slot: SlotIndex,
): Promise<{ roomGone: boolean; roomEmpty: boolean }> {
  const result = await scriptedRedis.vacateSlotScript(
    roomKey(roomId),
    slotField(slot),
    otherSlotField(slot),
  );
  if (result === 'GONE') return { roomGone: true, roomEmpty: true };
  return { roomGone: false, roomEmpty: result === 'OK:1' };
}

export async function lockRoom(roomId: string): Promise<void> {
  await redis.hset(roomKey(roomId), 'everFilled', '1');
}

export async function deleteRoom(roomId: string): Promise<void> {
  await redis.del(roomKey(roomId), bufferKey(roomId, 0), bufferKey(roomId, 1));
}

export async function nextSeq(roomId: string): Promise<number> {
  return redis.hincrby(roomKey(roomId), 'seq', 1);
}

export type BufferResult = { ok: true } | { ok: false; overflow: true };

export async function bufferMessage(
  roomId: string,
  recipientSlot: SlotIndex,
  msg: BufferedMessage,
): Promise<BufferResult> {
  const result = await scriptedRedis.bufferMessageScript(
    bufferKey(roomId, recipientSlot),
    JSON.stringify(msg),
    BUFFER_MAX_LEN,
    BUFFER_TTL_SECONDS,
  );
  if (result === -1) return { ok: false, overflow: true };
  return { ok: true };
}

export async function flushBuffer(roomId: string, recipientSlot: SlotIndex): Promise<BufferedMessage[]> {
  const raw = await scriptedRedis.flushBufferScript(bufferKey(roomId, recipientSlot));
  const entries = raw.map((r) => JSON.parse(r) as BufferedMessage);
  entries.sort((a, b) => a.seq - b.seq);
  return entries;
}

export async function touchRoomTTL(roomId: string): Promise<void> {
  const key = roomKey(roomId);
  await redis
    .multi()
    .hset(key, 'lastActivityAt', String(Date.now()))
    .expire(key, ROOM_TTL_SECONDS)
    .exec();
}

export async function setGraceTimer(roomId: string, slot: SlotIndex): Promise<void> {
  await redis.set(graceKey(roomId, slot), '1', 'EX', GRACE_TTL_SECONDS);
}

export async function clearGraceTimer(roomId: string, slot: SlotIndex): Promise<void> {
  await redis.del(graceKey(roomId, slot));
}

export async function hasGraceTimer(roomId: string, slot: SlotIndex): Promise<boolean> {
  return (await redis.exists(graceKey(roomId, slot))) === 1;
}

export async function isReachable(): Promise<boolean> {
  try {
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  await redis.quit();
}
