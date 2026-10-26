import { toPgUuidArray } from "@k2b/cloud/services";
import { type WorkflowDiagnostic, type WorkflowIr, type WorkflowJsonValue, workflowPathKey } from "@k2b/cloud/workflows";
import { compileWorkflow } from "@k2b/cloud/workflows/language";
import { evaluateWorkflowTriggerInputs } from "@k2b/cloud/workflows/runtime";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { z } from "zod";
import { type TryWorkflowInput, tryWorkflowInputSchema, type WorkflowTryResult } from "../contracts";
import { bindMailWorkflow } from "../workflows/binder";
import { buildMailWorkflowCatalog, getMailWorkflowCatalogRef, snapshotMailWorkflowCatalog } from "../workflows/catalog";
import { mailWorkflows } from "../workflows/module";
import { validateMailWorkflowTemplates } from "../workflows/template-validation";
import {
  allWorkflowSteps,
  isWorkflowAiAction,
  planMailWorkflowTryItem,
  type WorkflowTryTargetState,
  workflowReferencedTextFields,
} from "../workflows/try";
import { messageVisibleTo, requireMailboxAccess, requireMailboxPermission } from "./access";
import { type MailRequestContext, userBackedActor } from "./auth";
import { sha256Json } from "./canonical";
import { mailMessageTextLength } from "./message-text";
import { loadMailWorkflowCatalog } from "./workflow-catalog-service";
import { getWorkflowSnapshots } from "./workflow-data";
import { getWorkflow } from "./workflow-definition-service";

const cursorSchema = z
  .object({
    version: z.literal(1),
    scope: z.string(),
    ids: z.array(z.string().uuid()).max(100),
    checked: z.number().int().min(0).max(100),
  })
  .strict();
export type WorkflowTryValidationFailure = {
  valid: false;
  source: string;
  sourceHash: string | null;
  ir: null;
  boundPlan: null;
  diagnostics: WorkflowDiagnostic[];
};
export type WorkflowTryResponse = WorkflowTryResult | WorkflowTryValidationFailure;

/** Resolve static targets once for the batch, including unreachable targets in unselected branches. */
const prepareTargets = async (params: { context: MailRequestContext; mailboxId: string; ir: WorkflowIr }) => {
  const catalog = await loadMailWorkflowCatalog(params);
  const snapshot = snapshotMailWorkflowCatalog(catalog);
  const availableFolders = [...snapshot.folders];
  const state: WorkflowTryTargetState = { problems: new Map(), labels: new Map() };
  const steps = allWorkflowSteps(params.ir.steps).filter((step) => step.kind === "action");
  const preflight: WorkflowTryResult["preflight"] = {
    targets: [],
    sends: steps.some((step) => ["automaticReply", "scheduleDraftSend"].includes(step.action)),
    writesDrafts: steps.some((step) => ["automaticReply", "createDraft", "createReplyDraft"].includes(step.action)),
    aiSteps: steps.filter((step) => isWorkflowAiAction(step.action)).length,
  };
  const directoryUser = userBackedActor(params.context);
  const userRefs = steps.flatMap((step) => (typeof step.config.user === "string" ? [step.config.user] : []));
  const folderRefs = steps.flatMap((step) => (typeof step.config.folder === "string" ? [step.config.folder] : []));
  const [users, folders] = await Promise.all([
    userRefs.length
      ? sql<{ value: string; exists: boolean }[]>`
      SELECT ref.value, EXISTS (SELECT 1 FROM auth.users u
        WHERE (u.id::text = ref.value OR u.display_name = ref.value OR u.uid = ref.value)
          AND (u.account_expires IS NULL OR u.account_expires > now())
          AND (${directoryUser?.roles.includes("user") ?? false} OR u.id = ${directoryUser?.id ?? null}::uuid)) AS exists
      FROM jsonb_array_elements_text(${[...new Set(userRefs)]}::jsonb) ref(value)
    `
      : [],
    folderRefs.length
      ? sql<{ value: string; exists: boolean }[]>`
      SELECT ref.value, EXISTS (SELECT 1 FROM mail.folders f
        JOIN mail.remote_resources r ON r.id = f.remote_resource_id
        WHERE r.mailbox_id = ${params.mailboxId}::uuid AND (f.short_id = ref.value OR f.name = ref.value)) AS exists
      FROM jsonb_array_elements_text(${[...new Set(folderRefs)]}::jsonb) ref(value)
    `
      : [],
  ]);
  for (const step of steps) {
    const role =
      step.action === "archiveMessage"
        ? "archive"
        : step.action === "trashMessage"
          ? "trash"
          : step.action === "junkMessage"
            ? "junk"
            : null;
    if (role) {
      const folders = availableFolders.filter((folder) => folder.role === role);
      const folder = folders.length === 1 ? folders[0] : undefined;
      const value = folder?.name ?? role;
      const problem = folder ? null : "target_missing";
      if (!preflight.targets.some((target) => target.kind === "folder" && target.value === value)) {
        preflight.targets.push({ kind: "folder", value, ok: !problem, problem });
      }
      if (!folder) {
        state.problems.set(workflowPathKey(step.sourcePath), [
          { code: "target_missing", path: [...step.sourcePath, step.action, "folder"], target: role },
        ]);
        snapshot.folders = snapshot.folders.filter((folder) => folder.role !== role);
        snapshot.folders.push({ id: `preview:${role}`, name: role, role });
      }
      state.labels.set(workflowPathKey([...step.sourcePath, step.action, "folder"]), value);
    }
    for (const field of ["user", "folder", "tag", "sender"] as const) {
      const value = step.config[field];
      if (typeof value !== "string" || value.includes("${{")) continue;
      const index =
        field === "user"
          ? step.action === "notifyUser"
            ? catalog.notificationUsers
            : catalog.assignableUsers
          : field === "folder"
            ? catalog.folders
            : field === "tag"
              ? catalog.localTags
              : catalog.senderIdentities;
      const resolved = getMailWorkflowCatalogRef(index, value);
      const exists =
        resolved ||
        (field === "user"
          ? users.some((user) => user.value === value && user.exists)
          : field === "folder"
            ? folders.some((folder) => folder.value === value && folder.exists)
            : false);
      const problem = resolved ? null : exists ? "target_no_access" : "target_missing";
      const path = [...step.sourcePath, step.action, field];
      if (problem)
        state.problems.set(workflowPathKey(step.sourcePath), [
          ...(state.problems.get(workflowPathKey(step.sourcePath)) ?? []),
          { code: problem, path, target: value },
        ]);
      else if (resolved) state.labels.set(workflowPathKey(path), resolved.name);
      if (field === "user" || field === "folder") {
        const kind = field === "user" ? "user" : "folder";
        if (!preflight.targets.some((target) => target.kind === kind && target.value === value))
          preflight.targets.push({ kind, value, ok: !problem, problem });
      }
      // An inaccessible static target is a per-item problem, not invalid YAML. Bind a
      // preview-only placeholder so other conditions and branches remain inspectable.
      if (!resolved) {
        const entry = { id: value, name: value };
        if (field === "user") (step.action === "notifyUser" ? snapshot.notificationUsers! : snapshot.assignableUsers).push(entry);
        else if (field === "folder") snapshot.folders.push(entry);
        else if (field === "tag") snapshot.localTags!.push(entry);
        else snapshot.senderIdentities!.push(entry);
      }
    }
  }
  return { catalog: buildMailWorkflowCatalog(snapshot), state, preflight };
};

export const tryWorkflow = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  input: TryWorkflowInput;
}): Promise<Result<WorkflowTryResponse>> => {
  const parsed = tryWorkflowInputSchema.safeParse(params.input);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid workflow preview"));
  const input = parsed.data;
  const access = await requireMailboxAccess(params.context, params.mailboxId, "read");
  if (!access.ok) return access;
  let source: string;
  if (input.source !== undefined) {
    const allowed = await requireMailboxPermission(params.context, params.mailboxId, "admin");
    if (!allowed.ok) return allowed;
    source = input.source;
  } else {
    const workflow = await getWorkflow(params.context, params.mailboxId, input.workflowId!);
    if (!workflow.ok) return workflow;
    source = workflow.data.currentVersion.source;
  }
  const compiled = await compileWorkflow(source, mailWorkflows);
  if (!compiled.ok) return ok({ valid: false, source, sourceHash: null, ir: null, boundPlan: null, diagnostics: compiled.diagnostics });
  const invalid = (diagnostics: WorkflowDiagnostic[]): Result<WorkflowTryValidationFailure> =>
    ok({
      valid: false,
      source,
      sourceHash: compiled.ir.sourceHash,
      ir: null,
      boundPlan: null,
      diagnostics,
    });
  const templateDiagnostics = validateMailWorkflowTemplates(compiled.ir);
  if (templateDiagnostics.length) return invalid(templateDiagnostics);
  const targets = await prepareTargets({ ...params, ir: compiled.ir });
  const bound = await bindMailWorkflow(compiled.ir, targets.catalog);
  if (!bound.ok) return invalid(bound.diagnostics);
  const plan = bound.plan;
  const scope = sha256Json({
    mailboxId: params.mailboxId,
    subject: params.context.accessSubject,
    sourceHash: plan.sourceHash,
    last: input.last,
  });
  let ids: string[];
  let checked = 0;
  if (input.cursor) {
    try {
      const cursor = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString()));
      if (
        cursor.scope !== scope ||
        cursor.checked >= cursor.ids.length ||
        cursor.ids.length > input.last ||
        new Set(cursor.ids).size !== cursor.ids.length
      )
        return fail(err.badInput("Invalid workflow preview cursor"));
      ids = cursor.ids;
      checked = cursor.checked;
    } catch {
      return fail(err.badInput("Invalid workflow preview cursor"));
    }
  } else {
    // Same active placement window as incoming automation backfills. A message may
    // have several placements: select it once, then keep the window fixed in the cursor.
    const rows = await sql<{ id: string }[]>`
      SELECT candidate.id FROM (
        SELECT DISTINCT ON (message.id) remote_ref.id::text AS id, message.id AS message_id, message.internal_date
        FROM mail.remote_message_refs remote_ref
        JOIN mail.message_placements placement ON placement.remote_message_ref_id = remote_ref.id AND placement.deleted_at IS NULL
        JOIN mail.folders folder ON folder.id = placement.folder_id AND folder.discovery_state = 'active'
        JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
        JOIN mail.message_contents message ON message.id = remote_ref.message_id
        JOIN mail.conversation_messages cm ON cm.message_id = message.id
        WHERE resource.mailbox_id = ${params.mailboxId}::uuid AND remote_ref.stale_at IS NULL
          AND ${messageVisibleTo(access.data, sql`message.id`)}
        ORDER BY message.id, remote_ref.id
      ) candidate ORDER BY candidate.internal_date DESC, candidate.message_id DESC LIMIT ${input.last}
    `;
    ids = rows.map((row) => row.id);
  }
  const batchIds = ids.slice(checked, checked + input.batch);
  // Recheck current visibility on every request, including a replayed or edited cursor.
  const visible = batchIds.length
    ? await sql<{ id: string }[]>`
    SELECT DISTINCT remote_ref.id::text AS id FROM mail.remote_message_refs remote_ref
    JOIN mail.message_contents message ON message.id = remote_ref.message_id
    JOIN mail.message_placements placement ON placement.remote_message_ref_id = remote_ref.id AND placement.deleted_at IS NULL
    JOIN mail.folders folder ON folder.id = placement.folder_id AND folder.discovery_state = 'active'
    JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
    JOIN mail.conversation_messages cm ON cm.message_id = message.id
    WHERE message.mailbox_id = ${params.mailboxId}::uuid AND resource.mailbox_id = ${params.mailboxId}::uuid
      AND remote_ref.stale_at IS NULL
      AND remote_ref.id = ANY(${toPgUuidArray(batchIds)}::uuid[])
      AND ${messageVisibleTo(access.data, sql`message.id`)}
  `
    : [];
  const snapshots = await getWorkflowSnapshots({ mailboxId: params.mailboxId, remoteMessageRefIds: visible.map((row) => row.id) });
  const fields = workflowReferencedTextFields(plan);
  const bodies =
    fields.size && visible.length
      ? await sql<{ id: string; plain_text: string | null; sanitized_html: string | null }[]>`
    SELECT message.id::text, ${fields.has("bodyText") ? sql`message.plain_text` : sql`NULL::text`} AS plain_text,
      ${fields.has("bodyHtml") ? sql`message.sanitized_html` : sql`NULL::text`} AS sanitized_html
    FROM mail.message_contents message JOIN mail.remote_message_refs remote_ref ON remote_ref.message_id = message.id
    WHERE remote_ref.id = ANY(${toPgUuidArray(visible.map((row) => row.id))}::uuid[]) AND message.mailbox_id = ${params.mailboxId}::uuid
  `
      : [];
  const occurredAt = new Date().toISOString();
  const items: WorkflowTryResult["items"] = [];
  for (const id of batchIds) {
    const snapshot = snapshots.get(id);
    if (!snapshot?.source.conversation) continue;
    const body = bodies.find((body) => body.id === snapshot.preconditions.message.id);
    if (body) {
      snapshot.source.message.body = snapshot.source.message.bodyText = body.plain_text ?? "";
      snapshot.source.message.bodyHtml = body.sanitized_html ?? "";
      snapshot.source.message.textLength = body.plain_text === null ? null : mailMessageTextLength(body.plain_text);
    }
    const message: Record<string, WorkflowJsonValue> = { ...snapshot.source.message };
    const conversation: Record<string, WorkflowJsonValue> = { ...snapshot.source.conversation };
    const trigger = plan.triggers.find((trigger) => trigger.kind === "messageReceived");
    const inputs = trigger
      ? evaluateWorkflowTriggerInputs({ message, conversation, occurredAt }, trigger.with, occurredAt)
      : Object.fromEntries(plan.inputs.map((input) => [input.name, input.type === "mailMessage" ? message : conversation]));
    items.push(
      await planMailWorkflowTryItem({
        plan,
        source: snapshot.source,
        inputs,
        targets: targets.state,
        occurredAt,
        unavailableTextFields: [...fields].filter(
          (field) => !body || (field === "bodyHtml" ? body.sanitized_html === null : body.plain_text === null),
        ),
      }),
    );
  }
  checked += batchIds.length;
  return ok({
    window: { last: input.last, total: ids.length },
    checked,
    items,
    cursor: checked < ids.length ? Buffer.from(JSON.stringify({ version: 1, scope, ids, checked })).toString("base64url") : null,
    aiCalls: items.reduce((total, item) => ({ min: total.min + item.aiCalls.min, max: total.max + item.aiCalls.max }), { min: 0, max: 0 }),
    maxAiCallsPerDay: null,
    preflight: targets.preflight,
  });
};
