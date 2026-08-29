# Raw Chat Archive V1A design

## Scope and safety boundary

V1A is an append-only PostgreSQL factual archive for Kelivo conversations
observed by Dylan Heartbeat after Archive is enabled. It records bound live
user turns, gateway assistant results, and successfully created proactive
events. It is separate from `enhanced_messages.json`, timeline context,
timestamp memory, V1B import, and Ombre Brain. It does not summarize, embed,
rank, delete, or rewrite a message.

The runtime rule is **CHAT FIRST, ARCHIVE SECOND**. Archive work is scheduled
after the current request path has the required data and never changes the
payload sent to the upstream model or bytes sent to Kelivo. Database, migration,
or reconciliation errors are content-free structured logs only.

## Existing gateway flow

`POST /v1/chat/completions` validates the optional existing Kelivo conversation
binding, updates timestamp memory only for the latest real user message, builds
the existing clipped timeline, preserves the original multimodal payload, and
forwards it to `TARGET_API_URL`. Non-stream bodies are returned unchanged. SSE
bytes are written to Kelivo as they arrive. Archive observes the original bound
request and the actual upstream result after this flow; it never increases the
Kelivo context window.

`/internal/wake-event` remains responsible for the existing wake/timeline/
proactive-event behavior. Only after `appendProactiveEvent()` succeeds is its
body scheduled as `heartbeat_proactive`; its real `event_id` is the archive
`external_event_id`. Archive failure therefore cannot break Bark, the event,
or proactive sync.

## Identity and schema

`001_initial.sql` creates:

* `archive_conversations`: conversation-scoped monotonic `next_sequence`.
* `archive_turns`: one observed live user candidate, its exact assistant link,
  request/context evidence, canonical state, and terminal state.
* `archive_messages`: immutable factual rows with role, safe content, UTC
  times, monotonic sequence, source, confirmation/completion/delivery state,
  `turn_id`, and canonical flag.
* `archive_reconciliation_conflicts`: content-free candidate relationship and
  lifecycle record.
* `archive_schema_migrations`: applied versioned SQL files.

`archive_messages.turn_id` is an FK to `archive_turns`. A turn's user and
assistant UUID links are FKs back to messages. All use `ON DELETE RESTRICT`:
Archive never physically deletes factual history, and the database must reject
an orphaning delete. A turn is inserted first in the same transaction, then its
user message, then the turn's user link, avoiding a deferred-FK cycle.

Partial unique indexes enforce one canonical user and one canonical assistant
per `turn_id`; the proactive `external_event_id` is globally unique only when
non-null. `(conversation_id, client_request_id)` is unique only when an actual
stable request ID is supplied. Canonical messages are indexed by conversation
time/sequence and turn ID for query and reconciliation access.

## User turns, retries, and candidates

Only a final real user message for a valid conversation binding starts a live
turn. First sight of an existing conversation stores the visible pre-anchor
window once as `initial_context_seed`; unknown historic message times remain
`NULL` while `observed_at` records when the gateway saw them. V1B owns complete
pre-V1A import.

The gateway accepts `Idempotency-Key`, `X-Kelivo-Request-Id`, or `X-Request-Id`
only when non-empty and valid. A prior matching value in the same conversation
is deterministic retry evidence and can reuse its existing `turn_id`. Kelivo
currently does not send one, so this path is normally unavailable.

Without that stable ID, **UNCERTAIN IS NOT DUPLICATE**. Neither content,
fingerprint, full context digest, predecessor, nor elapsed time (including a
10-minute window) suppresses a new user row. A same-context candidate is
written as a distinct turn/message with `reconcile_status=possible_retry` and
an open conflict referencing the plausible prior turn. Two real short `嗯`
turns are therefore retained even when identical.

`request_key` includes conversation, assistant, predecessor sequence, and the
ordered request digest, but is diagnostic/turn pairing material, not proof of
a transport retry without client identity.

## Conflict lifecycle and logical history

Conflicts start `open` and contain no chat body. They record candidate turn,
related turn where known, reason, observed time, and safe evidence metadata.
Supported outcomes are `resolved_distinct`, `resolved_duplicate`, `superseded`,
and `manual_review`, together with resolver, resolution time, and metadata.

Resolving a candidate as a confirmed transport duplicate sets its turn and
messages `canonical=false`, links `duplicate_of_turn_id`, and retains every
physical row. Resolving distinct keeps it canonical. No automated reconciler
claims this proof in V1A; a future evidence-aware worker or manual process may
do so. This prevents guessed dedupe from becoming data loss.

Archive messages/stats default to canonical logical history. Open ambiguous
candidates remain canonical and are never hidden. `include_duplicates=true`
is archive-key-protected and returns the retained physical audit rows; its
value is bound into the signed cursor.

## Rolling context and multiple devices

For an existing conversation, the visible pre-anchor window is compared to the
last 80 canonical rows. Resolution is one of:

* `RELIABLE`: exactly one suffix/prefix alignment, at least three messages,
  unique in the retained tail, and covering the full visible window or at least
  75 percent of it. Only then can an unmatched suffix be saved as
  `reconciled_context`.
* `AMBIGUOUS`: repeated candidate patterns or weak overlap. No context is
  appended and no predecessor is inferred; the latest real user is still saved
  as an `ambiguous_overlap` candidate plus conflict.
* `NONE`: no alignment. Old visible context is not appended; a mismatching
  window is conflict evidence, while the newest real user remains a new turn.

The conversation row is locked with `SELECT ... FOR UPDATE` before incoming
reconciliation and sequence allocation. This makes sequence monotonic across
Windows and iPhone. A stale device window cannot rewrite or move the canonical
tail backward; it can only yield a new live user candidate and conflict.

## Assistant pairing and structured responses

The live request lifecycle retains the exact `turn_id` returned by
`captureIncomingTurn()` and passes it to `captureAssistantForTurn()`. It never
searches for a "latest awaiting" turn. The assistant write transaction locks
that turn with `SELECT ... FOR UPDATE`, checks the stored assistant link,
inserts exactly one canonical assistant when absent, updates the link/status,
then commits. A per-process turn queue and PostgreSQL partial unique index are
additional defences across local and multi-instance concurrency.

Assistant text is stored unchanged. A non-stream assistant with only
`tool_calls`, `function_call`, refusal/audio/annotation structure, or other
meaningful structured data is still archived with empty `content_text` and
safe structured metadata. It is never converted into invented natural
language.

## SSE completion and delivery state

The compact SSE collector supports comments, `event`/`id`/`retry` fields,
multi-line `data` events, chunk boundaries, `[DONE]`, `finish_reason`, text
deltas, and structured deltas. It is observational: every upstream chunk is
written immediately before Archive is scheduled.

Only `[DONE]` or an explicit non-null `finish_reason` proves
`completion_status=complete` and `confirmed=true`. EOF alone is not proof. If
text/structured content exists at EOF without a completion marker, it is stored
as `partial`, `confirmed=false`, and the turn is `assistant_partial`. A reader
error with received content is also partial with
`termination_reason=upstream_read_error`; with no content it records an
`assistant_failed`/`assistant_interrupted` terminal turn instead of completion.

If Kelivo disconnects, the gateway continues reading an already-started
upstream generation without writing to the destroyed response. A completed or
partial generated assistant can be archived with `delivery_status=unconfirmed`;
this does not claim that the client saw it. Normal delivery is `unknown` rather
than assumed read. Archive write errors remain fail-open and cannot delay
tokens.

## Content, privacy, and multimodal safety

String content remains text. Multipart content uses the existing
`normalizeContentToText()` and a structural traversal for `content_json`.
`data:image/...;base64` is immediately replaced by placeholder, MIME type,
byte estimate, and SHA-256; the raw base64 is neither JSON-stringified for the
archive nor persisted. Normal URLs, text, and descriptions remain. Sanitization
is archive-only and the upstream receives the original payload unchanged.

Archive logs contain event/kind/count/state/error category only. They never
contain chat content, prompts, keys, URLs, authorization values, DB URL, or
base64.

## Migrations and fault isolation

Archive activates only when `ARCHIVE_ENABLED=true` and
`ARCHIVE_DATABASE_URL` is non-empty. The pool has connection/query/statement
timeouts. Each migration transaction first takes the fixed project-specific
`pg_advisory_xact_lock` key, then checks applied migrations, runs pending SQL,
records each file, and commits. The lock is released automatically at commit or
rollback, so concurrent Railway instances serialize migration work.

Migration failure rolls back and schedules `archive_migration_failed` plus the
normal content-free Archive error. The Gateway continues chat, stream,
Heartbeat, Bark, and proactive sync. Rollback is disabling Archive and
restarting; it is non-destructive. Future deployed changes are additive,
versioned migrations. V1A has not been deployed, so `001_initial.sql` is the
correct initial schema.

## Read API and business dates

`GET /v1/archive/messages` and `/v1/archive/stats` require the independent
`ARCHIVE_API_KEY` Bearer token. They validate `conversation_id`, strict date,
bounded limit, `include_duplicates`, and a signed keyset cursor. SQL is
parameterized. Ordering is `(sequence, id)`; totals are conversation-scoped.

All stored instants are UTC. `date=YYYY-MM-DD` means `[local start of day,
next local start of day)` in configured `TIME_ZONE`. `@js-temporal/polyfill`
resolves each IANA local midnight independently with `disambiguation: 'reject'`:
23/24/25-hour DST days work, while skipped or repeated local midnights/dates
are rejected rather than silently shifted into an adjacent business date.

## V1B and Ombre Brain boundary

V1B may import old Kelivo history as `kelivo_history_import`. It must preserve
provenance and use ordered neighbours/timestamps for evidence; overlap that is
not proven remains a conflict candidate, never a hash delete. Ombre Brain may
page Raw Archive by conversation/date/range and write semantic memory elsewhere.
It must not change raw archive facts.
