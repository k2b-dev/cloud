import { env } from "@k2b/cloud/config";
import type { WorkflowActionContext, WorkflowAiScope } from "@k2b/cloud/workflows";
import { sql } from "bun";

/** Current authorization is checked by Mail's action port before this callback. */
export const mailWorkflowAiScope = async (ctx: Pick<WorkflowActionContext, "runId" | "invocation">): Promise<WorkflowAiScope> => {
  // Read identity/revision from the durable run's source, never a model-supplied value.
  const [source] = await sql<{ run_id: string; source_id: string | null; id: string | null; revision: string | null }[]>`
    SELECT run.id::text AS run_id, run.context #>> '{source,message,id}' AS source_id, message.short_id AS id, message.content_hash AS revision
    FROM workflows.run run
    LEFT JOIN mail.message_contents message ON message.mailbox_id::text = run.scope_id
      AND message.short_id = run.context #>> '{source,message,id}'
    WHERE run.id = ${ctx.runId}::uuid
  `;
  if (!source || (source.source_id && (!source.id || !source.revision)))
    throw Object.assign(new Error("AI requires a message in the workflow mailbox. Inspect the message or start a message-bound run."), {
      code: "WORKFLOW_AI_SOURCE_UNAVAILABLE",
    });
  return {
    sourceId: source.id ?? `run:${source.run_id}`,
    sourceRevision: source.revision ?? source.run_id,
    budget: env.WORKFLOW_AI_BUDGET,
    recompute: ctx.invocation.context?.recomputeAi === true,
  };
};
