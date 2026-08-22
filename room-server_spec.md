<task>
Fastify + Socket.io server that owns room lifecycle and message relay for 1:1 ephemeral chatrooms. Decides, per message, whether to deliver directly (peer is `IN_CHAT`) or buffer briefly (peer transiently disconnected), assigns sequence numbers, and never persists plaintext or ciphertext beyond the buffer's TTL.

Revision 2 — amended per DECISIONS.md. Items tagged [v2]/[v3]/[v4] are deferred; everything untagged is v1 scope.
</task>

<constraints>
- Exactly 2 slots per room, held in a `slots[]` array of fixed length 2. No third occupant, ever — reject with an explicit error, not a silent drop. Array shape is deliberate: small-group [v4] must not require refactoring every handler.
- Presence per slot is binary within a room's context: `IN_CHAT` or `DISCONNECTED` (short grace window on socket disconnect, not immediate slot vacancy — covers refresh/network blips). Each slot has its own independent grace timer.
- A room only becomes eligible for cleanup when both slots are empty: explicit `leave_chat` from both, or the disconnect grace window expiring for both. Teardown must be idempotent — calling it twice is harmless.
- Never log message content (plaintext or ciphertext) — log event name, `roomId`, and timestamp only. Never interpolate message content into error strings or thrown exceptions.
- Room codes must not be sequential or guessable: `nanoid(12)` over an alphabet excluding `0 O 1 l I`. Creation is atomic (`SET NX`) with regenerate-and-retry on collision — never GET-then-SET.
- **No authoritative state in process memory.** Redis is the single source of truth. Any in-process cache is write-through read-only and exists solely to survive a Redis blip. No handler may assume the peer's socket is local to this instance — this is what permits horizontal scaling in [v3] without a rewrite.
- **No content inspection is possible or permitted.** The server handles `cipherText` as an opaque blob. Do not specify keyword filtering, content-based room termination, or any scanning.
</constraints>

<data_model>
Reference ARCHITECTURE.md Shared Schemas for `RoomState`, `SlotState`, `SendMessagePayload`, `EnterChatPayload`, `ReceiveMessagePayload`, `ChatStatePayload`.

Normative limits and timers are in ARCHITECTURE.md § Limits & Timers.
</data_model>

<events>
Client → server: `create_room`, `join_room`, `enter_chat`, `send_message`, `leave_chat`, `get_public_key`, `report_abuse` [v2], `screenshot_taken` [v4]

Server → client: `receive_message`, `conversation_waiting`, `peer_left`, `peer_reconnecting`, `error`, `server_restarting`, `peer_screenshotted` [v4]
</events>

<acceptance_criteria>

## Room lifecycle
- `create_room` returns a fresh `roomId` and occupies slot 0 for the creator's socket. Code is `nanoid(12)`, written with `SET NX`; on collision the server regenerates and retries rather than failing.
- `join_room` with a valid `roomId` and an open slot occupies slot 1; with no open slot returns `{success: false, error: 'room full'}`; with an unknown `roomId` returns `{success: false, error: 'room not found'}`.
- **Room locking**: the moment both slots are simultaneously occupied, `everFilled` is set `true`. Once `true`, `join_room` returns `{success: false, error: 'room closed'}` regardless of subsequent slot vacancy. A departed occupant cannot re-enter; no third party can take a vacated slot.
- **Waiting timeout**: a room whose second slot is never occupied expires 10 minutes after creation. The waiting occupant receives an explicit "no one joined" state — never an indefinite spinner.
- **Idle timeout**: 30 minutes with no message from either party closes the room, with a warning emitted at 25 minutes. `lastActivityAt` is updated on every `send_message`.
- **Hard session cap**: 4 hours from `createdAt` regardless of activity, with a 5-minute warning. Prevents unbounded resource holding.

## Message relay
- `send_message` delivers directly via `receive_message` (with assigned `seq`) when the peer is `IN_CHAT`; buffers via `ephemeral-buffer` and emits `conversation_waiting` when the peer is `DISCONNECTED`.
- Sequence numbers are strictly monotonic per room and never reused, even across reconnects. Assignment must be atomic (`HINCRBY`), not read-modify-write.
- **Buffer overflow is never silent**: when `bufferMessage` reports the cap is reached, `send_message` returns `{success: false, error: 'peer offline, message not delivered'}`. The server must never allow a message to be dropped while the client shows it as sent.
- `cipherText` exceeding 4 KB is rejected with `{success: false, error: 'message too large'}`.

## Presence, disconnect, reconnect
- `leave_chat` vacates the sender's slot, notifies the peer via `peer_left`, and does **not** touch the peer's own message history — that state is client-owned.
- A socket disconnect without an explicit `leave_chat` starts a 60s grace window before the slot is vacated, and emits `peer_reconnecting` to the remaining peer so the client can distinguish this from a deliberate departure. A reconnect within the window to the same `roomId`+slot resumes `IN_CHAT` and flushes any buffered messages via `enter_chat`.
- **Stale-socket guard**: before honouring a `disconnect` event, the server must confirm the disconnecting `socketId` still matches the slot's current occupant. A late-firing disconnect from a superseded socket must not vacate a newly reoccupied slot.
- Each slot's grace timer runs independently (`grace:{roomId}:{slot}`). Simultaneous disconnect of both slots must resolve correctly: both reconnect → room resumes with both buffers flushed; neither reconnects → room reaped exactly once at the 60s mark.

## Rate limiting & abuse
- `create_room`: token bucket 5 per 10 min per IP, burst 3. Above 3 in 10 min, a proof-of-work challenge is required before the room is created. Do **not** implement per-device limiting — device fingerprinting is unreliable and contradicts the product's privacy stance.
- `send_message`: 20 per 10 s burst, 5/s sustained, per socket. Exceeding throttles the sender; it must not disconnect them.
- Global circuit breaker: halt all room creation if fleet-wide creation rate exceeds 10× the 7-day baseline.
- `report_abuse` [v2]: accepts `{roomId, transcript?, reason}`. The transcript is supplied voluntarily by the reporting client from its own decrypted RAM — the server never decrypts anything. Payload retains reporter and reported IPs, `roomId`, and timestamps.

## Screenshot capability relay [v4]
- `enter_chat` payload carries `screenshotDetection: boolean`, stored on the slot.
- The server computes room-level `screenshotAlertsActive` as the logical AND of both slots' capability and includes it in `ChatStatePayload`. One undetectable peer degrades the whole room — never expose a per-peer capability value.
- `screenshot_taken {roomId}` (fire-and-forget) causes the server to assign a `seq` and relay `peer_screenshotted {seq}` to **both** occupants, including the sender. Anchoring to `seq` lets clients render it inline at the correct transcript position.

## Operations
- `GET /health` reports process health and Redis reachability **as separate fields**. The load balancer uses Redis-unreachable to stop routing new rooms to an instance while letting it drain existing ones.
- On `SIGTERM`: deregister from the LB immediately, emit `server_restarting` to connected sockets, drain for up to 90s, then exit. Room state survives in Redis; clients reconnect within their grace window.
- Telemetry is aggregate-only: rooms created/hour, concurrent sessions, session duration buckets, messages relayed/sec (count only — never size), buffer flush and overflow rates, error counts, reconnect success rate. Never emit `roomId`, IP, nickname, ciphertext, or per-message size into metrics.

## Required tests (reconnect race)
1. Peer reconnects at t=59.5s with one buffered message → delivered exactly once.
2. Peer reconnects at t=60.5s → clean `peer_left`, no zombie slot.
3. Old socket's `disconnect` fires after the new socket's `enter_chat` → slot is **not** vacated.
4. Both peers reconnect simultaneously → both buffers flush, `seq` order preserved across both.
5. `flushBuffer` called concurrently twice → second returns empty, no double delivery.
6. `seq` continuity across reconnect → strictly monotonic, no reuse.
</acceptance_criteria>

<deliverable>
`server/src/` with:
- `index.ts` — HTTP bootstrap, `/health`, Socket.io handlers, graceful shutdown
- `rooms.ts` — room lifecycle logic, locking, session timers, teardown (idempotent)
- `rateLimit.ts` — token buckets, PoW challenge, circuit breaker
- `types.d.ts`
</deliverable>
