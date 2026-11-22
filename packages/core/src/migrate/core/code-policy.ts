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
        'ask_cannot_undo','ask_involves_people','ask_changes_access','ask_keeps_working','ask_sensitive','ask_app_asks','ai','ai_chat_you','internet','public_routes','owner_data'])),
      value TEXT NOT NULL CHECK(value IN ('automatic','admin','never'))
    )`.simple();
    await tx`ALTER TABLE code.policy_rules DROP CONSTRAINT IF EXISTS policy_rules_row_check,
      ADD CONSTRAINT policy_rules_row_check CHECK(row = ANY(ARRAY['read','silent_you','silent_draft','silent_shared','ask_sends','ask_deletes',
        'ask_cannot_undo','ask_involves_people','ask_changes_access','ask_keeps_working','ask_sensitive','ask_app_asks','ai','ai_chat_you','internet','public_routes','owner_data']))`.simple();
    await tx`CREATE UNIQUE INDEX IF NOT EXISTS policy_default_row ON code.policy_rules(row) WHERE group_id IS NULL`.simple();
    await tx`CREATE UNIQUE INDEX IF NOT EXISTS policy_group_row ON code.policy_rules(group_id,row) WHERE group_id IS NOT NULL`.simple();
    const inserted =
      await tx`INSERT INTO code.policy(singleton,revision,preset) VALUES(TRUE,1,'admin') ON CONFLICT DO NOTHING RETURNING revision`;
    if (inserted.length)
      for (const rule of codePolicyPreset("admin").rules)
        await tx`INSERT INTO code.policy_rules(group_id,row,value) VALUES(NULL,${rule.row},${rule.value})`;
    // Existing tables do not acquire new public exposure automatically. Operators choose its rule explicitly.
    if (!inserted.length) {
      const added =
        await tx`INSERT INTO code.policy_rules(group_id,row,value) VALUES(NULL,'public_routes','never') ON CONFLICT DO NOTHING RETURNING id`;
      if (added.length)
        await tx`UPDATE code.policy SET preset='custom',revision=revision+1,updated_by=NULL,updated_at=clock_timestamp() WHERE singleton`;
    }
    // Owner-data routes show data read with the owner's rights to every visitor. Their row takes the
    // value of the stored preset, so a named preset stays exact; customized tables need an admin's approval.
    const ownerDataRow = await tx`INSERT INTO code.policy_rules(group_id,row,value)
      SELECT NULL,'owner_data',CASE preset WHEN 'off' THEN 'never' WHEN 'open' THEN 'automatic' ELSE 'admin' END FROM code.policy WHERE singleton
      ON CONFLICT DO NOTHING RETURNING id`;
    if (ownerDataRow.length)
      await tx`UPDATE code.policy SET revision=revision+1,updated_by=NULL,updated_at=clock_timestamp() WHERE singleton`;
    // Bounded personal chat turns have their own operator-visible row. Preserve the
    // existing AI requirement, including group approval requirements.
    const chatRow = await tx`INSERT INTO code.policy_rules(group_id,row,value)
      SELECT NULL,'ai_chat_you',CASE WHEN preset='off' OR EXISTS(SELECT 1 FROM code.policy_rules WHERE group_id IS NULL AND row='ai' AND value='never') THEN 'never' ELSE COALESCE((SELECT value FROM code.policy_rules WHERE group_id IS NULL AND row='ai'),'never') END FROM code.policy WHERE singleton
      ON CONFLICT DO NOTHING RETURNING id`;
    if (chatRow.length)
      await tx`INSERT INTO code.policy_rules(group_id,row,value)
      SELECT group_id,'ai_chat_you',value FROM code.policy_rules WHERE row='ai' AND value IN ('admin','never') AND group_id IS NOT NULL
      ON CONFLICT DO NOTHING`;
    if (chatRow.length) await tx`UPDATE code.policy SET revision=revision+1,updated_by=NULL,updated_at=clock_timestamp() WHERE singleton`;
    // Normalize historical defaults and overrides without widening any authority.
    const normalized = await tx`UPDATE code.policy_rules SET value='never'
      WHERE left(row,4)='ask_' AND value<>'never' RETURNING id`;
    if (normalized.length)
      await tx`UPDATE code.policy SET revision=revision+1,updated_by=NULL,updated_at=clock_timestamp() WHERE singleton`;
    // C8 writes this coverage in the same transaction as its verified, hash-bound approval decision.
    // A version ID identifies immutable source, bundle and manifest; no broad author-level grant.
    await tx`CREATE TABLE IF NOT EXISTS code.policy_coverage (
      version_id UUID NOT NULL REFERENCES code.versions(id) ON DELETE CASCADE,
      row TEXT NOT NULL CHECK(row = ANY(ARRAY['read','silent_you','silent_draft','silent_shared','ask_sends','ask_deletes',
        'ask_cannot_undo','ask_involves_people','ask_changes_access','ask_keeps_working','ask_sensitive','ask_app_asks','ai','ai_chat_you','internet','public_routes','owner_data'])), PRIMARY KEY(version_id,row)
    )`.simple();
    await tx`ALTER TABLE code.policy_coverage DROP CONSTRAINT IF EXISTS policy_coverage_row_check,
      ADD CONSTRAINT policy_coverage_row_check CHECK(row = ANY(ARRAY['read','silent_you','silent_draft','silent_shared','ask_sends','ask_deletes',
        'ask_cannot_undo','ask_involves_people','ask_changes_access','ask_keeps_working','ask_sensitive','ask_app_asks','ai','ai_chat_you','internet','public_routes','owner_data']))`.simple();
    await tx`ALTER TABLE code.codes ADD COLUMN IF NOT EXISTS pause_reason TEXT,
      ADD COLUMN IF NOT EXISTS pause_rows TEXT[] NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS pause_policy_revision INTEGER`.simple();
    // The release veto applies to the whole version. Make existing affected Code visibly paused,
    // including installations whose asking rules were already never. The state predicate is idempotent.
    await tx`UPDATE code.codes c SET state='paused',pause_reason='policy_changed',
      pause_rows=ARRAY(SELECT value FROM jsonb_array_elements_text(v.manifest->'policyRows') WHERE left(value,4)='ask_'),
      pause_policy_revision=(SELECT revision FROM code.policy WHERE singleton)
      FROM code.versions v WHERE c.state='active' AND c.active_version_id=v.id
        AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(v.manifest->'policyRows') WHERE left(value,4)='ask_')`;
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
