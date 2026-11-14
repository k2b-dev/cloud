import { sql } from "@k2b/cloud";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import {
  type MailAutomationExportPage,
  mailAutomationExportEntrySchema,
  mailAutomationExportQuerySchema,
} from "../automation-export-contracts";
import { isCurrentPlatformAdmin, requireMailboxPermission } from "./access";
import { capByCredentialScopes, type MailRequestContext } from "./auth";

/** Page by immutable version ID, including managed and disabled definitions, without the authoring list caps.
 * Never select activation authorization snapshots, credential stores or mandate credentials. */
export const exportMailAutomation = async (
  context: MailRequestContext,
  input: { mailboxId?: string; after?: string; limit?: number },
): Promise<Result<MailAutomationExportPage>> => {
  const page = mailAutomationExportQuerySchema.parse({ after: input.after, limit: input.limit });
  if (input.mailboxId) {
    const allowed = await requireMailboxPermission(context, input.mailboxId, "admin");
    if (!allowed.ok) return allowed;
  } else if (
    context.actor.kind !== "user" ||
    context.actor.delegation ||
    capByCredentialScopes(context, "read") === "none" ||
    !(await isCurrentPlatformAdmin(context))
  ) {
    return fail(err.forbidden("Cloud administration access is required"));
  }
  const rows = await sql<{ entry: unknown; cursor: string }[]>`
    WITH profiles AS (
      SELECT profile.*, row_number() OVER (PARTITION BY mailbox_id ORDER BY priority, id) AS position
      FROM mail.workflow_profile profile
      WHERE (${input.mailboxId ?? null}::uuid IS NULL OR mailbox_id = ${input.mailboxId ?? null}::uuid)
    )
    SELECT version.id::text AS cursor, jsonb_build_object(
      'kind', 'mail-workflow',
      'mailbox', jsonb_build_object('id', mailbox.short_id, 'name', mailbox.name, 'deletedAt', mailbox.deleted_at, 'aiCallsPerDay', mailbox.ai_calls_per_day),
      'workflow', jsonb_build_object(
        'id', workflow.id, 'name', workflow.name, 'description', workflow.description,
        'managedBy', profile.managed_by, 'enabled', profile.enabled, 'priority', profile.priority, 'order', profile.position,
        'currentVersionId', (SELECT id FROM workflows.version WHERE workflow_id = workflow.id ORDER BY revision DESC LIMIT 1),
        'activeVersionId', workflow.active_version_id, 'createdAt', profile.created_at, 'updatedAt', profile.updated_at),
      'guidedDefinition', CASE WHEN guided.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', guided.short_id, 'revision', guided.revision, 'name', guided.name, 'enabled', guided.enabled,
        'scope', guided.scope, 'steps', guided.steps, 'deletedAt', guided.deleted_at) END,
      'automaticReply', CASE WHEN reply.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', reply.short_id, 'revision', reply.revision, 'name', reply.name, 'enabled', reply.enabled,
        'senderIdentityId', identity.short_id, 'subject', reply.subject, 'body', reply.body, 'format', reply.format,
        'ensureReference', reply.ensure_reference, 'minimumIntervalHours', reply.minimum_interval_hours,
        'inactiveBehavior', reply.inactive_behavior, 'schedule', reply.schedule_definition) END,
      'mandateSummary', CASE WHEN mandate.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', mandate.id, 'state', mandate.state, 'revision', mandate.revision, 'expiresAt', mandate.expires_at,
        'apps', mandate.policy->'apps', 'operations', mandate.policy->'operations', 'actions', mandate.policy->>'actions') END,
      'version', jsonb_build_object(
        'id', version.id, 'revision', version.revision, 'source', version.source, 'sourceHash', version.source_hash,
        'languageId', version.language_id, 'languageVersion', version.language_version, 'manifestHash', version.manifest_hash,
        'bindings', COALESCE(version.plan->'bindings', '{}'::jsonb), 'effectBudget', version.effect_budget, 'createdAt', version.created_at),
      'activations', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', activation.id, 'versionId', activation.workflow_version_id, 'key', activation.key,
        'eventType', activation.event_type, 'config', activation.config, 'enabled', activation.enabled
      ) ORDER BY activation.key, activation.id) FROM workflows.activation activation WHERE activation.workflow_id = workflow.id), '[]'::jsonb)
    ) AS entry
    FROM profiles profile
    JOIN mail.mailboxes mailbox ON mailbox.id = profile.mailbox_id
    JOIN workflows.workflow workflow ON workflow.id = profile.id
    JOIN workflows.version version ON version.workflow_id = workflow.id
    LEFT JOIN mail.incoming_automations guided ON guided.workflow_id = workflow.id
    LEFT JOIN auth.mandates mandate ON mandate.id = guided.mandate_id
    LEFT JOIN mail.automatic_reply_configurations reply ON reply.workflow_id = workflow.id
    LEFT JOIN mail.sender_identities identity ON identity.id = reply.sender_identity_id
    WHERE (${page.after ?? null}::uuid IS NULL OR version.id > ${page.after ?? null}::uuid)
    ORDER BY version.id
    LIMIT ${page.limit + 1}
  `;
  const selected = rows.slice(0, page.limit);
  return ok({
    format: "cloud.mail-automation",
    version: 1,
    authority: "none",
    scope: input.mailboxId ? "mailbox" : "installation",
    exportedAt: new Date().toISOString(),
    items: selected.map((row) => {
      const parsed = mailAutomationExportEntrySchema.safeParse(row.entry);
      if (!parsed.success) throw new Error(`Cannot export Mail workflow version ${row.cursor}: invalid stored definition`);
      return parsed.data;
    }),
    nextCursor: rows.length > page.limit ? selected.at(-1)!.cursor : null,
  });
};
