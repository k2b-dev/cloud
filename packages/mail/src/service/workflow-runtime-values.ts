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
  return isObject(input)
    ? { message: input, field, tail: parts.slice(3), frozenKey: `inputs.${parts[1]}.${field === "body" ? "bodyText" : field}` }
    : null;
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

export const normalizeMailWorkflowFrozenHydration = (frozen: JsonObject): void => {
  // Runs frozen before #1313 may have only the legacy plain-text body key.
  for (const [key, value] of Object.entries(frozen)) {
    if (/^inputs\.[^.]+\.body$/.test(key) && !Object.hasOwn(frozen, `${key}Text`)) {
      frozen[`${key}Text`] = value;
    }
  }
};

type MailBodyField = "body" | "bodyText" | "bodyHtml";
// Body fields this run has loaded into a projected message. Aliased inputs share the object, so the
// marks hold for every input name; a loaded body may be "".
const loadedBodyFields = new WeakMap<JsonObject, Set<MailBodyField>>();

export const mailWorkflowBodyFieldLoaded = (message: JsonObject, field: MailBodyField): boolean =>
  message.bodyAvailable === true || (loadedBodyFields.get(message)?.has(field) ?? false);

export const projectMailWorkflowFrozenBody = (name: string, message: WorkflowJsonValue | undefined, frozen: JsonObject): void => {
  if (!isObject(message) || message.bodyAvailable === true) return;
  const plainKey = `inputs.${name}.bodyText`;
  const htmlKey = `inputs.${name}.bodyHtml`;
  const loaded = loadedBodyFields.get(message) ?? new Set<MailBodyField>();
  loadedBodyFields.set(message, loaded);
  // Mutate the shared projection so action contexts and restored aliases see the same body.
  if (Object.hasOwn(frozen, plainKey)) {
    message.body = message.bodyText = frozen[plainKey]!;
    loaded.add("body").add("bodyText");
  }
  if (Object.hasOwn(frozen, htmlKey)) {
    message.bodyHtml = frozen[htmlKey]!;
    loaded.add("bodyHtml");
  }
  if (loaded.size === 3) message.bodyAvailable = true;
};

export const createMailWorkflowValueResolver = (params: {
  claim: Pick<WorkflowRunClaim, "runId" | "executionGeneration" | "inputs">;
  mailboxId: string;
  frozenHydration: Record<string, WorkflowJsonValue>;
  mailActionNames: ReadonlySet<string>;
}): WorkflowValueResolverPort => {
  const hasFrozen = (key: string) => Object.hasOwn(params.frozenHydration, key);
  const freeze = async (reference: string, value: WorkflowJsonValue): Promise<WorkflowJsonValue> => {
    const frozen = await freezeHydrationValue({
      runId: params.claim.runId,
      executionGeneration: params.claim.executionGeneration,
      reference,
      value,
    });
    params.frozenHydration[reference] = frozen;
    return frozen;
  };
  const hydrateWholeMessage = async (name: string): Promise<void> => {
    const message = params.claim.inputs[name];
    if (!isObject(message) || message.bodyAvailable === true) return;
    if (typeof message.id !== "string") return;
    const entries: Array<{ key: string; value: WorkflowJsonValue }> = [];
    for (const field of ["bodyText", "bodyHtml"] as const) {
      const key = `inputs.${name}.${field}`;
      if (hasFrozen(key)) continue;
      const hydrated = await hydratedMessageValue(params.mailboxId, message.id, field);
      // Whole values keep receipt-time behavior: pending or unavailable bodies do not block the step.
      if (hydrated.state !== "resolved") return;
      entries.push({ key, value: hydrated.value });
    }
    for (const entry of entries) await freeze(entry.key, entry.value);
    projectMailWorkflowFrozenBody(name, message, params.frozenHydration);
  };
  return {
    resolve: async ({ reference, path, plan, fallback }) => {
      const candidate = messageForReference(reference, params.claim.inputs);
      if (!candidate) {
        const action = path.at(-2);
        const referenceOnly = path.at(-1) === "message" && typeof action === "string" && params.mailActionNames.has(action);
        if (!referenceOnly) {
          for (const input of plan.inputs) {
            if (input.type === "mailMessage" && (reference === "inputs" || reference === `inputs.${input.name}`)) {
              await hydrateWholeMessage(input.name);
            }
          }
        }
        const value = fallback();
        return value === undefined ? { state: "missing" } : { state: "resolved", value };
      }

      const available =
        candidate.field === "attachments"
          ? candidate.message.attachmentsAvailable === true
          : mailWorkflowBodyFieldLoaded(candidate.message, candidate.field);
      if (available) {
        const value = fallback();
        return value === undefined ? { state: "missing" } : { state: "resolved", value };
      }

      if (!hasFrozen(candidate.frozenKey)) {
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
        await freeze(candidate.frozenKey, hydrated.value);
      }
      if (candidate.field !== "attachments")
        projectMailWorkflowFrozenBody(reference.split(".")[1]!, candidate.message, params.frozenHydration);
      return resolvedPath(params.frozenHydration[candidate.frozenKey]!, candidate.tail);
    },
  };
};
