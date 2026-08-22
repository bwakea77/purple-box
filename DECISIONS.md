# Purple Box — Decisions & Roadmap

**Status:** Draft v1, derived from the 50-question intake.
**Companion to:** `ARCHITECTURE.md`, `room-client_spec.md`, `room-server_spec.md`, `ephemeral-buffer_spec.md`

Currency note: USD figures converted at ~2,600 TZS/USD. Rate fluctuates — treat TZS as indicative.

---

## 0. Three architectural facts that constrain everything below

**0.1 — E2E encryption forecloses content moderation.** The server sees `cipherText` only. Keyword detection, automated room termination on banned phrases, and any form of content scanning are impossible without removing end-to-end encryption. This document assumes E2E is kept. Every abuse-mitigation measure below therefore operates on *metadata and behaviour*, never content.

**0.2 — Bandwidth, not CPU, is what makes 1M concurrent users expensive.** At target scale the message relay pushes ~120 TB/month. On AWS that is ~$5,400/month in egress alone before a single instance is paid for. On Hetzner/OVH it is effectively free (included traffic allowances). This single fact should drive the hosting decision.

**0.3 — Routing both peers of a room to the same server process eliminates the hardest scaling problem.** Rather than adding a Redis pub/sub adapter so instances can relay to each other, hash `roomId` at the load balancer so slotA and slotB always land on the same instance. Relay stays in-process. Details in §4.2.

---

## 1. Scale, cost, and hosting

### 1.1 Capacity tiers and real monthly cost

| Tier | Concurrent users | Infrastructure | Hetzner/OVH | AWS/GCP equivalent |
|---|---|---|---|---|
| **T0** — MVP | ≤ 5,000 | 1× 4vCPU/8GB VPS, Redis on same box | ~$28/mo (~73k TZS) | ~$120/mo (~312k TZS) |
| **T1** — Early traction | ≤ 50,000 | 3× app instances, dedicated Redis, LB | ~$150/mo (~390k TZS) | ~$600/mo (~1.6M TZS) |
| **T2** — Scale | ≤ 250,000 | 10× app, Redis cluster, 2 regions | ~$550/mo (~1.4M TZS) | ~$2,800/mo (~7.3M TZS) |
| **T3** — Target | 1,000,000 | 40× app, Redis cluster, 3 regions, ~120 TB egress | ~$1,600/mo (~4.2M TZS) | ~$8,500/mo (~22M TZS) |
| **T3-WebRTC** | 1,000,000 | Signaling-only fleet + TURN for ~15% of peers | ~$400/mo (~1M TZS) | ~$1,900/mo (~5M TZS) |

**Answer to Q4 (self-host vs managed):** Self-hosting on commodity VPS scales to the full 1M target technically — there is no capability ceiling that forces managed cloud. The reason to pay for managed services is *operational burden*, not capacity. Recommendation: run the socket fleet on Hetzner or OVH (bandwidth economics are decisive), and only pay for managed Redis if you lack the operational capacity to run it yourself. A hybrid — self-hosted app fleet, managed Redis — is the pragmatic middle.

**Answer to Q3 (budget scaling with usage):** The tier table above is deliberately structured so each tier is a discrete step you take only when the previous tier saturates. Instrument the concurrency counter (§6.1) and set alarms at 70% of tier capacity so you upgrade ahead of the wall, not after hitting it.

### 1.2 Latency target (Q5)

There was no stated target, so here is a defensible one:

| Path | p50 | p95 | p99 |
|---|---|---|---|
| Same-region, both peers `IN_CHAT` | < 60 ms | < 150 ms | < 300 ms |
| Cross-region | < 180 ms | < 400 ms | < 700 ms |
| Buffered → flushed on reconnect | n/a (bounded by reconnect, not relay) | | |

Rationale: below ~150 ms a chat feels instant. Above ~400 ms users start double-sending. These are *server relay* budgets and exclude the user's own network last mile, which in much of East Africa on mobile adds 40–120 ms on its own — another argument for a regional presence rather than routing all Tanzanian traffic to Frankfurt.

### 1.3 Capacity overflow strategy (Q8)

You asked for a queue, and asked how to avoid hitting it often. A queue is the wrong primitive here — a chat that starts 40 seconds late is a chat that doesn't happen. Better layered approach:

1. **Rebalance, don't queue.** Your instinct in Q8 ("shift places and check a new empty space") is correct and is the standard fix. New room creation is routed to the *least-loaded* instance, not round-robin. An instance at 85% capacity stops accepting new rooms but keeps serving existing ones.
2. **Autoscale ahead of demand.** Trigger a new instance at 70% fleet utilisation. Provisioning takes 60–120 s, so the trigger must lead the curve.
3. **Only then, a soft wall.** If the entire fleet is saturated, show an explicit "at capacity, try again in a moment" screen with a retry button. Never an infinite spinner — that violates the existing `room-client` acceptance criteria.

Existing rooms are never evicted to make space. A room in progress outranks a room being created.

---

## 2. Security and cryptography

### 2.1 Threat model (Q9)

"Protect from anything malicious" is not a threat model — it is a goal. A threat model names specific adversaries and states which ones you defend against. Here is the concrete version:

| Adversary | Defended? | How |
|---|---|---|
| Passive network eavesdropper (ISP, wifi) | **Yes** | TLS 1.3 + E2E NaCl layer |
| Your own server operator, passively reading | **Yes** | Server holds no keys; only ciphertext transits |
| Your own server, *actively* MITM-ing key exchange | **Only with §2.3** | Server relays public keys and could substitute its own |
| Attacker who compromises Redis | **Yes** | Redis holds ciphertext only, TTL-bound |
| Attacker with the room link, racing to take slotB | **Partly** | Room locking (§2.5) closes it after both slots fill |
| Malicious peer (the person you're chatting with) | **No** | They can screenshot. Unsolvable. State it in the UI. |
| Compromised endpoint (malware on the user's device) | **No** | Out of scope for any web app |
| State-level traffic analysis (who talks to whom, when) | **No** | Would require cover traffic / mixnets. Out of scope. |

Be explicit publicly about the bottom three rows. Overclaiming security is how privacy products lose credibility permanently.

### 2.1.1 Screenshot / screen-recording detection — not prevention

Screenshots cannot be prevented on web, and only partially on native. This is worth designing for deliberately rather than leaving as an unaddressed gap in the threat model above.

**What's actually achievable:**

| Platform | Screenshot prevention | Screenshot detection | Screen-recording detection |
|---|---|---|---|
| Web (any browser) | No — no OS API exposes this to a page | No | No |
| Android < 14 | No | No official API | No |
| Android 14+ | `FLAG_SECURE` blocks capture entirely (native only, v4) | `ScreenCaptureCallback` | No reliable API |
| iOS (native, v4) | No API exists | `userDidTakeScreenshotNotification`, reliable | `capturedDidChangeNotification`, reliable |

Web (v1–v3) gets none of this. Native (v4) gets real prevention on Android 14+ and detection-only on iOS — and Android below 14, common on budget devices in this market, gets nothing either.

**The design risk this creates:** partial, uneven detection is worse than none if users can't tell which state they're in. A user on iOS who has seen "screenshot taken" alerts elsewhere will assume silence means no capture happened — when it may just mean their peer is on an undetectable platform. That's false confidence in a product whose entire pitch is "this disappears," and it's a sharper version of the same problem as shipping `FLAG_SECURE` without disclosure.

**The fix: declare capability per room, not per user, and never imply protection you don't have.**

- On `enter_chat`, each client reports whether it can detect capture (`screenshotDetection: boolean`), based on platform + OS version.
- The room is only in the "alerts on" state if **both** peers support it. One undetectable peer degrades the whole room, and both users see that — never a per-peer or silently-mixed state.
- Header shows one of two persistent states, not a dismissible toast: `Screenshot alerts: on for both` or `Screenshot alerts unavailable in this room`.
- When a capture is detected, both parties are notified — including the person who took it — rendered as a system entry inline in the transcript at its `seq` position, so it's anchored to *which messages* were visible, not just that *a* capture happened at some point.
- The baseline UI copy stays regardless of detection state: *"Screenshots can't be prevented. Only share what you'd accept being kept."* Detection is a norm-setting layer on top of that, not a replacement for it.

**What this still doesn't cover, and never will:** a second device photographing the screen produces no signal at all. Rooted/jailbroken devices can suppress the OS notification. This remains a detection feature against casual capture, not a security control — say so plainly wherever it's described publicly.

### 2.2 TLS (Q11)

Enforce at infra level, no exceptions:
- HTTP → HTTPS redirect at the load balancer, port 80 serving nothing but the redirect
- **HSTS** with `max-age=63072000; includeSubDomains; preload`, and submit to the preload list
- TLS 1.3 only; 1.2 as fallback with modern cipher suites only
- `Secure` + `SameSite=Strict` on any cookie
- Socket.io forced to `wss://` — reject `ws://` at the server, don't merely prefer

A stripped-TLS connection should be structurally impossible, not merely discouraged.

### 2.3 Key verification — the real gap (Q10)

**This is your most important security decision.** Right now the server relays public keys between peers. A compromised server could hand each peer *its own* key, decrypt everything, re-encrypt, and forward. Neither user would notice. Your E2E is only as trustworthy as your server, which defeats much of the point.

The fix is a **Short Authentication String (SAS)** — the Signal "safety number" pattern:

1. Derive a fingerprint from both public keys: `SHA-256(sort(pubKeyA, pubKeyB))`
2. Render the first 30 bits as either 5 words from a fixed wordlist, or 6 emoji from a fixed set
3. Both users see the identical string in the chat header
4. They compare it out-of-band — read it aloud on a phone call, or check it in person

If the strings match, no MITM. If they differ, someone is in the middle. This costs perhaps 80 lines of client code and no server changes, and it upgrades your threat model from "trust the server" to "verify the server." **Ship it in v2.**

Emoji rather than words is the better choice for a Tanzanian/multilingual audience — no wordlist translation problem, and comparison over a voice call still works.

### 2.4 Forward secrecy (Q12)

Current spec: fresh NaCl keypair per room entry, discarded on leave. That already gives you **forward secrecy between sessions** — compromising a key today reveals nothing about yesterday's chat, because yesterday's key no longer exists anywhere.

Per-message ratcheting (Double Ratchet) would additionally protect messages *within* a single session against a mid-session key compromise. Given your sessions are capped at ~1 hour (§4.5) and keys live only in browser RAM, the marginal benefit is small and the implementation complexity is large — Double Ratchet is genuinely difficult to get right, and a subtly broken ratchet is worse than a correct simpler scheme.

**Recommendation: keep per-session keypairs. Do not implement ratcheting.** Revisit only if you later add long-lived sessions or multi-day rooms. Spend the effort on SAS verification (§2.3) instead — it closes a real hole, whereas ratcheting closes a theoretical one.

### 2.5 Room locking (Q15) — **approved, spec change required**

Add `everFilled: boolean` to `RoomState`. Set `true` the moment both slots are simultaneously occupied. Once `true`, `join_room` rejects with `{success: false, error: 'room closed'}` regardless of slot vacancy. This closes the leaked-link hijack: after A and B have both been present, no third party can ever slip into a vacated slot.

Interacts with Q24 ("left room is permanently dead") — consistent, both point the same direction.

### 2.6 Rate limiting (Q13, Q14)

**Room creation — not per device.** Device fingerprinting is unreliable (users clear state, use multiple browsers), degrades under privacy-focused browsers, and requires exactly the tracking your product claims not to do. It also breaks legitimate use: an office, a university lab, or any Tanzanian mobile subscriber behind carrier-grade NAT shares an IP with hundreds or thousands of others.

Use instead:

| Layer | Rule | Rationale |
|---|---|---|
| Token bucket per IP | 5 rooms / 10 min, burst 3 | Catches naive scripts, tolerant of NAT |
| Proof-of-work challenge | Triggered above 3 rooms / 10 min from one IP | Costs a bot real CPU, costs a human ~1 s |
| Global circuit breaker | Halt all room creation if fleet-wide rate exceeds 10× the 7-day baseline | Blunt instrument against a determined flood |
| Empty-room reaping | Room with no second occupant expires in 10 min (§4.3) | Mass-spawned empty rooms self-clean |

The last row matters most: if empty rooms cost nothing and vanish quickly, mass-spawning them achieves nothing worth defending against.

**Message rate limiting:**
- 20 messages per 10 s burst, 5/s sustained, per socket
- Max `cipherText` size 4 KB (≈ 2 KB plaintext) — reject larger with an explicit error
- Exceeding the limit throttles rather than disconnects; disconnecting punishes fast typists

---

## 3. Abuse, safety, and legal

### 3.1 What you can and cannot do (Q16, Q17, Q22)

Given E2E, your available signals are metadata only: room creation rate, session duration, IP reputation, report volume against a given room. You cannot see content, and you should stop planning around the assumption that you might.

**What is genuinely available:**

| Mechanism | E2E-compatible? | Effectiveness |
|---|---|---|
| User-initiated report with voluntary transcript attachment | Yes | High — this is what Signal and WhatsApp actually do |
| In-chat block + immediate room termination | Yes | High for the individual case |
| IP/ASN reputation on room creation | Yes | Moderate; weak under CGNAT |
| Behavioural anomaly detection (creation rate, churn patterns) | Yes | Moderate, catches automation not individuals |
| Keyword scanning / automated room termination | **No** | Impossible — do not spec this |

**The reporting pattern to implement (v2):** a "Report" button in the chat UI. When pressed, the *reporting user's own client* — which holds decrypted plaintext in RAM — offers to attach its local transcript to the report. This is user-initiated disclosure by a legitimate participant, not server surveillance. It preserves E2E completely: the server never decrypts anything; a human participant voluntarily shares what they already lawfully hold. The report payload contains: reporter-supplied transcript (optional, explicit opt-in), `roomId`, timestamps, and both parties' IPs.

This is the only bridge between "we cannot see anything" and "we are not a black hole for abuse," and it is the mechanism app store reviewers expect to find.

### 3.2 On the "they trusted the link sender" argument (Q17)

Stated plainly because it will be tested publicly: grooming, sextortion, and coercive control operate *specifically* through links sent by trusted parties. The recipient's trust in the sender is the attack vector, not a mitigation. Ephemerality — no evidence, no history, nothing to show a parent or the police — is a feature for that adversary, not a bug.

This does not mean the project shouldn't exist. Ephemeral private messaging has enormous legitimate value: journalists and sources, medical and legal consultations, domestic violence survivors coordinating safely, people in jurisdictions where speech is punished. But the honest framing is "this tool has real dual-use risk and here is what we do about it," not "trust is implied by the link." Build the reporting path in §3.1, publish a clear abuse policy, and respond to reports quickly. That is a defensible position. The current one is not.

### 3.3 Age assurance (Q20)

You cannot verify age without identity, and identity destroys the product. Realistic options in ascending strength:

1. **Self-attestation gate** — "You must be 18+ to use Purple Box." Nearly worthless as a barrier, but it establishes intent and is what most services do.
2. **App store age rating** — rate 17+/Mature. The stores enforce parental controls on your behalf, which is meaningful coverage for the mobile path.
3. **Third-party age estimation** — cost and privacy cost both high. Not recommended at your stage.

Recommendation: (1) + (2). Document in ToS that the service is not intended for minors. Accept that this is a genuine, unclosed gap; every anonymous communication tool has it.

### 3.4 Enforcement without accounts (Q21)

IP banning in the Tanzanian market is particularly poor: Vodacom, Airtel, and Tigo all run carrier-grade NAT, so a single banned IP can represent thousands of subscribers. Ban an abuser and you may take out a neighbourhood.

Layered alternative, weakest to strongest:
- **Session-scoped block** — reported peer is immediately ejected, room destroyed. Instant, always available, no false positives.
- **Soft IP throttle** — a reported IP faces proof-of-work on every subsequent room creation for 24 h. Degrades the abuser's experience without cutting off co-NATted innocents.
- **ASN-level scrutiny** — datacentre/VPN ranges get stricter creation limits than residential mobile ranges. Catches automation, minimal collateral damage.
- **Hard IP ban** — reserve for confirmed severe abuse with corroborating evidence, time-boxed to 7 days, never permanent.

### 3.5 Legal and jurisdiction (Q18, Q19)

**I am not a lawyer and this needs Tanzanian counsel before launch.** What follows is engineering-relevant context, not legal advice.

Points that hold regardless of jurisdiction:
- Tanzania's Electronic and Postal Communications Act and its associated Online Content Regulations impose registration and content obligations on online content services. Whether a link-based ephemeral chat falls inside that definition is precisely the question to put to a local lawyer. My knowledge here may also be out of date — verify current text.
- **Jurisdiction shopping does not work the way Q19 assumes.** Your hosting provider's Acceptable Use Policy binds you wherever you incorporate. Your payment processor (Q38 — donations) will apply its own rules. Apple and Google apply their policies globally. Incorporating in a permissive jurisdiction changes very little about your actual operating constraints.
- CSAM reporting obligations are close to universal and are increasingly imposed on service providers regardless of encryption status. Have a documented process for handling such a report *before* you receive one.

**Practical minimum before public launch:** Terms of Service, Acceptable Use Policy, Privacy Policy (which for you is refreshingly short), a published abuse contact address, and a documented internal response process. Register the business — a personal project taking donations and handling abuse reports is an unnecessary personal liability exposure.

---

## 4. Product, reliability, and edge cases

### 4.1 Roadmap-relevant product decisions

| Q | Decision | Version |
|---|---|---|
| 23 — Waiting timeout | **10 minutes**, then room expires with "no one joined" screen | v1 |
| 24 — Re-enter after leave | **Permanently dead.** Consistent with §2.5 room locking | v1 |
| 25 — Mutual end-chat | Not implemented; unilateral leave only | — |
| 26 — Typing indicators | **Safe to add.** See below | v2 |
| 27 — Left vs. disconnected | **Must fix.** See below | v1 |
| 28 — QR code | Skipped per your answer | — |
| 29 — Tab-close warning | **Yes**, `beforeunload` confirm | v1 |

**On typing indicators (Q26):** They leak timing metadata, but your server already sees message timing — a typing event reveals nothing new to the server operator. The genuine cost is bandwidth: naive implementations fire an event per keystroke, which at 1M users is more traffic than the messages themselves. Implement with a 2-second debounce and a 5-second auto-clear and it's negligible. No meaningful privacy objection.

**On left vs. disconnected (Q27) — this is a real UX bug, not a nice-to-have.** The server already distinguishes these states (`peer_left` event vs. `presence: 'DISCONNECTED'`), but the client currently renders them identically. A user who sees "peer gone" during a 30-second tunnel blackout will close the tab and destroy a conversation that was about to resume. Required client states:
- `PEER_IN_CHAT` — normal
- `PEER_RECONNECTING` — "Reconnecting…" with a visible countdown against the 60 s grace window
- `PEER_LEFT` — "They left. This room is closed."

### 4.2 Cross-instance relay — recommended approach (Q6, Q7)

You asked for the best option rather than picking one. Two viable designs:

**Option A — Redis pub/sub adapter (`@socket.io/redis-adapter`).** The conventional answer. Every instance subscribes to a Redis channel; emits fan out across the fleet. Well-trodden, heavily documented. Cost: every message makes an extra Redis round trip, adding 1–3 ms and roughly doubling Redis ops. At 33k msg/s that is meaningful load.

**Option B — roomId-affinity routing (recommended).** Because `roomId` is in the URL before the socket connects, the load balancer can hash it and route both peers of a room to the same instance deterministically. Relay stays entirely in-process. No pub/sub, no extra Redis round trip, no cross-instance latency.

Option B is better for this specific workload because your rooms are strictly 2-party and short-lived — the pathological case for consistent hashing (long-lived state that must survive rebalancing) barely applies when sessions cap at an hour. Handle instance failure by letting clients reconnect; the 60 s grace window plus buffer flush already covers it.

**Recommendation: build Option B, but keep the adapter as a documented fallback.** Critically, *design for this in v1 even though you deploy single-instance* — keep all room state in Redis rather than process memory, and never assume in-process locality in handler code. Retrofitting statelessness later is expensive; writing it correctly from the start is nearly free.

### 4.3 nanoid collision risk (Q30) — **you were right to ask, current spec is inadequate**

`nanoid(8)` with the default 64-character alphabet gives 64⁸ ≈ 2.8 × 10¹⁴ possible codes. Birthday-bound collision probability at N concurrent rooms is approximately N²/(2 × 2.8 × 10¹⁴):

| Concurrent rooms | Collision probability |
|---|---|
| 10,000 | ~1 in 5,600,000 |
| 100,000 | ~1 in 56,000 |
| **500,000 (your target)** | **~1 in 2,200** |

One in 2,200 sounds small but it is a *steady-state* probability — evaluated continuously, you would see collisions regularly at target scale, and each one silently merges two strangers' conversations. Unacceptable.

**Fix — both parts required:**
1. **`nanoid(12)`** → 64¹² ≈ 4.7 × 10²¹, collision probability at 500k rooms ≈ 1 in 4 × 10¹⁰. Effectively never. The code stays short enough to share comfortably.
2. **Atomic create regardless.** Use Redis `SET key value NX EX ttl` and retry on failure. Never `GET`-then-`SET` — that race exists independent of code length and becomes reachable the moment you run more than one instance.

Also exclude visually ambiguous characters (`0`/`O`, `1`/`l`/`I`) from the alphabet if codes will ever be read aloud or typed manually.

### 4.4 Concurrent disconnect of both slots (Q31)

Each slot needs its own independent grace timer, keyed `grace:{roomId}:{slot}`, with its own TTL. Room teardown is triggered only when *both* slots are confirmed vacant — either explicit `leave_chat` or grace expiry. Implement teardown as an idempotent function called from both paths; calling it twice must be harmless.

Failure mode to test explicitly: both peers on the same wifi network, router reboots, both disconnect within the same second. Both grace windows run in parallel; if both reconnect the room resumes intact with buffers flushed for each; if neither does, the room is reaped once at the 60 s mark, not twice.

### 4.5 Session lifetime (Q32)

You suggested one hour. Recommendation — a two-timer model rather than a single hard cap:

- **Idle timeout: 30 minutes** with no messages from either party → room closes with warning at 25 minutes
- **Hard cap: 4 hours** regardless of activity → 5-minute warning, then close

A one-hour hard cap would cut off a genuinely engaged conversation mid-sentence, which users experience as a bug. The idle timeout is what actually reclaims abandoned rooms, and it does so far faster than an hour. The hard cap exists to bound worst-case resource holding, not to police conversation length.

### 4.6 The message buffer, explained (Q33)

You asked what the 20-message cap means. Plainly:

When your peer's connection drops briefly — they walked into a lift, their phone switched from wifi to mobile data — the server doesn't immediately give up. For 60 seconds it holds any messages you send in a small waiting area in Redis, hoping they reconnect. If they do, everything held gets delivered at once. If they don't, it's discarded.

That waiting area holds at most 20 messages. If you send a 21st while they're still offline, the *oldest* one is pushed out to make room.

**Decision: tell the sender.** Silent loss is the worst outcome — you believe something was delivered when it wasn't. Once the buffer is full, subsequent sends return `{success: false, error: 'peer offline, message not delivered'}` and the client renders that message with a visible failed state and a retry option. Never show a checkmark for a message that was dropped.

Consider raising the cap to 50; the memory cost is negligible (50 × ~500 B × concurrent disconnected rooms) and it covers a more realistic burst.

### 4.7 Redis failure (Q34)

Graceful degradation is correct, but it needs definition. Three failure behaviours:

| Redis state | Existing chats | New rooms |
|---|---|---|
| Healthy | Normal | Normal |
| Down, in-process cache warm | **Continue working** — relay is in-process under §4.2 | **Rejected** with explicit error |
| Down, cache cold (instance restarted) | Lost | Rejected |

This requires each instance to maintain a write-through in-memory cache of the `RoomState` for rooms it currently serves. Redis remains the source of truth; the local cache is what lets an active conversation survive a Redis blip. Add a `/health` endpoint that reports Redis reachability separately from process health, so the LB stops sending *new* rooms to an instance whose Redis is unreachable while letting it drain existing ones.

### 4.8 Client reconnect behaviour (Q35)

Exponential backoff with jitter, bounded by the server's grace window:

```
attempt 1:  500 ms  ± 20% jitter
attempt 2:  1 s
attempt 3:  2 s
attempt 4:  4 s
attempt 5+: 8 s (capped)
total budget: 60 s, then give up and show PEER_LEFT
```

Jitter is essential — without it, a fleet-wide blip causes every client to reconnect in lockstep and you thundering-herd your own recovery. Messages composed during a disconnect stay in `pending` state locally and flush on reconnect; messages already sent stay `pending` until an ack arrives.

### 4.9 Reconnect race testing (Q36)

Not tested, and this is the highest-risk untested path in the system. Your own architecture states reordering and duplication are unacceptable while loss is tolerable — so these are the tests that matter most. Required cases:

1. Peer reconnects at t=59.5 s, one message in buffer → delivered exactly once
2. Peer reconnects at t=60.5 s (just after expiry) → clean `PEER_LEFT`, no zombie state
3. Old socket's `disconnect` event fires *after* the new socket's `enter_chat` → must not vacate the newly occupied slot
4. Both peers reconnect simultaneously → both buffers flush, sequence order preserved across both
5. `flushBuffer` called twice concurrently → second returns empty, no double delivery
6. Sequence counter continuity across reconnect → strictly monotonic, no reuse

Case 3 is the classic bug in this pattern and will bite you. Guard it by storing `socketId` in `SlotState` and ignoring disconnect events whose `socketId` no longer matches the current occupant.

---

## 5. Business and positioning

### 5.1 Monetisation options beyond donations (Q38)

| Model | Fit | Notes |
|---|---|---|
| Donations | Good | Low yield. Realistically covers T0–T1 hosting, not more |
| Supporter tier | Good | Longer session caps, custom room codes, priority capacity. Buy a redeemable code so payment stays decoupled from identity |
| Self-host licence for organisations | **Best fit** | NGOs, law firms, newsrooms, clinics pay for a deployable instance. Preserves the privacy story completely, and it's the buyer with actual budget |
| Sponsorship | Moderate | Digital rights organisations sometimes fund infrastructure of this kind |
| Ads | **Reject** | Fundamentally incompatible with the positioning. Do not |

The self-host licence deserves serious thought — a Tanzanian or regional NGO handling sensitive casework has both a real need and a budget line, and selling to them requires no compromise of the consumer product.

### 5.2 Competitive landscape (Q40) — knowledge limits apply

**I cannot search the web in this conversation, and my knowledge ends around May 2026.** Verify all of this independently before making decisions on it.

From what I know, the space divides into three groups:

**Established encrypted messengers** — Signal, Threema, Session, Briar. All require an install; most involve some persistent identity. They are not really your competitors; they solve a different problem (ongoing relationships).

**Browser-based ephemeral chat** — this is your actual category, and it is thin. Darkwire.io is the closest open-source comparable; Cyph occupies similar ground commercially. Cryptocat, the best-known historical entrant, is discontinued. The category is thin partly because monetisation is hard, which is a warning as much as an opportunity.

**One-way secret sharing** — PrivateBin, Yopass, Bitwarden Send. Adjacent but not chat.

**Honest assessment:** encryption itself is not a differentiator — it is table stakes and freely available in libraries. Your defensible differentiators are (a) zero friction: no install, no account, works on a low-end Android over a 3G connection, which matters enormously in your market and is under-served by tools built for San Francisco; and (b) a specific vertical where ephemerality is a requirement rather than a preference. Journalist-source contact, medical or legal consultation, HR whistleblowing, NGO casework.

The generic consumer play against Signal is not winnable. A regionally-focused, low-bandwidth, install-free tool aimed at a named professional use case is a real business. Pick the vertical before building the landing page (Q39).

---

## 6. Observability and operations

### 6.1 Telemetry (Q42) — recommended position

"Zero telemetry ever" is a purity position that costs you the ability to know whether your product works. Anonymous aggregate counters carry no meaningful privacy cost and are worth taking.

**Collect (all aggregate, no identifiers, no `roomId`):**
- Rooms created per hour
- Concurrent sessions (gauge)
- Median and p95 session duration, bucketed
- Messages relayed per second (count only, never size or content)
- Buffer flush rate, buffer overflow rate
- Error counts by type
- Reconnect success rate

**Never collect:** `roomId`, IP in any retained metric, nicknames, ciphertext, message sizes (a size distribution can fingerprint content), per-room anything.

The rule that keeps this clean: a metric is acceptable only if it remains identical when a single user is removed from the population. Publish exactly what you collect — a transparency page is cheap and builds the trust the product is selling.

### 6.2 Outage detection (Q43)

Infrastructure-level, entirely independent of user activity:
- `/health` endpoint per instance returning process, Redis, and memory status
- External synthetic monitor (UptimeRobot, Healthchecks.io, or self-hosted) that creates a room, joins both slots, sends a message, verifies delivery, and tears down — every 60 s from at least two geographic locations
- Alert on: synthetic failure, p95 latency breach, error rate above baseline, instance count below expected, Redis memory above 80%

The synthetic end-to-end check is the important one. Process-level health checks will happily report green while message relay is completely broken.

### 6.3 Error tracking with content safety (Q44)

Sentry is fine, but requires deliberate scrubbing since a careless error report is the single most likely way plaintext escapes your system.

Required controls:
1. **`beforeSend` hook** that strips any field named `text`, `cipherText`, `message`, `plaintext`, `nickname`, or `content` at any nesting depth
2. **`denyUrls` / PII controls** — disable `sendDefaultPii`, disable breadcrumb capture of input events (Sentry captures keystrokes into form fields by default; this alone could leak messages)
3. **Never interpolate message content into error strings.** `throw new Error('decrypt failed for ' + text)` defeats every other control. Enforce by code review and a lint rule
4. **Redact `roomId`** to a salted hash in error reports — you can still correlate reports without holding the code
5. **Session replay: off.** Non-negotiable
6. **Test the scrubbing** by deliberately throwing an error containing a known sentinel string and confirming it does not appear in the Sentry dashboard

### 6.4 Zero-downtime deploys (Q45)

Rolling restart with connection draining, which works especially well for you because the client already handles reconnection:

1. Instance receives SIGTERM
2. Immediately deregisters from the LB — no new rooms routed to it
3. Emits a `server_restarting` event to connected clients, prompting immediate reconnect to a healthy instance
4. Waits for connections to drain, up to a 90 s deadline
5. Exits

Because room state lives in Redis and the grace window is 60 s, a user experiences at most a brief "Reconnecting…" indicator. Deploy one instance at a time with a health check gate between each. Never deploy all instances simultaneously — that turns a routine deploy into a fleet-wide reconnect storm.

---

## 7. Platform and compatibility

### 7.1 Mobile web (Q46) — must be first-class

For your market this is not a preference. Most users will arrive on Android Chrome, many on mid-range or low-end devices over mobile data. Design mobile-first.

**The critical technical caveat:** `beforeunload` is unreliable on mobile. iOS Safari frequently does not fire it; Android Chrome skips it when the app is backgrounded and later killed. Your `room-client` spec currently relies on it for wipe-on-leave.

Correct layered approach:
```
beforeunload   → desktop confirm dialog (Q29) + wipe attempt
pagehide       → the reliable mobile signal; wipe here
visibilitychange → start a timer on hidden; wipe after 5 min hidden
Server grace window → the actual guarantee; client-side is best-effort
```

The server-side 60 s grace window plus Redis TTL is what genuinely guarantees cleanup. Client-side wipe protects the *user's own screen*; it cannot be the mechanism you rely on for correctness.

Also budget for: virtual keyboard resizing the viewport, `100vh` misbehaving on mobile Safari (use `100dvh`), and tap targets sized for thumbs.

### 7.2 Browser support (Q47) — pushing back on "support everything"

"Support everything" is expensive and buys you almost nothing. tweetnacl requires `Uint8Array` and typed arrays; Socket.io v4 requires a modern event loop; your Vite build targets ES modules. Supporting Internet Explorer or Android 4 would mean polyfill weight that makes the app *slower for the 99.5% on modern browsers*, on the exact low-bandwidth connections you care about.

**Recommended baseline:** browsers released from 2020 onward — Chrome 80+, Safari 13.1+, Firefox 78+, Samsung Internet 12+. That covers essentially all active Android and iOS devices in your market, including older budget handsets.

Below baseline: show a clear "your browser is not supported, please update" page rather than a broken app. Detect via a tiny ES5 script that runs before the main bundle.

### 7.3 PWA and native (Q48)

You want web and mobile app simultaneously. Sequence rather than parallelise:

- **v2 — PWA.** Installable, home screen icon, offline shell. Cheap, since it's the same codebase. Covers most of the "feels like an app" benefit
- **v4 — native wrapper.** Capacitor is the pragmatic choice given the existing React codebase. Note that this triggers all the app store requirements in §3.1 — build the reporting mechanism *before* you need it, not during review

Do not build a separate React Native app. Two codebases for one product at your stage is a mistake.

---

## 8. Roadmap and scope

### 8.1 Group chat (Q49)

Confirmed as post-v1. Be aware this is not an incremental change: the `slotA`/`slotB` model, the 1:1 key exchange, and the relay logic all assume exactly two parties. Group E2E requires either pairwise encryption to every member (n² key operations, workable at n=4) or a proper group ratchet like MLS (substantially harder).

**Recommendation:** if group chat is genuinely on the roadmap, replace `slotA`/`slotB` with a `slots: SlotState[]` array capped at 2 *in v1*. The code is barely different, and it avoids a painful refactor of every handler later. Do this now.

### 8.2 File and image sharing (Q50)

You asked what it would take. Three approaches:

| Approach | Preserves no-storage philosophy? | Effort | Notes |
|---|---|---|---|
| Relay through server, encrypted, never written to disk | Partly — transits memory | Medium | Simple but multiplies your bandwidth cost dramatically |
| Buffer in Redis with short TTL | Weakly | Low | Contradicts the buffer's design intent; Redis is not a blob store |
| **WebRTC DataChannel, peer-to-peer** | **Fully** | High | File never touches your server at all |

WebRTC is the right answer, and it has a much larger implication.

### 8.3 The WebRTC option — worth serious consideration

If you move the *message* path to WebRTC DataChannels, your server becomes signaling-only: it introduces the two peers, then steps out. Consequences:

- **Server bandwidth drops by roughly 90%** — see the T3-WebRTC row in §1.1. Your 1M-user target becomes affordable, which is otherwise the main obstacle
- **Stronger privacy story** — messages genuinely do not transit your infrastructure; the MITM concern in §2.3 largely evaporates
- **Cost:** NAT traversal fails for roughly 10–20% of peer pairs, requiring a TURN relay fallback, and TURN carries real bandwidth cost. Mobile-to-mobile across different carriers — common in your market — is a frequent TURN case
- **Complexity:** meaningfully harder than Socket.io relay, with a longer connection setup and more failure modes

**Recommendation:** keep Socket.io relay for v1–v2 where correctness and shipping speed matter. Prototype WebRTC in v3 with Socket.io as automatic fallback. If it works, it's your path to the 1M target and to file sharing simultaneously.

---

## 9. Version plan

### v1 — Correct MVP (target: 6 weeks, ≤5,000 concurrent)

Goal: a correct, secure, single-instance app that proves the concept.

| Area | Scope |
|---|---|
| Core | Create/join room, 2 slots, live relay, per-session NaCl keypairs |
| Codes | **nanoid(12)**, unambiguous alphabet, atomic `SET NX` create |
| Slots | **`slots: SlotState[]` array capped at 2** (§8.1) |
| Locking | **`everFilled` flag; room dead after both slots filled** (§2.5) |
| Timeouts | Waiting 10 min · idle 30 min · hard cap 4 h |
| Presence | **Three distinct client states: in-chat / reconnecting / left** (§4.1) |
| Buffer | 60 s TTL, cap 50, **explicit failure to sender on overflow** (§4.6) |
| Reconnect | Exponential backoff with jitter, 60 s budget (§4.8) |
| Wipe | `beforeunload` + `pagehide` + `visibilitychange` layered (§7.1) |
| Rate limits | Token bucket per IP, message rate + size caps (§2.6) |
| TLS | HSTS, preload, wss-only (§2.2) |
| State | **All room state in Redis, no process-memory assumptions** — enables §4.2 later |
| Tests | The six reconnect race cases in §4.9 |
| Infra | 1× VPS, Redis co-located, ~$28/mo |

Explicitly not in v1: multi-instance, SAS verification, reporting, PWA, typing indicators, telemetry beyond error tracking.

### v2 — Trustworthy and launchable (target: +8 weeks, ≤50,000 concurrent)

| Area | Scope |
|---|---|
| Crypto | **SAS / emoji safety-number verification** (§2.3) — the flagship v2 feature |
| Safety | **Report button with voluntary transcript attachment** (§3.1) |
| Safety | In-chat block, session-scoped enforcement (§3.4) |
| Legal | ToS, AUP, Privacy Policy, abuse contact, business registration (§3.5) |
| Ops | Anonymous aggregate telemetry (§6.1), synthetic monitoring (§6.2), Sentry with scrubbing (§6.3) |
| Ops | Rolling deploys with draining (§6.4) |
| UX | PWA, typing indicators, landing page, brand |
| Infra | 3 instances behind LB, dedicated Redis, ~$150/mo |

v2 is the point at which public launch is defensible. Do not launch publicly before the reporting mechanism and the legal documents exist.

### v3 — Scale (target: +12 weeks, ≤250,000 concurrent)

| Area | Scope |
|---|---|
| Routing | **roomId-affinity load balancing** (§4.2), fleet autoscaling |
| Capacity | Least-loaded room placement, soft capacity wall (§1.3) |
| Geography | Second region, latency-based routing |
| Resilience | Redis cluster, in-process write-through cache (§4.7) |
| R&D | **WebRTC DataChannel prototype with Socket.io fallback** (§8.3) |
| Infra | ~10 instances, 2 regions, ~$550/mo |

### v4 — Target scale and expansion (target: +6 months, 1,000,000 concurrent)

| Area | Scope |
|---|---|
| Transport | WebRTC primary if v3 prototype succeeded; TURN fleet |
| Platform | Capacitor native wrapper, app store submission (§7.3) |
| Features | File/image sharing over DataChannel (§8.2), small-group chat 3–4 (§8.1) |
| Geography | Third region |
| Business | Self-host licence offering (§5.1) |
| Safety | Screenshot/screen-recording detection — `FLAG_SECURE` on Android 14+, notification-based on iOS, per-room capability declaration (§2.1.1) |
| Infra | ~$400/mo with WebRTC, ~$1,600/mo without |

---

## 10. Required amendments to existing specs

Concrete diffs to apply to your three spec files.

### `ARCHITECTURE.md`
- `RoomState`: replace `slotA`/`slotB` with `slots: SlotState[]` (max length 2)
- `RoomState`: add `everFilled: boolean`
- `RoomState`: add `createdAt` hard-cap enforcement and `lastActivityAt` for idle timeout
- Room code generation: `nanoid(8)` → `nanoid(12)` with unambiguous alphabet
- Add a non-goal: "no content-based moderation is possible under E2E — abuse handling is metadata and user-report based"
- `SlotState`: add `screenshotDetection: boolean` (client-reported capability, set on `enter_chat`)
- Add a non-goal: "screenshot/screen-recording prevention is not possible on web and only partial on native — the product detects and discloses, it does not prevent"

### `room-server_spec.md`
- Add: `enter_chat` payload gains `screenshotDetection: boolean`; server computes room-level capability as AND of both slots and includes it in `conversation_waiting`/chat-state payloads
- Add: new event `screenshot_taken { roomId }` (client→server, fire-and-forget) → server assigns `seq`, relays as `peer_screenshotted { seq }` to both peers (v4)
- Add: room locking on `everFilled` (§2.5)
- Add: rate limit rules for `create_room` and `send_message` (§2.6)
- Add: buffer overflow returns explicit failure rather than silent drop (§4.6)
- Add: `socketId` match check before honouring a disconnect event (§4.9 case 3)
- Add: idle 30 min / hard 4 h session timers (§4.5)
- Add: `/health` endpoint reporting Redis reachability separately (§4.7)
- Add: `report_abuse` event handler (v2)
- Amend: state that all room state must live in Redis with no process-memory assumptions

### `room-client_spec.md`
- Amend: wipe triggers to layered `beforeunload` + `pagehide` + `visibilitychange` (§7.1) — promote `visibilitychange` from stretch goal to required for mobile
- Add: three distinct peer presence states with countdown UI (§4.1)
- Add: reconnect backoff schedule with jitter (§4.8)
- Add: failed-message state and retry affordance (§4.6)
- Add: SAS verification UI (v2)
- Add: browser baseline check with unsupported-browser page (§7.2)
- Add: explicit Sentry breadcrumb suppression on message input fields (§6.3)
- Add: persistent header state for screenshot-alert capability (`on for both` / `unavailable`), never a per-peer or dismissible indicator (§2.1.1, v4)
- Add: inline system-entry rendering of `peer_screenshotted` at its `seq` position, shown to both peers (§2.1.1, v4)
- Add: native-only `FLAG_SECURE` toggle (Android 14+) and OS notification listeners for screenshot/recording (iOS) (§2.1.1, v4)

### `ephemeral-buffer_spec.md`
- Amend: buffer cap 20 → 50
- Amend: `createRoom` must use `SET NX` atomically with retry on collision (§4.3)
- Add: `flushBuffer` must be idempotent — concurrent calls return empty on the second (§4.9 case 5)
- Add: per-slot grace timer keys `grace:{roomId}:{slot}` (§4.4)

---

## 11. Open items requiring your decision

1. **Vertical focus** (§5.2) — which named use case are you building for? This determines the landing page, the feature priorities, and whether the business works.
2. **Legal counsel** (§3.5) — engage a Tanzanian lawyer on the EPOCA/Online Content Regulations question before public launch. This is a genuine blocker for v2.
3. **Hosting provider** (§1.1) — Hetzner and OVH are strongly indicated by the bandwidth economics, but confirm latency from Dar es Salaam to their nearest region is acceptable against the §1.2 targets.
4. **WebRTC commitment** (§8.3) — the 1M target is roughly 4× cheaper with it, but it is a significant complexity increase. Decide before v3 planning.
5. **Buffer cap and session timers** — the numbers in §4.5 and §4.6 are my recommendations, not derived from your constraints. Override them if you have a reason.
