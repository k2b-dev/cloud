import { audit } from "@k2b/cloud/services";
import { parseMandatePolicy } from "@k2b/cloud/services/mandates";
import { parsePgJsonValue } from "@k2b/cloud/services/postgres";
import { z } from "zod";
import { mailAutomationStepSchema } from "../contracts";
import { sha256Json } from "./canonical";
import { migrateIncomingAutomationPolicy } from "./incoming-automation-authority";
import { incomingAutomationHasSpaces } from "./incoming-automation-definition";
import type { SqlClient } from "./workflow-data";

const hasStoredSpacesStep = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasStoredSpacesStep);
  if (!value || typeof value !== "object") return false;
  if ("kind" in value && (value.kind === "link_space_item" || value.kind === "create_space_event")) return true;
  return ("then" in value && hasStoredSpacesStep(value.then)) || ("else" in value && hasStoredSpacesStep(value.else));
};

/** Run inside Mail's startup migration transaction, before any workers can claim work. */
export const migrateIncomingAutomationTargets = async (tx: SqlClient): Promise<void> => {
  await tx`ALTER TABLE mail.incoming_automations ADD COLUMN IF NOT EXISTS capability_target_version integer NOT NULL DEFAULT 0`;
  await tx`ALTER TABLE mail.incoming_automations ADD COLUMN IF NOT EXISTS authorization_state text NOT NULL DEFAULT 'ready'
    CHECK (authorization_state IN ('ready', 'needs_attention'))`;
  await tx`CREATE INDEX IF NOT EXISTS incoming_automations_target_upgrade_idx ON mail.incoming_automations(id) WHERE capability_target_version = 0 AND deleted_at IS NULL`;
  // One definition in memory at a time. The outer transaction also commits its audit evidence.
  for (;;) {
    const [automation] = await tx<
      {
        id: string;
        workflow_id: string;
        mandate_id: string | null;
        steps: unknown;
      }[]
    >`SELECT id, workflow_id, mandate_id, steps FROM mail.incoming_automations
      WHERE capability_target_version = 0 AND deleted_at IS NULL ORDER BY id LIMIT 1 FOR UPDATE`;
    if (!automation) break;
    const storedSteps = parsePgJsonValue(automation.steps);
    const parsed = z.array(mailAutomationStepSchema).min(1).max(20).safeParse(storedSteps);
    if (parsed.success ? !incomingAutomationHasSpaces(parsed.data) : !hasStoredSpacesStep(storedSteps)) {
      await tx`UPDATE mail.incoming_automations SET capability_target_version = 1 WHERE id = ${automation.id}::uuid`;
      continue;
    }
    const [mandate] = automation.mandate_id
      ? await tx<
          {
            policy: unknown;
            state: string;
            owner_app_id: string;
            workload_type: string;
            workload_id: string;
            subject_kind: string;
            subject_user_id: string | null;
          }[]
        >`SELECT policy, state, owner_app_id, workload_type, workload_id, subject_kind, subject_user_id FROM auth.mandates
      WHERE id = ${automation.mandate_id}::uuid FOR UPDATE`
      : [];
    const owned =
      mandate?.owner_app_id === "mail" &&
      mandate.workload_type === "incoming.automation" &&
      mandate.workload_id === automation.id &&
      mandate.subject_kind === "user" &&
      mandate.subject_user_id !== null;
    const policy = owned && parsed.success ? migrateIncomingAutomationPolicy(parsePgJsonValue(mandate.policy), parsed.data) : null;
    const changed = policy !== null && JSON.stringify(parseMandatePolicy(parsePgJsonValue(mandate!.policy))) !== JSON.stringify(policy);
    const mandatePaused = owned && !policy && mandate.state === "active";
    if (owned && (changed || (!policy && mandate.state === "active"))) {
      await tx`UPDATE auth.mandates SET
        policy = CASE WHEN ${changed} THEN ${JSON.stringify(policy)}::text::jsonb ELSE policy END,
        state = ${!policy && mandate.state === "active" ? "paused" : mandate.state},
        revision = revision + 1, updated_at = now() WHERE id = ${automation.mandate_id}::uuid`;
    }
    if (!policy) {
      await tx`UPDATE mail.workflow_profile SET enabled = false WHERE id = ${automation.workflow_id}::uuid`;
      await tx`UPDATE workflows.activation SET enabled = false, updated_at = now() WHERE workflow_id = ${automation.workflow_id}::uuid`;
    }
    await tx`UPDATE mail.incoming_automations SET capability_target_version = 1,
      authorization_state = ${policy ? "ready" : "needs_attention"},
      enabled = CASE WHEN ${policy !== null} THEN enabled ELSE false END,
      revision = revision + 1 WHERE id = ${automation.id}::uuid`;
    await audit.record(
      {
        action: "mail.incoming_automation.targets.migrate",
        outcome: "allowed",
        target: { type: "incoming_automation", id: automation.id },
        metadata: {
          version: 1,
          mandateId: automation.mandate_id,
          state: policy ? "preserved" : "needs_attention",
          changed,
          mandatePaused,
          previousPolicyDigest: mandate ? sha256Json(parsePgJsonValue(mandate.policy)) : null,
          nextPolicyDigest: mandate ? sha256Json(policy ?? parsePgJsonValue(mandate.policy)) : null,
        },
      },
      tx,
    );
  }
};
