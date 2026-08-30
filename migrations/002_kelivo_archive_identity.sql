-- Protocol 1 adds client-owned, deterministic user-send identity.  001 remains
-- untouched because it has already been applied to the Railway acceptance DB.
ALTER TABLE archive_turns
  ADD COLUMN IF NOT EXISTS client_user_message_id VARCHAR(128),
  ADD COLUMN IF NOT EXISTS archive_protocol_version INTEGER,
  ADD COLUMN IF NOT EXISTS identity_status VARCHAR(32),
  ADD COLUMN IF NOT EXISTS root_request_id VARCHAR(128),
  ADD COLUMN IF NOT EXISTS client_user_message_time TIMESTAMPTZ;

-- 001's request-id unique index predated conflict audit.  Protocol 1 must be
-- able to retain evidence when one side of the identity pair conflicts, so the
-- application transaction/row lock decides retries and writes conflict rows.
DROP INDEX IF EXISTS archive_turns_client_request_id_unique;

CREATE INDEX IF NOT EXISTS archive_turns_conversation_client_request_id_idx
  ON archive_turns (conversation_id, client_request_id, started_at DESC)
  WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS archive_turns_conversation_client_user_message_id_idx
  ON archive_turns (conversation_id, client_user_message_id, started_at DESC)
  WHERE client_user_message_id IS NOT NULL;
