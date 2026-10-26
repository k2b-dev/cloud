import { env } from "@k2b/cloud/config";
import type { WorkflowActionContext, WorkflowAiScope } from "@k2b/cloud/workflows";
import { sql } from "bun";

/** Current authorization is checked by Mail's action port before this callback. */
export const mailWorkflowAiScope = async (ctx: WorkflowActionContext): Promise<WorkflowAiScope> => {
  // Read identity/revision from the durable run's source, never a model-supplied value.
  const [source] = await sql<{ id: string; revision: string }[]>`
    SELECT message.short_id AS id, message.content_hash AS revision
    FROM workflows.run run
    JOIN mail.message_contents message ON message.mailbox_id::text = run.scope_id
      AND message.short_id = run.context #>> '{source,message,id}'
    WHERE run.id = ${ctx.runId}::uuid
  `;
  if (!source)
    throw Object.assign(new Error("AI requires a message in the workflow mailbox. Inspect the message or start a message-bound run."), {
      code: "WORKFLOW_AI_SOURCE_UNAVAILABLE",
    });
  return {
    sourceId: source.id,
    sourceRevision: source.revision,
    budget: env.WORKFLOW_AI_BUDGET,
    recompute: ctx.invocation.context?.recomputeAi === true,
  };
};
