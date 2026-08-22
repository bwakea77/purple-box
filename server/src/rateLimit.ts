import { createHash, randomBytes } from 'node:crypto';

// v1 runs as a single sticky instance (see DECISIONS.md §0.3), so per-instance
// in-memory state is sufficient here; nothing below needs to survive a
// process restart, unlike room/message state which lives in Redis.

const TEN_MINUTES_MS = 10 * 60 * 1000;
const CREATE_ROOM_FREE_LIMIT = 3; // allowed with no PoW
const CREATE_ROOM_HARD_LIMIT = 5; // rejected outright beyond this, per 10 min

const MESSAGE_BURST_LIMIT = 20; // per 10s
const MESSAGE_BURST_WINDOW_MS = 10_000;
const MESSAGE_SUSTAINED_LIMIT = 5; // per 1s
const MESSAGE_SUSTAINED_WINDOW_MS = 1_000;

const POW_DIFFICULTY = 18; // leading zero bits required
const POW_CHALLENGE_TTL_MS = 2 * 60 * 1000;

// Integration tests exercise many create_room calls from one IP inside the
// same 10-min window; this keeps rate limiting itself testable elsewhere
// without every unrelated test having to solve a PoW challenge.
const RATE_LIMIT_DISABLED = process.env.DISABLE_RATE_LIMIT === '1';

function pruneWindow(timestamps: number[], windowMs: number, now: number): number[] {
  const cutoff = now - windowMs;
  let i = 0;
  while (i < timestamps.length && timestamps[i]! <= cutoff) i++;
  return i === 0 ? timestamps : timestamps.slice(i);
}

// --- Room creation: token bucket per IP, PoW gate above the free tier ------

const creationTimestampsByIp = new Map<string, number[]>();

export interface CreateRoomLimitResult {
  allowed: boolean;
  requirePow: boolean;
}

export function checkRoomCreation(ip: string): CreateRoomLimitResult {
  if (RATE_LIMIT_DISABLED) return { allowed: true, requirePow: false };
  const now = Date.now();
  const timestamps = pruneWindow(creationTimestampsByIp.get(ip) ?? [], TEN_MINUTES_MS, now);
  creationTimestampsByIp.set(ip, timestamps);

  if (timestamps.length >= CREATE_ROOM_HARD_LIMIT) {
    return { allowed: false, requirePow: false };
  }
  if (timestamps.length >= CREATE_ROOM_FREE_LIMIT) {
    return { allowed: true, requirePow: true };
  }
  return { allowed: true, requirePow: false };
}

export function recordRoomCreated(ip: string): void {
  const now = Date.now();
  const timestamps = pruneWindow(creationTimestampsByIp.get(ip) ?? [], TEN_MINUTES_MS, now);
  timestamps.push(now);
  creationTimestampsByIp.set(ip, timestamps);
  totalCreationsThisHour.push(now);
}

// --- Proof of work ----------------------------------------------------------

interface PowChallenge {
  challenge: string;
  issuedAt: number;
}

const powChallengesByIp = new Map<string, PowChallenge>();

export function issuePowChallenge(ip: string): { challenge: string; difficulty: number } {
  const challenge = randomBytes(16).toString('hex');
  powChallengesByIp.set(ip, { challenge, issuedAt: Date.now() });
  return { challenge, difficulty: POW_DIFFICULTY };
}

function leadingZeroBits(buf: Buffer): number {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    let b = byte;
    for (let i = 7; i >= 0; i--) {
      if ((b >> i) & 1) return bits;
      bits++;
    }
  }
  return bits;
}

export function verifyPowSolution(ip: string, challenge: string, nonce: string): boolean {
  const issued = powChallengesByIp.get(ip);
  if (!issued || issued.challenge !== challenge) return false;
  if (Date.now() - issued.issuedAt > POW_CHALLENGE_TTL_MS) {
    powChallengesByIp.delete(ip);
    return false;
  }
  const digest = createHash('sha256').update(`${challenge}:${nonce}`).digest();
  const solved = leadingZeroBits(digest) >= POW_DIFFICULTY;
  if (solved) powChallengesByIp.delete(ip); // one-shot challenge
  return solved;
}

// --- Message throttling: per-socket, never disconnects ---------------------

const messageTimestampsBySocket = new Map<string, number[]>();

export function checkMessageRate(socketId: string): boolean {
  const now = Date.now();
  const timestamps = messageTimestampsBySocket.get(socketId) ?? [];
  const burstWindow = pruneWindow(timestamps, MESSAGE_BURST_WINDOW_MS, now);
  const sustainedWindow = burstWindow.filter((t) => t > now - MESSAGE_SUSTAINED_WINDOW_MS);

  if (burstWindow.length >= MESSAGE_BURST_LIMIT || sustainedWindow.length >= MESSAGE_SUSTAINED_LIMIT) {
    messageTimestampsBySocket.set(socketId, burstWindow);
    return false;
  }
  burstWindow.push(now);
  messageTimestampsBySocket.set(socketId, burstWindow);
  return true;
}

export function clearSocketRateState(socketId: string): void {
  messageTimestampsBySocket.delete(socketId);
}

// --- Global circuit breaker -------------------------------------------------

const ONE_HOUR_MS = 60 * 60 * 1000;
// No 7-day telemetry store exists yet in v1; operators set the observed
// steady-state hourly baseline via env until real telemetry backs this.
const BASELINE_CREATIONS_PER_HOUR = Number(process.env.BASELINE_ROOM_CREATIONS_PER_HOUR ?? 1000);

let totalCreationsThisHour: number[] = [];

export function circuitBreakerTripped(): boolean {
  if (RATE_LIMIT_DISABLED) return false;
  const now = Date.now();
  totalCreationsThisHour = pruneWindow(totalCreationsThisHour, ONE_HOUR_MS, now);
  return totalCreationsThisHour.length > BASELINE_CREATIONS_PER_HOUR * 10;
}
