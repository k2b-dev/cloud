import type { sql } from "@k2b/cloud";
import { revokeMandate } from "@k2b/cloud/services/mandates";

export const MAIL_RULE_RETIREMENT_VERSION = 3;
export const MAIL_RULE_RETIREMENT_NAME = "rules_retired";

/**
 * One-way cut after the old Mail workers have stopped. Preserve definitions and
 * execution evidence; refuse the cut while a provider outcome still needs the
 * old fence or reconciliation. The owning migration supplies its transaction.
 */
export const retireMailRules = async (db: typeof sql): Promise<void> => {
  const [done] = await db<{ present: boolean }[]>`SELECT EXISTS (
    SELECT 1 FROM mail.schema_migrations WHERE version = ${MAIL_RULE_RETIREMENT_VERSION}
      AND name = ${MAIL_RULE_RETIREMENT_NAME}
  ) AS present`;
  if (done?.present) return;
  // Old binaries must be stopped before upgrade. Lock their effect boundary so
  // a last claim cannot race the drain check and the permanent admission fence.
  await db`LOCK TABLE mail.commands, mail.outbox_submissions, mail.drafts,
    workflows.run, workflows.activation IN SHARE ROW EXCLUSIVE MODE`;
  const [unsettled] = await db<{ commands: number; sends: number }[]>`SELECT
    (SELECT count(*)::int FROM mail.commands command WHERE command.actor_kind = 'workflow'
      AND command.state NOT IN ('confirmed', 'failed', 'cancelled', 'reconciled')) AS commands,
    (SELECT count(*)::int FROM mail.outbox_submissions submission
      JOIN mail.commands command ON command.id = submission.command_id
      JOIN mail.drafts draft ON draft.id = submission.draft_id
      WHERE (command.actor_kind = 'workflow' OR draft.delivery_class = 'automatic_reply')
        AND submission.state NOT IN ('sent', 'failed', 'cancelled', 'reconciled_accepted', 'reconciled_unsent')) AS sends`;
  if (unsettled?.commands || unsettled?.sends)
    throw new Error(
      `Mail rule retirement requires drained provider effects (${unsettled.commands} commands, ${unsettled.sends} sends). ` +
        "Stop old admission and reconcile or cancel them on the export-capable release before upgrading. Never replay an accepted send.",
    );

  await db`UPDATE workflows.activation SET enabled = false, updated_at = now()
    WHERE workflow_id IN (SELECT id FROM workflows.workflow WHERE app_id = 'mail') AND enabled`;
  await db`UPDATE mail.workflow_profile SET enabled = false, updated_at = now() WHERE enabled`;
  await db`UPDATE mail.incoming_automations SET enabled = false, updated_at = now() WHERE enabled`;
  await db`UPDATE mail.automatic_reply_configurations SET enabled = false, updated_at = now() WHERE enabled`;
  await db`UPDATE workflows.run SET state = 'canceled', cancel_requested_at = COALESCE(cancel_requested_at, now()),
    execution_generation = execution_generation + 1, lease_owner = NULL, lease_expires_at = NULL,
    finished_at = COALESCE(finished_at, now()), updated_at = now()
    WHERE app_id = 'mail' AND state IN ('queued', 'running', 'waiting', 'needs_attention')`;
  await db`UPDATE mail.drafts SET state = 'discarded', updated_at = now()
    WHERE (delivery_class = 'automatic_reply' OR origin = 'workflow') AND state IN ('draft', 'scheduled')`;
  await db`UPDATE mail.automatic_reply_effects SET state = 'cancelled'
    WHERE state = 'queued'`;

  const mandates = await db<{ id: string; revision: number }[]>`SELECT id, revision::int AS revision
    FROM auth.mandates WHERE owner_app_id = 'mail' AND workload_type = 'incoming.automation'
      AND state <> 'revoked' FOR UPDATE`;
  for (const mandate of mandates) {
    const revoked = await revokeMandate(
      {
        mandateId: mandate.id,
        expectedRevision: mandate.revision,
        authority: { kind: "workload", ownerAppId: "mail" },
        reason: "Mail rules retired",
      },
      { db },
    );
    if (!revoked.ok) throw new Error(revoked.error.message);
  }

  // Names already materialized by slice 1 outlive executable definitions.
  await db`UPDATE mail.workflow_source_names SET active = false WHERE active`;
  await db`DROP TRIGGER IF EXISTS mail_capture_workflow_version_source ON workflows.version`;
  await db`DROP TRIGGER IF EXISTS mail_capture_workflow_source ON workflows.workflow`;
  await db`DROP FUNCTION IF EXISTS mail.capture_workflow_source_name()`;
  await db`DROP TRIGGER IF EXISTS conversations_invalidate_automation_status ON mail.conversations`;
  await db`DROP TRIGGER IF EXISTS placements_invalidate_automation_state ON mail.message_placements`;
  await db`DROP FUNCTION IF EXISTS mail.invalidate_automation_observed_state()`;

  // Restrict only Mail. Grids and the public workflow engine keep their contract.
  await db`CREATE OR REPLACE FUNCTION mail.reject_retired_rule_admission() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.app_id = 'mail' THEN
        RAISE EXCEPTION 'Mail rules are retired; use mailbox Code' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END
  $$`;
  await db`CREATE OR REPLACE TRIGGER mail_rules_retired_event BEFORE INSERT ON workflows.event
    FOR EACH ROW EXECUTE FUNCTION mail.reject_retired_rule_admission()`;
  await db`CREATE OR REPLACE TRIGGER mail_rules_retired_run BEFORE INSERT ON workflows.run
    FOR EACH ROW EXECUTE FUNCTION mail.reject_retired_rule_admission()`;
  await db`CREATE OR REPLACE FUNCTION mail.reject_retired_rule_execution() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.app_id = 'mail' AND NEW.state IN ('queued', 'running', 'waiting') THEN
        RAISE EXCEPTION 'Mail rules are retired; historical runs are read-only' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END
  $$`;
  await db`CREATE OR REPLACE TRIGGER mail_rules_retired_replay BEFORE UPDATE OF state ON workflows.run
    FOR EACH ROW EXECUTE FUNCTION mail.reject_retired_rule_execution()`;
  await db`CREATE OR REPLACE FUNCTION mail.reject_retired_rule_command() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.actor_kind = 'workflow' AND NEW.state IN ('queued', 'executing', 'ambiguous', 'needs_attention') THEN
        RAISE EXCEPTION 'Mail rules are retired; historical commands cannot execute' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END
  $$`;
  await db`CREATE OR REPLACE TRIGGER mail_rules_retired_command BEFORE INSERT OR UPDATE OF state ON mail.commands
    FOR EACH ROW EXECUTE FUNCTION mail.reject_retired_rule_command()`;
  await db`CREATE OR REPLACE FUNCTION mail.reject_retired_reply_draft() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.delivery_class = 'automatic_reply' OR NEW.origin = 'workflow' THEN
        IF NEW.state IN ('draft', 'scheduled', 'sending') THEN
          RAISE EXCEPTION 'Automatic replies are retired' USING ERRCODE = '55000';
        END IF;
      END IF;
      RETURN NEW;
    END
  $$`;
  await db`CREATE OR REPLACE TRIGGER mail_rules_retired_draft BEFORE INSERT OR UPDATE ON mail.drafts
    FOR EACH ROW EXECUTE FUNCTION mail.reject_retired_reply_draft()`;
  await db`CREATE OR REPLACE FUNCTION mail.reject_retired_reply_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.state IN ('scheduled', 'undo_window', 'sending', 'accepted', 'sent_sync_pending', 'unknown', 'needs_attention')
        AND EXISTS (SELECT 1 FROM mail.drafts draft WHERE draft.id = NEW.draft_id
          AND (draft.delivery_class = 'automatic_reply' OR draft.origin = 'workflow')) THEN
        RAISE EXCEPTION 'Automatic replies are retired; historical sends cannot execute' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END
  $$`;
  await db`CREATE OR REPLACE TRIGGER mail_rules_retired_outbox BEFORE INSERT OR UPDATE ON mail.outbox_submissions
    FOR EACH ROW EXECUTE FUNCTION mail.reject_retired_reply_outbox()`;
  await db`INSERT INTO mail.schema_migrations (version, name)
    VALUES (${MAIL_RULE_RETIREMENT_VERSION}, ${MAIL_RULE_RETIREMENT_NAME})`;
};
