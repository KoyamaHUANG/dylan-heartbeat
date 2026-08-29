# Raw Chat Archive V1A design

## Scope

V1A is an append-only PostgreSQL factual archive for Dylan Heartbeat Kelivo
conversations from the day it is enabled. It records real `user`, normal
gateway `assistant`, and successfully delivered Heartbeat proactive assistant
messages. It is not `enhanced_messages.json`, Ombre Brain, an embedding store,
summary system, ranking system, deletion policy, or V1B historical importer.

The runtime rule is **CHAT FIRST, ARCHIVE SECOND**. Archive work is
background work. Its errors are content-free structured logs and must never
become a chat, stream, Heartbeat, Bark/ntfy, sync, or binding error.

## Existing flow reviewed

`POST /v1/chat/completions` currently:

1. Logs a safe request summary, validates optional
   `X-Kelivo-Conversation-Id`/`X-Kelivo-Assistant-Id`, and updates the
   current sync binding only when the final real message is a user message.
2. Updates timestamp memory only for content timestamps and the latest real
   user's first receipt. Historical rolling-context entries are never assigned
   the current time.
3. Builds `enhanced_messages.json` for current context assistance and keeps
   its system prompt plus only the last 49 non-system entries. It remains an
   independent rolling-context helper, never an archive.
4. Preserves compatible multimodal content for the upstream, injects special
   wake events, removes invalid tool-call runs, and forwards to
   `TARGET_API_URL`.
5. Returns a non-stream upstream body unchanged; for SSE it writes every
   upstream byte to Kelivo as it arrives.

Archive observes the original Kelivo request and the actual completion only.
It does not alter timeline length, upstream messages, model configuration, or
upstream response bytes.

## Conversation identity

Normal Kelivo chat supplies the existing validated conversation header and an
optional assistant header. V1A archives only a valid bound conversation.
Headerless legacy calls continue to work without change and emit a safe
`archive_chat_skipped` reason: inventing a conversation ID would make exact
history retrieval unreliable. The existing `kelivo_sync_context` remains the
source for Heartbeat's valid proactive binding; it is never used to guess a
missing chat header.

## PostgreSQL model

`migrations/001_initial.sql` creates:

* `archive_messages`: UUID message identity, conversation/assistant identity,
  role, `content_text`, safe `content_json`, source, UTC `message_time`, UTC
  `observed_at`, monotonic conversation `sequence`, diagnostic fingerprint,
  optional `turn_key`, optional `external_event_id`, confirmation and
  reconciliation fields, metadata, and UTC audit timestamps.
* `archive_turns`: one observed user turn and its actual gateway assistant
  completion; unique `(conversation_id, request_key)`, predecessor sequence,
  request-context digest, status, and message UUID links.
* `archive_conversations`: an atomic next-sequence counter, avoiding races
  from Windows and iPhone concurrently writing one conversation.
* `archive_reconciliation_conflicts`: content-free evidence for a window that
  cannot be proven to align; it is not a hidden hash-dedupe table.

Indexes cover `(conversation_id, message_time)`,
`(conversation_id, sequence)`, assistant ID, request key, and a partial unique
non-null `external_event_id`. `turns` is intentionally used: it makes retry
handling, stream pairing, and incomplete turn diagnosis reliable without
using a content hash as message identity.

## Content and privacy

String content is retained as text. Array/multimodal content uses the existing
`normalizeContentToText()` for `content_text` and stores a structurally
preserved `content_json`. Image data URLs are replaced there with MIME type,
byte estimate, SHA-256, and a placeholder: base64 is never copied into
PostgreSQL. Normal URLs, text parts, and descriptions remain available. The
upstream receives the original multimodal payload unchanged.

Archive logs event names, role, count, binding flags, durations, and error
categories only. It never logs content, system prompts, credentials,
database URLs, keys, raw messages, or base64.

## Live turns, rolling windows, and retries

Only a final real user message starts a live turn. System/tool messages and
internal special-event markers are not archived as ordinary chat. On the first
V1A request for a conversation, visible real messages before that anchor are
written once as `initial_context_seed` in visible order. Their `message_time`
is a parsed/remembered time only when proven; otherwise it is `NULL` and
`observed_at` records gateway observation. The latest user is then recorded as
`kelivo_live_user` at gateway receipt time. V1B owns the older complete import.

For an existing conversation, V1A compares the current visible pre-anchor
window to the tail of the archived ordered message stream. A reliable
multi-message, role-and-content, ordered suffix/prefix overlap confirms the
existing rows; only an unmatched suffix is added as `reconciled_context`.
A full overlap writes no rolling-context rows. Comparison is tied to the
conversation tail and order, not to one message text, so the same window from
Windows and iPhone safely reconciles.

Each turn gets `request_key = hash(conversation, assistant, predecessor
sequence, ordered request window, latest user)`. `archive_turns` stores this
key plus a complete request-context digest. A short, exact repeat uses the
known turn and does not insert a second user/assistant pair. This is a request
turn identity, not a unique key on `role + content`.

Two actual `嗯` user messages remain distinct: the normal second one has a
different predecessor sequence and hence a different turn key. The same is
true of repeated assistant short replies. Fingerprints exist only for
diagnostics/reconciliation, never as global unique message keys.

Kelivo currently has no client request UUID or per-message UUID. Therefore an
exact full-window replay within the retry interval cannot be mathematically
distinguished from an immediate identical new turn. V1A performs bounded retry
dedupe for that common transport case and records an explicit reconciliation
audit record instead of claiming proof. Outside that window, or with an
insufficient/ambiguous overlap, it retains a new conflict-marked turn rather
than silently discarding history using content hash. A later optional Kelivo
request ID can eliminate this protocol ambiguity without schema changes.

`confirmed` means directly observed on the gateway path or later observed in
an aligned context. `reconcile_status` distinguishes `direct`, `seeded`,
`reconciled`, and `conflict`.

## Assistant and proactive write paths

The user capture is scheduled as soon as a valid request arrives, but it is
not awaited before upstream forwarding. After a successful non-stream body is
read, a copy is parsed only to extract assistant text; the original body is
still returned unchanged. For SSE, every byte still reaches Kelivo immediately
while an internal collector joins `delta.content`. Only after normal stream
completion and `reply.raw.end()` is the assistant capture scheduled. Migration,
database, parsing, or insert errors cannot delay tokens or change a completed
stream into an error. A later assistant operation retries its paired user write
first, so a recovered database can save the current completed turn.

The existing proactive flow remains model decision -> successful Bark/ntfy ->
internal wake event -> timeline special event -> proactive event. Only after
`appendProactiveEvent` succeeds does V1A schedule the delivered assistant body
as `heartbeat_proactive`. Its stable proactive `event_id` becomes
`external_event_id`, whose unique index prevents duplicate archive rows.
Archive failure occurs after, and cannot affect, successful current behavior.

## Fault isolation, migrations, and rollback

Archive activates only with `ARCHIVE_ENABLED=true` and a non-empty
`ARCHIVE_DATABASE_URL`; otherwise it is disabled, logs safely, and the gateway
starts/chats/wakes/syncs exactly as before. A small timeout-bounded pool runs
versioned SQL migrations recorded in `archive_schema_migrations`. Migration is
lazy, nonfatal, and retryable: failure makes Archive degraded only. Fastify
close closes the archive pool.

Rollback is `ARCHIVE_ENABLED=false` plus restart. It is non-destructive: data
and migrations remain intact for a later re-enable. Later schema changes are
additive, versioned, and recorded.

## Read API, pagination, and time

`GET /v1/archive/messages` accepts `conversation_id`, optional strict
`date=YYYY-MM-DD`, bounded `limit`, and a signed keyset `cursor`.
`GET /v1/archive/stats` accepts conversation/date filters and returns totals,
role counts, and first/last known message time. Both require exactly
`Authorization: Bearer <ARCHIVE_API_KEY>`; normal gateway keys are not enough,
even if public gateway access is enabled.

Rows are ordered by `(sequence, id)` ascending, so equal/null historical times
stay stable. The HMAC cursor binds the requested filter and last key; later
inserts cannot duplicate or skip earlier pages. The database is UTC. A business
date converts local midnight and next local midnight separately with existing
`TIME_ZONE`/`resolveTimeZone()` behavior, then queries the resulting UTC range.
Strict calendar validation and independent endpoints protect midnight and DST
transitions without assuming UTC, UTC+8, or Asia/Shanghai.

## V1B and Ombre Brain boundary

V1B will import old Kelivo data with `kelivo_history_import`, historical
timestamps where known, and importer provenance. It will align runs by
conversation, ordered role/content, known timestamp tolerance, and neighbors;
proven overlaps upgrade/reconcile provenance and unproven candidates become
conflicts rather than being hash-deleted. Thus V1B can safely overlap V1A's
start date. Ombre Brain will only page raw facts by conversation/date/range and
write its semantic output elsewhere. It must never summarize, replace, or
coerce `archive_messages`.

## Risk review

* Rolling 40 rows: one-time seed plus ordered tail/window reconciliation stops
  repeated insertion.
* Repeated `嗯`: predecessor sequence and turn identity preserve both facts.
* Stream loss: SSE collector writes only after normal completion; failure is
  isolated and visible as a safe archive error.
* HTTP retry: bounded exact turn lookup prevents common replay duplication;
  unavoidable no-client-ID ambiguity is conflict-audited.
* Windows/iPhone: both use conversation-tail reconciliation, not device state.
* DB outage: background timeout-bounded errors never escape the primary path.
* Proactive duplicate: unique external event ID blocks it.
* Date shift: configured-zone local midnight endpoints become UTC bounds.
* V1B overlap: ordered contextual reconciliation avoids blind duplicates or
  silent loss.
