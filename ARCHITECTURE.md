# Purple Box (Web) — Architecture

> **Revision 2** — amended per `DECISIONS.md` (50-question intake).
> Version tags: items marked `[v2]`, `[v3]`, `[v4]` are deferred; everything untagged is v1 scope.

## Goal
A browser-based, ephemeral 1:1 chat app: two people connect via a shared room link, exchange live messages while both are present, and each person's message history vanishes from their own screen the moment they leave — no accounts, no persistence, no native app required.

## Stack
- **Client**: React 18 + TypeScript, Vite, Zustand (state), Socket.io-client, tweetnacl + tweetnacl-util (E2E encryption, browser-compatible)
- **Server**: Node.js, Fastify + fastify-socket.io, Socket.io, TypeScript (ESM)
- **Ephemeral storage**: Redis — buffer + room metadata only, every key TTL-bound
- **Deployment**: Docker Compose (client static build, server container, redis container)

## Global Conventions
- Error handling: request/response Socket.io events use `{success: boolean, error?: string}` callbacks. Fire-and-forget events (`receive_message`, `conversation_waiting`, `peer_left`, `peer_screenshotted`, `server_restarting`) carry no callback; failures surface via a dedicated `error` event.
- Logging: never log message content (plaintext or ciphertext) — log event name + `roomId` + timestamp only.
- Naming: camelCase vars/functions, PascalCase React components/types, kebab-case room codes.
- Language: TypeScript strict mode, client and server.
- **Statelessness**: the server holds no authoritative room state in process memory. Redis is the single source of truth; any in-process cache is a write-through read cache only (see `ephemeral-buffer` spec). No handler may assume the peer's socket is local to this instance.
- **Room codes**: `nanoid(12)` over an unambiguous alphabet (exclude `0 O 1 l I`). Creation is atomic via `SET NX`; on collision, regenerate and retry.

## Module Boundaries

| Module | Owns | Exposes | Consumes |
|---|---|---|---|
| `room-client` | UI screens (landing, waiting, chat), RAM-only message state, socket lifecycle, client-side NaCl encrypt/decrypt, wipe-on-leave logic, reconnect backoff, SAS verification UI `[v2]`, capture-detection surface `[v4]` | — (leaf app) | `room-server`'s Socket.io event contract |
| `room-server` | Room lifecycle (create/join/validate/lock), per-room presence, per-room sequence counter, message relay decision (direct vs. buffer), public key relay, rate limiting, session timers, health reporting | Socket.io events (see below) + `GET /health` | `ephemeral-buffer` functions |
| `ephemeral-buffer` | Redis connection, room metadata with TTL, message buffer (list, TTL, max size), per-slot grace timers | `createRoom()`, `getRoom()`, `occupySlot()`, `vacateSlot()`, `bufferMessage()`, `flushBuffer()`, `touchRoomTTL()`, `setGraceTimer()`, `clearGraceTimer()`, `lockRoom()` | — (leaf) |

### Socket.io event contract

**Client → server**: `create_room`, `join_room`, `enter_chat`, `send_message`, `leave_chat`, `get_public_key`, `report_abuse` `[v2]`, `screenshot_taken` `[v4]`

**Server → client**: `receive_message`, `conversation_waiting`, `peer_left`, `peer_reconnecting`, `error`, `server_restarting`, `peer_screenshotted` `[v4]`

## Shared Schemas

```typescript
// Room state (server-side, mirrored in Redis)
interface RoomState {
  roomId: string;              // nanoid(12), unambiguous alphabet
  createdAt: number;
  lastActivityAt: number;      // drives the 30-min idle timeout
  seq: number;                 // monotonic per-room sequence counter, never reused
  slots: (SlotState | null)[]; // fixed length 2 in v1; array shape reserved for small-group [v4]
  everFilled: boolean;         // true once both slots simultaneously occupied — locks the room forever
}

interface SlotState {
  socketId: string;
  nickname: string;
  publicKey: string;           // base64, ephemeral session keypair, regenerated per join
  presence: 'IN_CHAT' | 'DISCONNECTED'; // DISCONNECTED = short reconnect grace window, not a full leave
  screenshotDetection: boolean; // [v4] client-reported capture-detection capability
}

// Client -> server
interface SendMessagePayload {
  roomId: string;
  messageId: string;           // uuid-style, client-generated
  cipherText: string;          // base64: nonce(24) + ephemeralPublicKey(32) + encrypted payload; max 4 KB
}

interface EnterChatPayload {
  roomId: string;
  nickname: string;
  publicKey: string;
  screenshotDetection: boolean; // [v4] platform capability, computed client-side
}

// Server -> client
interface ReceiveMessagePayload {
  roomId: string;
  messageId: string;
  cipherText: string;
  seq: number;
}

interface ChatStatePayload {           // sent on enter_chat and on peer state change
  roomId: string;
  peerPresent: boolean;
  peerNickname: string | null;
  peerPublicKey: string | null;
  screenshotAlertsActive: boolean;     // [v4] AND of both slots' screenshotDetection
}

// Buffered entry (Redis list value, JSON string)
interface BufferedMessage {
  messageId: string;
  cipherText: string;
  seq: number;
}
```

## Limits & Timers (normative)

| Parameter | Value | Rationale |
|---|---|---|
| Room code length | `nanoid(12)` | Collision prob. ~1e-10 at 500k concurrent rooms |
| Slots per room | 2 (array-shaped) | Small-group deferred to `[v4]` |
| Waiting-for-peer timeout | 10 min | Reaps mass-spawned empty rooms |
| Idle timeout | 30 min (warn at 25) | Reclaims abandoned rooms |
| Hard session cap | 4 h (warn at 3h55) | Bounds worst-case resource holding |
| Disconnect grace window | 60 s per slot, independent | Covers refresh / network blip |
| Message buffer TTL | 60 s fixed from creation | Matches grace window |
| Message buffer cap | 50 entries, FIFO | Overflow returns explicit failure to sender |
| Max `cipherText` | 4 KB (≈2 KB plaintext) | Rejected above with explicit error |
| Message rate limit | 20 / 10 s burst, 5/s sustained, per socket | Throttle, never disconnect |
| Room creation rate limit | 5 / 10 min per IP, PoW challenge above 3 | NAT-tolerant (CGNAT is common in target market) |
| Room TTL (idle, Redis) | 5 min, refreshed on activity | Backstop cleanup |

## System-Wide Non-Goals
- No accounts, no phone/OTP, no persistent identity across sessions. The room link is the only shared secret. Once both slots have been simultaneously filled (`everFilled`), the room is permanently locked — no third party can take a vacated slot, and a departed occupant cannot re-enter.
- No group chat in v1 — rooms are strictly 2 slots. The `slots[]` array shape exists so small-group `[v4]` does not require refactoring every handler.
- No message persistence anywhere: client RAM only, server never writes plaintext, Redis buffer is TTL-bound and deleted on read.
- No push notifications, no background delivery. Native wrapper deferred to `[v4]`.
- No read receipts persisted beyond the current session — delivery status indicators are visual only.
- No reconnection continuity beyond the buffer's TTL grace window — a disconnect that outlasts it means the message is dropped (loss acceptable; reordering/duplication is not, per product philosophy).
- **No content-based moderation is possible under E2E.** The server sees only `cipherText`. Keyword detection, automated room termination on banned phrases, and any form of content scanning are structurally impossible and must not be specified. Abuse handling is metadata- and user-report-based only (`report_abuse`, `[v2]`).
- **No screenshot or screen-recording prevention.** Not possible on web; only partial on native (`FLAG_SECURE` on Android 14+ `[v4]`). The product detects and discloses where it can, and states plainly where it cannot. It never implies protection it does not have.
- No defence against a malicious peer, a compromised endpoint, or state-level traffic analysis. These are stated publicly, not silently omitted.
