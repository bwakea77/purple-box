<task>
The web frontend for Purple Box. Lets a user either create a new room (get a shareable link) or join a room via a link/code, enter a nickname, chat live with the other occupant, and see message state permanently wiped from their own screen and memory the instant they leave the room or close the tab.

Revision 2 — amended per DECISIONS.md. Items tagged [v2]/[v3]/[v4] are deferred; everything untagged is v1 scope.
</task>

<constraints>
- No browser storage of any kind (no localStorage/sessionStorage/IndexedDB) for messages or keys — everything lives in React/Zustand state for the lifetime of the tab only.
- NaCl keypair is generated fresh on every room entry and discarded on leave; never persisted.
- **Wipe is layered, not single-trigger.** `beforeunload` is unreliable on mobile (iOS Safari frequently skips it; Android Chrome skips it when backgrounded then killed). Required:
  - `beforeunload` → desktop confirm dialog + wipe attempt
  - `pagehide` → the reliable mobile signal; wipe here
  - `visibilitychange` → start a timer on hidden, wipe after 5 minutes hidden (**promoted from stretch goal to required** — mobile is a first-class target)
  - Client-side wipe is best-effort protection of the user's own screen. The server-side grace window and Redis TTL are the actual cleanup guarantee.
- Message list is sorted strictly by server-assigned `seq`, not by arrival/render order.
- Status indicators (pending spinner → ✓ sent → ✓✓ delivered) must reflect actual server acks, not optimistic assumptions. A message that failed to buffer must render as **failed with a retry affordance** — never as sent.
- Mobile-first. Use `100dvh` not `100vh`; account for virtual-keyboard viewport resize; thumb-sized tap targets.
- Browser baseline: Chrome 80+, Safari 13.1+, Firefox 78+, Samsung Internet 12+. Below baseline, a tiny pre-bundle ES5 check shows an "unsupported browser, please update" page rather than a broken app. Do **not** polyfill for pre-2020 browsers — the weight penalises the low-bandwidth connections that matter most.
- Dark theme carried over from Purple Box: black background, purple accent (#8A2BE2 / #8B5CF6), sent bubbles #4A148C, received bubbles #2C2C2C.
- **Error tracking hygiene**: Sentry `beforeSend` must strip any field named `text`, `cipherText`, `message`, `plaintext`, `nickname`, or `content` at any depth. Disable `sendDefaultPii`. **Suppress breadcrumb capture on message input fields** — Sentry captures keystrokes into inputs by default, which would exfiltrate plaintext. Session replay off, non-negotiable. Never interpolate message content into an error string.
</constraints>

<data_model>
Reference ARCHITECTURE.md Shared Schemas for `SendMessagePayload`, `EnterChatPayload`, `ReceiveMessagePayload`, `ChatStatePayload`.

Local-only client state (Zustand store, RAM only, never persisted):
```typescript
type PeerPresence = 'PEER_IN_CHAT' | 'PEER_RECONNECTING' | 'PEER_LEFT';

interface ChatState {
  roomId: string | null;
  nickname: string;
  peerPresence: PeerPresence;
  reconnectDeadline: number | null;   // epoch ms; drives the countdown UI
  keyPair: nacl.BoxKeyPair | null;    // generated on room entry, discarded on leave
  peerPublicKey: string | null;
  safetyString: string | null;        // [v2] emoji SAS derived from both public keys
  screenshotAlertsActive: boolean;    // [v4] room-level, AND of both peers' capability
  messages: Array<{
    messageId: string;
    text: string;                     // decrypted plaintext, RAM only
    sender: 'me' | 'peer' | 'system';
    seq: number;
    status: 'pending' | 'sent' | 'delivered' | 'failed';
    timestamp: number;
  }>;
}
```
</data_model>

<acceptance_criteria>

## Room entry
- Creating a room produces a shareable URL containing the room code within one socket round trip.
- Joining via a valid link with an open slot reaches `IN_CHAT` state; joining a full room, a locked room (`room closed`), or an invalid/expired code shows a clear, specific error — never a silent failure or infinite spinner.
- The waiting screen surfaces the 10-minute no-peer timeout as an explicit end state, not an indefinite wait.

## Messaging
- Sending a message shows pending → sent → delivered transitions in order, driven by real server acks (not a timeout-based fake).
- A `{success: false, error: 'peer offline, message not delivered'}` response renders the message in `failed` state with a visible retry control. A dropped message must never display a checkmark.
- Messages exceeding 4 KB ciphertext are rejected client-side before send, with a clear length warning.

## Peer presence — three distinct states
The client must visually distinguish all three; rendering `PEER_RECONNECTING` identically to `PEER_LEFT` is a defect, not a cosmetic issue — a user who sees "gone" during a 30-second tunnel blackout closes the tab and destroys a recoverable conversation.
- `PEER_IN_CHAT` — normal chat affordances
- `PEER_RECONNECTING` — "Reconnecting…" with a visible countdown against the 60s grace window
- `PEER_LEFT` — "They left. This room is closed." Composer disabled.

## Reconnect behaviour
Exponential backoff with jitter, bounded by the server grace window:
```
attempt 1:  500 ms ± 20% jitter
attempt 2:  1 s
attempt 3:  2 s
attempt 4:  4 s
attempt 5+: 8 s (capped)
total budget: 60 s → then PEER_LEFT
```
Jitter is mandatory — without it a fleet-wide blip thundering-herds recovery. Messages composed while disconnected stay `pending` locally and flush on reconnect; already-sent messages stay `pending` until acked.
On `server_restarting`, reconnect immediately rather than waiting for the socket to drop.

## Wipe on leave
- Leaving the room (button, refresh, tab close, `pagehide`, or 5 min hidden) clears `messages`, `keyPair`, `peerPublicKey`, and `safetyString` from memory — verify no message text survives in the Zustand store after a leave.
- An explicit confirm dialog fires on `beforeunload` warning that the chat is gone forever.
- Reopening the same link after leaving shows the `room closed` error (rooms are permanently locked once both slots have been filled), not an empty chat.

## SAS key verification [v2]
- Derive `SHA-256(sort(pubKeyA, pubKeyB))`, render the first 30 bits as 6 emoji from a fixed set (emoji over a wordlist — no translation problem for a multilingual audience, and comparison over a voice call still works).
- Both peers see an identical string in the chat header, with a one-tap explainer describing out-of-band comparison.
- Mismatch means a man-in-the-middle. Say so plainly in the explainer.

## Screenshot capability surface [v4]
- Persistent header state, **never dismissible and never per-peer**: `Screenshot alerts: on for both` or `Screenshot alerts unavailable in this room`. Driven by `screenshotAlertsActive` from `ChatStatePayload`.
- `peer_screenshotted` renders as a `system` message inline at its `seq` position, so it is anchored to which messages were on screen. Shown to both parties, including the person who captured.
- Native only: enable `FLAG_SECURE` on Android 14+; register OS screenshot and screen-recording listeners on iOS.
- Baseline copy stays regardless of detection state: *"Screenshots can't be prevented. Only share what you'd accept being kept."*

## Platform
- PWA: installable, home-screen icon, offline shell [v2].
- Native wrapper via Capacitor — same codebase, not a separate React Native app [v4].
</acceptance_criteria>

<deliverable>
React + TypeScript Vite app under `client/src/`, at minimum:
- `screens/Landing.tsx` (create or join)
- `screens/Waiting.tsx` (in room, peer not yet present, 10-min timeout state)
- `screens/Chat.tsx` (both present, three presence states)
- `screens/Unsupported.tsx` (below browser baseline)
- `store/useChatStore.ts`
- `services/CryptoService.ts` (keypair, encrypt/decrypt, SAS derivation [v2])
- `services/SocketService.ts` (lifecycle, backoff, ack handling)
- `services/WipeService.ts` (layered beforeunload / pagehide / visibilitychange)
- `services/CaptureService.ts` [v4] (capability detection, native bridges)
</deliverable>
