import { sql } from "@k2b/cloud";
import type { SQL } from "bun";

/** Durable C9 journal, exact grant ownership and a retryable outbox; no reusable credentials. */
export async function migrate(db: SQL = sql): Promise<void> {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('core.code.activation.migrate',0))`;
    await tx`CREATE TABLE IF NOT EXISTS code.activations (
      id UUID PRIMARY KEY, code_id TEXT NOT NULL REFERENCES code.codes(id) ON DELETE CASCADE,
      version_id UUID NOT NULL, activating_person UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      authority JSONB, locale TEXT NOT NULL, cloud_admin BOOLEAN NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','preflight','applying','waiting','rolling_back','failed','active','cancelled')),
      failure JSONB, plan JSONB, mandate_policy JSONB, mandate_id UUID REFERENCES auth.mandates(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      FOREIGN KEY(version_id,code_id) REFERENCES code.versions(id,code_id) ON DELETE CASCADE
    )`.simple();
    await tx`CREATE INDEX IF NOT EXISTS activations_code ON code.activations(code_id,created_at DESC,id)`.simple();
    await tx`CREATE TABLE IF NOT EXISTS code.target_grants (
      grant_id UUID PRIMARY KEY, code_id TEXT NOT NULL REFERENCES code.codes(id) ON DELETE CASCADE,
      activation_id UUID NOT NULL REFERENCES code.activations(id) ON DELETE CASCADE,
      target JSONB NOT NULL, operations TEXT[] NOT NULL, level TEXT,
      state TEXT NOT NULL CHECK(state IN ('planned','attempting','granted','removed','released')),
      manager_user_ids UUID[] NOT NULL DEFAULT '{}'
    )`.simple();
    await tx`CREATE INDEX IF NOT EXISTS target_grants_code ON code.target_grants(code_id,grant_id)`.simple();
    await tx`CREATE TABLE IF NOT EXISTS code.version_grants (
      version_id UUID NOT NULL REFERENCES code.versions(id) ON DELETE CASCADE,
      grant_id UUID NOT NULL REFERENCES code.target_grants(grant_id) ON DELETE CASCADE,
      PRIMARY KEY(version_id,grant_id)
    )`.simple();
    await tx`CREATE TABLE IF NOT EXISTS code.activation_notices (
      activation_id UUID NOT NULL REFERENCES code.activations(id) ON DELETE CASCADE,
      target JSONB NOT NULL, target_key TEXT NOT NULL,
      user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      sent BOOLEAN NOT NULL DEFAULT FALSE, PRIMARY KEY(activation_id,target_key,user_id)
    )`.simple();
    await tx`CREATE TABLE IF NOT EXISTS code.activation_outbox (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), code_id TEXT NOT NULL REFERENCES code.codes(id) ON DELETE CASCADE,
      activation_id UUID REFERENCES code.activations(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'activation' CHECK(kind IN ('activation','cleanup')),
      sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(), claimed_until TIMESTAMPTZ, last_error TEXT
    )`.simple();
    await tx`CREATE UNIQUE INDEX IF NOT EXISTS activation_outbox_process ON code.activation_outbox(activation_id) WHERE activation_id IS NOT NULL`.simple();
    await tx`CREATE UNIQUE INDEX IF NOT EXISTS activation_outbox_cleanup ON code.activation_outbox(code_id) WHERE activation_id IS NULL`.simple();
    await tx`CREATE INDEX IF NOT EXISTS activation_outbox_order ON code.activation_outbox(code_id,sequence)`.simple();
    await tx`CREATE INDEX IF NOT EXISTS activation_outbox_busy ON code.activation_outbox(code_id,sequence) WHERE claimed_until IS NOT NULL OR attempts>0`.simple();
  });
}
