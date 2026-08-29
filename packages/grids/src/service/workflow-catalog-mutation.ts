import { err, fail, ok, type Result } from "@k2b/stdlib";
import { toPgUuidArray } from "@valentinkolb/cloud/services";
import type { WorkflowBoundPlan } from "@valentinkolb/cloud/workflows";
import type { SqlClient } from "./audit";
import { workflowServiceText } from "./workflow-service-messages";

export const lockWorkflowCatalogMutation = async (baseId: string, client: SqlClient): Promise<void> => {
  await client`SELECT pg_advisory_xact_lock(hashtextextended(${`grids:workflow-catalog:${baseId}`}, 0))`;
};

export const assertWorkflowEmailTemplatesAvailable = async (
  baseId: string,
  plan: Pick<WorkflowBoundPlan, "bindings">,
  client: SqlClient,
  locale?: string,
): Promise<Result<void>> => {
  const templateIds = [
    ...new Set(
      Object.entries(plan.bindings)
        .filter(([key, value]) => key.endsWith(".sendEmail.template") && typeof value === "string")
        .map(([, value]) => value as string),
    ),
  ];
  if (templateIds.length === 0) return ok();
  const [row] = await client<Array<{ count: number }>>`
    SELECT count(*)::int AS count
    FROM grids.email_templates
    WHERE base_id = ${baseId}::uuid
      AND id = ANY(${toPgUuidArray(templateIds)}::uuid[])
      AND deleted_at IS NULL
  `;
  if (Number(row?.count ?? 0) !== templateIds.length) {
    return fail(err.badInput(workflowServiceText(locale).emailTemplateUnavailable));
  }
  return ok();
};
