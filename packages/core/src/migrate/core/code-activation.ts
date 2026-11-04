import { sql } from "@k2b/cloud";
import type { SQL } from "bun";

/** Durable version-switch journal and retryable outbox; no reusable credentials. */
export async function migrate(db: SQL = sql): Promise<void> {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('core.code.activation.migrate',0))`;
    await tx`CREATE TABLE IF NOT EXISTS code.activations (
      id UUID PRIMARY KEY, code_id TEXT NOT NULL REFERENCES code.codes(id) ON DELETE CASCADE,
      version_id UUID NOT NULL, activating_person UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      authority JSONB, locale TEXT NOT NULL, cloud_admin BOOLEAN NOT NULL, cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','preflight','applying','waiting','rolling_back','failed','active','cancelled')),
      failure JSONB, mandate_id UUID REFERENCES auth.mandates(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      FOREIGN KEY(version_id,code_id) REFERENCES code.versions(id,code_id) ON DELETE CASCADE
    )`.simple();
    await tx`ALTER TABLE code.activations ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT FALSE`.simple();
    await tx`CREATE INDEX IF NOT EXISTS activations_code ON code.activations(code_id,created_at DESC,id)`.simple();
    await tx`ALTER TABLE code.activations DROP COLUMN IF EXISTS plan, DROP COLUMN IF EXISTS mandate_policy`.simple();
    // Built-in adapter grants already are auth.access rows in the target's own junction.
    // Keep active/draining shares at their exact level, and finish only the legacy
    // compensation that was already due. Never infer or recreate a share from a journal.
    await tx`DO $$ BEGIN
      IF to_regclass('code.target_grants') IS NOT NULL THEN
        DELETE FROM auth.access a USING code.target_grants g, code.codes c
          WHERE a.id=g.grant_id AND c.id=g.code_id AND a.service_account_id=c.service_account_id
            AND g.state IN ('attempting','granted')
            AND NOT EXISTS (
              SELECT 1 FROM code.version_grants vg WHERE vg.grant_id=g.grant_id
                AND (vg.version_id=c.active_version_id OR EXISTS (
                  SELECT 1 FROM code.runs r WHERE r.code_id=c.id AND r.version_id=vg.version_id
                    AND r.state IN ('queued','running'))));
        UPDATE code.activations SET state='cancelled',cancel_requested=TRUE,authority=NULL,
          failure=jsonb_build_object('target',NULL,'code','activation_model_changed','reason','Start a new activation after the access-model update.'),updated_at=now()
          WHERE state NOT IN ('active','failed','cancelled');
        UPDATE code.activations SET failure=jsonb_build_object('target',NULL,'code',failure->>'code','reason',failure->>'reason')
          WHERE failure IS NOT NULL;
      END IF;
    END $$`.simple();
    await tx`DROP TABLE IF EXISTS code.version_grants`.simple();
    await tx`DROP TABLE IF EXISTS code.target_grants`.simple();
    await tx`DROP TABLE IF EXISTS code.activation_notices`.simple();
    await tx`CREATE TABLE IF NOT EXISTS code.activation_outbox (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), code_id TEXT NOT NULL REFERENCES code.codes(id) ON DELETE CASCADE,
      activation_id UUID REFERENCES code.activations(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'activation' CHECK(kind IN ('activation','cleanup')),
      sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(), claimed_until TIMESTAMPTZ, last_error TEXT
    )`.simple();
    await tx`DROP INDEX IF EXISTS code.activation_outbox_cleanup`.simple();
    await tx`CREATE UNIQUE INDEX IF NOT EXISTS activation_outbox_process ON code.activation_outbox(activation_id) WHERE activation_id IS NOT NULL`.simple();
    await tx`CREATE INDEX IF NOT EXISTS activation_outbox_order ON code.activation_outbox(code_id,sequence)`.simple();
    await tx`CREATE INDEX IF NOT EXISTS activation_outbox_busy ON code.activation_outbox(code_id,sequence) WHERE claimed_until IS NOT NULL OR attempts>0`.simple();
  });
}
