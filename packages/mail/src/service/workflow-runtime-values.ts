import type { WorkflowJsonValue } from "@k2b/cloud/workflows";
import { readWorkflowValuePath } from "@k2b/cloud/workflows/language";
import type { WorkflowValueResolverPort } from "@k2b/cloud/workflows/runtime";
import type { WorkflowRunClaim } from "@k2b/cloud/workflows/store";
import { sql } from "bun";
import { resolveMailboxPublicId } from "./public-resources";
import { enqueueMessageHydration } from "./sync-runtime";
import { mailWorkflowDependencyDeadline } from "./workflow-dependencies";

type JsonObject = Record<string, WorkflowJsonValue>;
type HydratedMessageValue =
  | { state: "resolved"; value: WorkflowJsonValue }
  | { state: "pending"; messageId: string }
  | { state: "unavailable" };

const isObject = (value: WorkflowJsonValue | undefined): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const messageForReference = (
  reference: string,
  inputs: Record<string, WorkflowJsonValue>,
): { message: JsonObject; field: "body" | "bodyText" | "bodyHtml" | "attachments"; tail: string[]; frozenKey: string } | null => {
  const parts = reference.split(".");
  const field = parts[2];
  if (parts[0] !== "inputs" || !parts[1] || (field !== "body" && field !== "bodyText" && field !== "bodyHtml" && field !== "attachments")) {
    return null;
  }
  const input = inputs[parts[1]];
  return isObject(input) ? { message: input, field, tail: parts.slice(3), frozenKey: parts.slice(0, 3).join(".") } : null;
};

const hydratedMessageValue = async (
  mailboxId: string,
  publicMessageId: string,
  field: "body" | "bodyText" | "bodyHtml" | "attachments",
): Promise<HydratedMessageValue> => {
  const messageId = await resolveMailboxPublicId("messages", mailboxId, publicMessageId);
  if (!messageId) return { state: "unavailable" };
  const [message] = await sql<
    { hydration_status: string; hydration_attempt: number; plain_text: string | null; sanitized_html: string | null }[]
  >`
    SELECT hydration_status, hydration_attempt, plain_text, sanitized_html
    FROM mail.message_contents
    WHERE id = ${messageId}::uuid
      AND mailbox_id = ${mailboxId}::uuid
  `;
  if (!message || (message.hydration_status === "failed" && message.hydration_attempt >= 5)) return { state: "unavailable" };
  if (field === "body" || field === "bodyText") {
    return message.hydration_status === "body" || message.hydration_status === "complete"
      ? { state: "resolved", value: message.plain_text ?? "" }
      : { state: "pending", messageId };
  }
  if (field === "bodyHtml") {
    return message.hydration_status === "body" || message.hydration_status === "complete"
      ? { state: "resolved", value: message.sanitized_html ?? "" }
      : { state: "pending", messageId };
  }
  if (message.hydration_status !== "complete") return { state: "pending", messageId };
  const rows = await sql<
    {
      id: string;
      filename: string | null;
      content_type: string;
      disposition: string | null;
      content_id: string | null;
      size_bytes: string | number;
    }[]
  >`
    SELECT attachment.short_id AS id, attachment.filename, attachment.content_type, attachment.disposition,
      attachment.content_id, attachment.size_bytes
    FROM mail.attachments attachment
    JOIN mail.message_contents message ON message.id = attachment.message_id
    JOIN mail.message_parts part ON part.id = attachment.part_id
    WHERE attachment.message_id = ${messageId}::uuid
      AND message.mailbox_id = ${mailboxId}::uuid
    ORDER BY part.part_path, attachment.id
  `;
  return {
    state: "resolved",
    value: rows.map((row) => ({
      id: row.id,
      filename: row.filename,
      contentType: row.content_type,
      disposition: row.disposition,
      contentId: row.content_id,
      sizeBytes: Number(row.size_bytes),
    })),
  };
};

const resolvedPath = (value: WorkflowJsonValue, tail: readonly string[]): ReturnType<WorkflowValueResolverPort["resolve"]> => {
  const resolved = tail.length === 0 ? value : readWorkflowValuePath(value, tail);
  return Promise.resolve(resolved === undefined ? { state: "missing" } : { state: "resolved", value: resolved });
};

const freezeHydrationValue = async (params: {
  runId: string;
  executionGeneration: number;
  reference: string;
  value: WorkflowJsonValue;
}): Promise<WorkflowJsonValue> =>
  sql.begin(async (tx) => {
    const [active] = await tx<{ id: string }[]>`
      SELECT id
      FROM workflows.run
      WHERE id = ${params.runId}::uuid
        AND state = 'running'
        AND execution_generation = ${params.executionGeneration}
        AND lease_expires_at >= now()
        AND cancel_requested_at IS NULL
      FOR UPDATE
    `;
    if (!active) throw new Error("Workflow execution lease was lost while freezing hydrated Mail content");
    const [state] = await tx<{ frozen_hydration: Record<string, WorkflowJsonValue> | string }[]>`
      INSERT INTO mail.workflow_run_state (run_id)
      VALUES (${params.runId}::uuid)
      ON CONFLICT (run_id) DO UPDATE SET updated_at = mail.workflow_run_state.updated_at
      RETURNING frozen_hydration
    `;
    const frozen = typeof state?.frozen_hydration === "string" ? JSON.parse(state.frozen_hydration) : (state?.frozen_hydration ?? {});
    if (Object.prototype.hasOwnProperty.call(frozen, params.reference)) return frozen[params.reference]!;
    await tx`
      UPDATE mail.workflow_run_state
      SET frozen_hydration = frozen_hydration || jsonb_build_object(${params.reference}::text, ${params.value}::jsonb),
          updated_at = now()
      WHERE run_id = ${params.runId}::uuid
    `;
    return params.value;
  });

export const createMailWorkflowValueResolver = (params: {
  claim: Pick<WorkflowRunClaim, "runId" | "executionGeneration" | "inputs">;
  mailboxId: string;
  frozenHydration: Record<string, WorkflowJsonValue>;
}): WorkflowValueResolverPort => ({
  resolve: async ({ reference, fallback }) => {
    const candidate = messageForReference(reference, params.claim.inputs);
    if (!candidate) {
      const value = fallback();
      return value === undefined ? { state: "missing" } : { state: "resolved", value };
    }

    const available =
      candidate.field === "attachments" ? candidate.message.attachmentsAvailable === true : candidate.message.bodyAvailable === true;
    if (available) {
      const value = fallback();
      return value === undefined ? { state: "missing" } : { state: "resolved", value };
    }

    if (Object.prototype.hasOwnProperty.call(params.frozenHydration, candidate.frozenKey)) {
      return resolvedPath(params.frozenHydration[candidate.frozenKey]!, candidate.tail);
    }

    const messageId = candidate.message.id;
    if (typeof messageId !== "string") return { state: "missing" };
    const hydrated = await hydratedMessageValue(params.mailboxId, messageId, candidate.field);
    if (hydrated.state === "unavailable") return { state: "missing" };
    if (hydrated.state === "pending") {
      await enqueueMessageHydration(hydrated.messageId);
      return {
        state: "waiting",
        dependency: {
          kind: "mail.hydration",
          key: hydrated.messageId,
          deadline: mailWorkflowDependencyDeadline(),
          data: { runId: params.claim.runId },
        },
      };
    }

    const frozen = await freezeHydrationValue({
      runId: params.claim.runId,
      executionGeneration: params.claim.executionGeneration,
      reference: candidate.frozenKey,
      value: hydrated.value,
    });
    params.frozenHydration[candidate.frozenKey] = frozen;
    return resolvedPath(frozen, candidate.tail);
  },
});
