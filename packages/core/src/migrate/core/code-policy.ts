import { sql } from "@k2b/cloud";
import type { SQL } from "bun";
import { codePolicyPreset } from "../../code/policy-contracts";

/** Additive policy migration; the default needs approval for shared, AI and external effects. */
export async function migrate(db: SQL = sql): Promise<void> {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('core.code.policy.migrate',0))`;
    await tx`CREATE TABLE IF NOT EXISTS code.policy (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton), revision INTEGER NOT NULL CHECK(revision>0),
      preset TEXT NOT NULL CHECK(preset IN ('off','admin','open','custom')),
      updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`.simple();
    await tx`CREATE TABLE IF NOT EXISTS code.policy_rules (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      group_id UUID REFERENCES auth.groups(id) ON DELETE CASCADE,
      row TEXT NOT NULL CHECK(row = ANY(ARRAY['read','silent_you','silent_draft','silent_shared','ask_sends','ask_deletes',
        'ask_cannot_undo','ask_involves_people','ask_changes_access','ask_keeps_working','ask_sensitive','ask_app_asks','ai','internet'])),
      value TEXT NOT NULL CHECK(value IN ('automatic','admin','never'))
    )`.simple();
    await tx`CREATE UNIQUE INDEX IF NOT EXISTS policy_default_row ON code.policy_rules(row) WHERE group_id IS NULL`.simple();
    await tx`CREATE UNIQUE INDEX IF NOT EXISTS policy_group_row ON code.policy_rules(group_id,row) WHERE group_id IS NOT NULL`.simple();
    const inserted =
      await tx`INSERT INTO code.policy(singleton,revision,preset) VALUES(TRUE,1,'admin') ON CONFLICT DO NOTHING RETURNING revision`;
    if (inserted.length)
      for (const rule of codePolicyPreset("admin").rules)
        await tx`INSERT INTO code.policy_rules(group_id,row,value) VALUES(NULL,${rule.row},${rule.value})`;
    // C8 writes this coverage in the same transaction as its verified, hash-bound approval decision.
    // A version ID identifies immutable source, bundle and manifest; no broad author-level grant.
    await tx`CREATE TABLE IF NOT EXISTS code.policy_coverage (
      version_id UUID NOT NULL REFERENCES code.versions(id) ON DELETE CASCADE,
      row TEXT NOT NULL CHECK(row = ANY(ARRAY['read','silent_you','silent_draft','silent_shared','ask_sends','ask_deletes',
        'ask_cannot_undo','ask_involves_people','ask_changes_access','ask_keeps_working','ask_sensitive','ask_app_asks','ai','internet'])), PRIMARY KEY(version_id,row)
    )`.simple();
    await tx`ALTER TABLE code.codes ADD COLUMN IF NOT EXISTS pause_reason TEXT,
      ADD COLUMN IF NOT EXISTS pause_rows TEXT[] NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS pause_policy_revision INTEGER`.simple();
    await tx`CREATE INDEX IF NOT EXISTS codes_policy_active ON code.codes(id) WHERE state='active'`.simple();
    await tx`CREATE TABLE IF NOT EXISTS code.policy_pause_outbox (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
      revision INTEGER NOT NULL, previous JSONB NOT NULL, cursor TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      claimed_until TIMESTAMPTZ, last_error TEXT
    )`.simple();
    await tx`CREATE UNIQUE INDEX IF NOT EXISTS policy_pause_cursor ON code.policy_pause_outbox(revision,COALESCE(cursor,''))`.simple();
    await tx`CREATE INDEX IF NOT EXISTS policy_pause_busy ON code.policy_pause_outbox(revision,sequence)
      WHERE claimed_until IS NOT NULL OR attempts>0`.simple();
  });
}
