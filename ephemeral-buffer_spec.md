<task>
Redis-backed storage layer for room metadata and the short-lived message buffer used when a peer is transiently disconnected. This is the only module that touches Redis directly — `room-server` calls its functions rather than issuing Redis commands itself.

Revision 2 — amended per DECISIONS.md. Items tagged [v3]/[v4] are deferred; everything untagged is v1 scope.
</task>

<constraints>
- Every key must have a TTL — nothing in this module's keyspace lives forever. Room metadata TTL refreshes on activity (`touchRoomTTL`); buffer entries use a fixed TTL from creation (not refreshed).
- Buffer reads are destructive and **idempotent**: `flushBuffer(roomId)` returns all entries and deletes the key in the same atomic operation (at-most-once delivery on reconnect). Two concurrent calls must not both return entries — the second returns empty.
- Room creation is **atomic**: `SET NX` with regenerate-and-retry on collision. Never GET-then-SET — that race becomes reachable the moment more than one instance runs [v3], and it silently merges two strangers' conversations.
- Sequence assignment is atomic (`HINCRBY`), not a read-modify-write of a serialized JSON blob. This removes both the race and roughly half the Redis ops per message.
- No plaintext ever touches this module — it only ever stores/relays the `cipherText` field. Never log key contents.
- **Redis is the single source of truth.** `room-server` may hold a write-through in-memory read cache of `RoomState` for rooms it currently serves, so an active conversation survives a Redis blip; this module owns the authoritative copy. On Redis unavailability: existing chats continue from cache, new room creation is rejected with an explicit error.
</constraints>

<data_model>
Reference ARCHITECTURE.md Shared Schemas for `RoomState`, `SlotState`, `BufferedMessage`, and § Limits & Timers for normative values.

Redis key shape:
- `room:{roomId}` → hash, not a JSON blob. Discrete fields (`createdAt`, `lastActivityAt`, `seq`, `everFilled`, `slot0`, `slot1`) so `seq` can be incremented with `HINCRBY` and `everFilled` set without rewriting the whole record. TTL 5 min idle, refreshed on activity.
- `buffer:{roomId}` → Redis list of JSON-serialized `BufferedMessage`. TTL 60s fixed from creation, **max length 50** (FIFO trim on push).
- `grace:{roomId}:{slot}` → per-slot disconnect grace marker, TTL 60s. One key per slot so the two windows run independently.
- `ratelimit:{ip}` → token bucket state, TTL 10 min.

Room codes: `nanoid(12)` over an alphabet excluding `0 O 1 l I`. At 500k concurrent rooms this gives a collision probability of ~1 in 4×10¹⁰; the previous `nanoid(8)` gave ~1 in 2,200, which at steady state means regular collisions.
</data_model>

<acceptance_criteria>
- `createRoom()` writes a new `room:{roomId}` key **via `SET NX`** with both slots null, `everFilled` false, and returns the generated `roomId`. On a collision it regenerates and retries rather than failing or overwriting.
- `getRoom(roomId)` returns `null` for a missing or expired room — never throws for absence.
- `occupySlot(roomId, slot, slotState)` fails safely (returns `null`/`false`) if the slot is already occupied — no silent overwrite. Sets `everFilled` true when this call results in both slots being occupied.
- `lockRoom(roomId)` sets `everFilled` true idempotently; subsequent joins are rejected by `room-server`.
- `vacateSlot(roomId, slot)` clears the slot and returns whether the room is now fully empty, so the caller can trigger teardown. Teardown must be safe to call twice.
- `nextSeq(roomId)` increments and returns the counter atomically via `HINCRBY`. Strictly monotonic, never reused, even across reconnects.
- `bufferMessage(roomId, msg)` enforces **max-50** FIFO trim and sets the 60s TTL on first push (fixed, not refreshed). Returns an explicit overflow indication when the cap is reached so `room-server` can fail the send rather than dropping silently.
- `flushBuffer(roomId)` returns entries sorted by `seq`, and the key no longer exists immediately after the call. Implemented atomically (`LRANGE` + `DEL` in a MULTI, or a Lua script) so concurrent callers cannot both receive entries.
- `touchRoomTTL(roomId)` extends the room's idle TTL and updates `lastActivityAt` without altering slot state.
- `setGraceTimer(roomId, slot)` / `clearGraceTimer(roomId, slot)` manage the per-slot 60s window. Both slots' timers must run correctly and independently when both peers disconnect simultaneously.
- Redis client bootstrap exposes a reachability probe for `room-server`'s `/health` endpoint, reported separately from process health.
</acceptance_criteria>

<deliverable>
`server/src/redis.ts` exporting: `createRoom()`, `getRoom()`, `occupySlot()`, `vacateSlot()`, `lockRoom()`, `nextSeq()`, `bufferMessage()`, `flushBuffer()`, `touchRoomTTL()`, `setGraceTimer()`, `clearGraceTimer()`, `isReachable()`, plus Redis client bootstrap.

`flushBuffer` and `createRoom` should be implemented as Lua scripts where a MULTI cannot guarantee the required atomicity.
</deliverable>
