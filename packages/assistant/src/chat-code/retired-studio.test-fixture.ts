// Pre-cut chat table contracts, retained only to test upgrade preservation.
import { sql } from "@k2b/cloud";
/** Retained chat persistence. Existing table names preserve pending calls, claims and approvals. */
export async function createLegacyChatSchema() {
  await sql`CREATE SCHEMA IF NOT EXISTS assistant`.simple();
  await sql`CREATE TABLE IF NOT EXISTS assistant.artifact_client_calls (
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    turn_id UUID NOT NULL, call_id TEXT NOT NULL,
    client_id UUID NOT NULL, input JSONB NOT NULL, result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(user_id, turn_id, call_id)
  )`.simple();
  await sql`ALTER TABLE assistant.artifact_client_calls ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now()`.simple();
  await sql`CREATE TABLE IF NOT EXISTS assistant.capability_calls (
    id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    artifact_id UUID, conversation_id TEXT,
    request JSONB NOT NULL, prepared JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', result JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`.simple();
  await sql`CREATE TABLE IF NOT EXISTS assistant.http_secrets (
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    scope TEXT NOT NULL, name TEXT NOT NULL,
    resource_id UUID,
    origin TEXT NOT NULL, header TEXT NOT NULL, prefix TEXT NOT NULL,
    encrypted TEXT NOT NULL, revision UUID NOT NULL,
    PRIMARY KEY(user_id,scope,name)
  )`.simple();
  await sql`CREATE TABLE IF NOT EXISTS assistant.http_calls (
    id UUID NOT NULL, user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    hash TEXT NOT NULL, encrypted TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(user_id,id)
  )`.simple();
  await sql`CREATE INDEX IF NOT EXISTS assistant_http_calls_created ON assistant.http_calls(created_at)`.simple();
  await sql`CREATE TABLE IF NOT EXISTS assistant.artifact_agent_calls (
    turn_id UUID NOT NULL REFERENCES ai.turns(id) ON DELETE CASCADE, call_id TEXT NOT NULL, user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL REFERENCES ai.conversations(id) ON DELETE CASCADE, host_id UUID NOT NULL, input JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'running', result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(turn_id,call_id)
  )`;
  await sql`CREATE INDEX IF NOT EXISTS artifact_agent_calls_conversation ON assistant.artifact_agent_calls(conversation_id,created_at DESC)`;
  await sql`ALTER TABLE assistant.capability_calls ADD COLUMN IF NOT EXISTS approval_id UUID`.simple();
  await sql`CREATE TABLE IF NOT EXISTS assistant.artifact_agent_approvals (
    turn_id UUID NOT NULL, call_id TEXT NOT NULL, id UUID NOT NULL,
    ordinal INTEGER GENERATED ALWAYS AS IDENTITY, message TEXT NOT NULL, decision BOOLEAN,
    PRIMARY KEY(turn_id,call_id,id),
    FOREIGN KEY(turn_id,call_id) REFERENCES assistant.artifact_agent_calls(turn_id,call_id) ON DELETE CASCADE
  )`;
  await sql`ALTER TABLE assistant.artifact_agent_approvals ADD COLUMN IF NOT EXISTS remember JSONB`;
  await sql`ALTER TABLE assistant.artifact_agent_approvals ADD COLUMN IF NOT EXISTS receipt JSONB`;
}
