# Raw Chat Archive V1A: deterministic client identity protocol

Protocol 1 deliberately replaces archive-side guessing.  Kelivo sends
`X-Kelivo-Archive-Protocol: 1`, conversation/assistant routing headers,
`X-Kelivo-Request-Id`, `X-Kelivo-User-Message-Id`, and a gateway-only
`_kelivo_archive` envelope at the final HTTP serialization point.

For `kind: user_send`, the envelope contains the conversation/assistant IDs,
the request and persisted user-message IDs, final `messages` index, ISO UTC
user-message time, and a safe structured copy of that persisted user's parts.
The Gateway validates every duplicate header/body value and validates that the
index points to a user message.  The envelope, not `messages[index]`, is the
canonical archive content source.  Base64 data URLs are rejected from the
envelope and never reach archive storage.

One real send action receives one random request ID.  HTTP retries reuse the
same request ID and user-message ID.  A later identical text send has new IDs.
Tool follow-ups use `kind: continuation` plus the same root request ID and may
not carry a user-message ID; pure tool-call assistant payloads are retained as
non-canonical phases until the continuation stores the final assistant reply.

Servers advertise support only through
`GET /v1/proactive-events` capability `archive_identity_protocol: 1`.  Old or
invalid clients continue ordinary chat but produce an `archive_chat_skipped`
event with no canonical user seed.  Before forwarding, the Gateway deletes
`_kelivo_archive`; it never forwards archive identity headers.
