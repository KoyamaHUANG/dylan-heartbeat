CREATE TABLE IF NOT EXISTS archive_schema_migrations (
  migration_name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS archive_conversations (
  conversation_id VARCHAR(128) PRIMARY KEY,
  next_sequence BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS archive_messages (
  id BIGSERIAL PRIMARY KEY,
  archive_message_id UUID NOT NULL UNIQUE,
  conversation_id VARCHAR(128) NOT NULL,
  assistant_id VARCHAR(128),
  role VARCHAR(16) NOT NULL CHECK (role IN ('user', 'assistant')),
  content_text TEXT NOT NULL,
  content_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  source VARCHAR(64) NOT NULL,
  message_time TIMESTAMPTZ,
  observed_at TIMESTAMPTZ NOT NULL,
  sequence BIGINT NOT NULL,
  fingerprint VARCHAR(64) NOT NULL,
  turn_key VARCHAR(128),
  external_event_id VARCHAR(128),
  confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  reconcile_status VARCHAR(32) NOT NULL DEFAULT 'pending',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT archive_messages_conversation_sequence_unique UNIQUE (conversation_id, sequence)
);

CREATE TABLE IF NOT EXISTS archive_turns (
  turn_id UUID PRIMARY KEY,
  conversation_id VARCHAR(128) NOT NULL,
  assistant_id VARCHAR(128),
  request_key VARCHAR(128) NOT NULL,
  request_context_hash VARCHAR(64) NOT NULL,
  predecessor_sequence BIGINT,
  user_archive_message_id UUID,
  assistant_archive_message_id UUID,
  status VARCHAR(32) NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT archive_turns_conversation_request_key_unique UNIQUE (conversation_id, request_key)
);

CREATE TABLE IF NOT EXISTS archive_reconciliation_conflicts (
  conflict_id UUID PRIMARY KEY,
  conversation_id VARCHAR(128) NOT NULL,
  request_context_hash VARCHAR(64) NOT NULL,
  reason VARCHAR(128) NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS archive_messages_conversation_message_time_idx ON archive_messages (conversation_id, message_time);
CREATE INDEX IF NOT EXISTS archive_messages_conversation_sequence_idx ON archive_messages (conversation_id, sequence, id);
CREATE INDEX IF NOT EXISTS archive_messages_assistant_id_idx ON archive_messages (assistant_id);
CREATE UNIQUE INDEX IF NOT EXISTS archive_messages_external_event_id_unique ON archive_messages (external_event_id) WHERE external_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS archive_turns_context_hash_idx ON archive_turns (conversation_id, request_context_hash, started_at DESC);
