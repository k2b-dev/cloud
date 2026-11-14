import { sql } from "@k2b/cloud";
import { err, fail, ok } from "@k2b/stdlib";
import { z } from "zod";
import { requireMailboxPermission } from "./access";
import type { MailRequestContext } from "./auth";

export const retiredRunQuerySchema = z.object({ after: z.uuid().optional(), run: z.uuid().optional() });

/** Whole-mailbox read is required: a run may include several conversations. */
export const readRetiredRuleRuns = async (context: MailRequestContext, mailboxId: string, input: z.infer<typeof retiredRunQuerySchema>) => {
  const allowed = await requireMailboxPermission(context, mailboxId, "read");
  if (!allowed.ok) return allowed;
  const rows = await sql<{ id: string; createdAt: string; name: string; state: string; snapshot: unknown }[]>`
    SELECT run.id, run.created_at::text AS "createdAt", COALESCE(names.name, workflow.name) AS name, run.state,
      CASE WHEN ${input.run ?? null}::uuid IS NOT NULL THEN jsonb_build_object(
        'run', to_jsonb(run) - 'authorization_snapshot',
        'sourceName', COALESCE(names.name, workflow.name), 'source', version.source,
        'event', (SELECT to_jsonb(event) - 'authorization_snapshot' FROM workflows.event event WHERE event.id = run.event_id),
        'steps', COALESCE((SELECT jsonb_agg(to_jsonb(step) ORDER BY step.step_key)
          FROM workflows.step_outcome step WHERE step.run_id = run.id), '[]'::jsonb)) END AS snapshot
    FROM workflows.run run JOIN mail.workflow_profile profile ON profile.id = run.workflow_id
    JOIN workflows.workflow workflow ON workflow.id = run.workflow_id
    JOIN workflows.version version ON version.id = run.workflow_version_id
    LEFT JOIN mail.workflow_source_names names ON names.version_id = run.workflow_version_id
    WHERE run.app_id = 'mail' AND profile.mailbox_id = ${mailboxId}::uuid
      AND (${input.after ?? null}::uuid IS NULL OR run.id > ${input.after ?? null}::uuid)
      AND (${input.run ?? null}::uuid IS NULL OR run.id = ${input.run ?? null}::uuid)
    ORDER BY run.id LIMIT 51
  `;
  if (input.run && !rows.length) return fail(err.notFound("Retired Mail run"));
  return ok({ items: rows.slice(0, 50), nextCursor: rows.length > 50 ? rows[49]!.id : null });
};
