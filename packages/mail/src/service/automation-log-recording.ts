import type { WorkflowBoundPlan, WorkflowIrStep } from "@k2b/cloud/workflows";
import { sql } from "bun";
import type { ActorRef, AuditStep, AutomationLogItem } from "../contracts";
import { actorRefFromRequest, type MailRequestContext, userBackedActor } from "./auth";
import { enqueueMailInvalidation, mailLive } from "./live";

type SqlClient = typeof sql;
type Reason = AutomationLogItem["reasons"][number];
type Effect = AutomationLogItem["effects"][number];
export const jsonRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const parsed = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};
const journalOutcome = (value: unknown): Record<string, unknown> => jsonRecord(jsonRecord(parsed(value)).outcome);
const iso = (value: Date | string): string => new Date(value).toISOString();
const allSteps = (steps: WorkflowIrStep[]): WorkflowIrStep[] =>
  steps.flatMap((step) => [
    step,
    ...(step.kind === "if"
      ? [...allSteps(step.then), ...allSteps(step.else)]
      : step.kind === "switch"
        ? [...step.cases.flatMap((branch) => allSteps(branch.steps)), ...allSteps(step.default)]
        : step.kind === "forEach"
          ? allSteps(step.steps)
          : []),
  ]);

export const automationConversationSnapshot = async (db: SqlClient, mailboxId: string, conversationId: string) => {
  const [row] = await db<{ id: string; subject: string; mailbox_id: string; sender_name: string | null; sender_email: string | null }[]>`
    SELECT conversation.short_id AS id, conversation.subject, mailbox.short_id AS mailbox_id,
      sender.display_name AS sender_name, sender.email AS sender_email
    FROM mail.conversations conversation JOIN mail.mailboxes mailbox ON mailbox.id = conversation.mailbox_id
    LEFT JOIN LATERAL (
      SELECT address.display_name, address.email FROM mail.conversation_messages link
      JOIN mail.message_contents message ON message.id = link.message_id
      JOIN mail.message_addresses address ON address.message_id = message.id AND address.role = 'from'
      WHERE link.conversation_id = conversation.id ORDER BY message.internal_date DESC, message.id DESC, address.position LIMIT 1
    ) sender ON true
    WHERE conversation.id = ${conversationId}::uuid AND conversation.mailbox_id = ${mailboxId}::uuid
  `;
  return row
    ? {
        id: row.id,
        subject: row.subject,
        from: { name: row.sender_name, email: row.sender_email ?? "" },
        href: `/app/mail/${encodeURIComponent(row.mailbox_id)}?conversation=${encodeURIComponent(row.id)}`,
      }
    : null;
};

/** Assignment provenance and a person's change commit with the collaboration mutation. */
export const recordAutomationAssignmentChange = async (params: {
  db: SqlClient;
  mailboxId: string;
  conversationId: string;
  context: MailRequestContext | null;
  actorOverride?: ActorRef;
  activityMetadata?: Record<string, unknown>;
  before: string[];
  after: string[];
}): Promise<void> => {
  const actor = params.actorOverride ?? (params.context ? actorRefFromRequest(params.context) : null);
  if (actor?.kind === "workflow") {
    const runId = params.activityMetadata?.workflowRunId;
    if (typeof runId !== "string" || params.after.length !== 1) return;
    await params.db`
      INSERT INTO mail.automation_assignment (conversation_id, mailbox_id, workflow_id, run_id, user_id)
      SELECT ${params.conversationId}::uuid, ${params.mailboxId}::uuid, workflow_id, ${runId}::uuid, ${params.after[0]}::uuid
      FROM workflows.version WHERE id = ${actor.workflowVersionId}::uuid
      ON CONFLICT (conversation_id) DO UPDATE SET workflow_id = EXCLUDED.workflow_id, run_id = EXCLUDED.run_id,
        user_id = EXCLUDED.user_id, changed_by_id = NULL, changed_by_name = NULL, changed_at = NULL, updated_at = now()
    `;
    return;
  }
  // Undo/redo owns its provenance transitions and writes a separate operation row.
  if (params.activityMetadata?.automationLogOperation) return;
  const [provenance] = await params.db<{ workflow_id: string; name: string }[]>`
    SELECT assignment.workflow_id, workflow.name FROM mail.automation_assignment assignment
    LEFT JOIN workflows.workflow workflow ON workflow.id = assignment.workflow_id
    WHERE assignment.conversation_id = ${params.conversationId}::uuid FOR UPDATE OF assignment
  `;
  if (!provenance || !actor || !params.context) return;
  const person = userBackedActor(params.context);
  const userId = person?.id ?? (actor.kind === "service_account" ? actor.serviceAccountId : "");
  const name = person?.displayName ?? (params.context.actor.kind === "service_account" ? params.context.actor.serviceAccount.name : "");
  await params.db`UPDATE mail.automation_assignment SET changed_by_id = ${userId}, changed_by_name = ${name}, changed_at = now(), updated_at = now()
    WHERE conversation_id = ${params.conversationId}::uuid`;
  const snapshot = await automationConversationSnapshot(params.db, params.mailboxId, params.conversationId);
  if (!snapshot) return;
  const names = async (ids: string[]) => {
    if (!ids.length) return null;
    const rows = await params.db<
      { display_name: string }[]
    >`SELECT display_name FROM auth.users WHERE id = ANY(${`{${ids.join(",")}}`}::uuid[]) ORDER BY display_name, id`;
    return rows.map((row) => row.display_name).join(", ");
  };
  const before = await names(params.before),
    after = await names(params.after);
  const effects: Effect[] = params.after.length ? await assignmentEffects(params.db, params.after) : [{ kind: "unassign" }];
  const id = crypto.randomUUID();
  const item: AutomationLogItem = {
    id,
    at: new Date().toISOString(),
    conversation: snapshot,
    by: { kind: "person", userId, name },
    outcome: "manual_change",
    effects,
    reasons: [
      {
        kind: "manual",
        before: before ? { kind: "user", name: before, byRule: provenance.name } : null,
        after: after ? { kind: "user", name: after } : null,
      },
    ],
    undo: { state: "none", reason: null, by: null, at: null },
  };
  await params.db`INSERT INTO mail.automation_log (id, mailbox_id, conversation_id, item, created_at)
    VALUES (${id}::uuid, ${params.mailboxId}::uuid, ${params.conversationId}::uuid, ${item}, ${item.at}::timestamptz)`;
};

const assignmentEffects = async (db: SqlClient, ids: string[]): Promise<Effect[]> => {
  if (!ids.length) return [];
  const rows = await db<
    { id: string; display_name: string }[]
  >`SELECT id, display_name FROM auth.users WHERE id = ANY(${`{${ids.join(",")}}`}::uuid[]) ORDER BY id`;
  return rows.map((row) => ({ kind: "assign", target: { kind: "user", id: row.id, name: row.display_name } }));
};

type OutcomeRow = {
  step_key: string;
  source_path: Array<string | number>;
  action: string | null;
  kind: string;
  state: string;
  outcome: unknown;
  effect_output: unknown;
};

/** Pure projection of evidence already in the journal; this never makes an AI request. */
export const projectAutomationAudit = async (
  db: SqlClient,
  params: {
    steps: WorkflowIrStep[];
    outcomes: OutcomeRow[];
    conversationId: string;
    evidenceConversationId: string | null;
    ai: Array<{ kind: string; request: unknown; output: unknown; status: string }>;
  },
): Promise<{ effects: Effect[]; reasons: Reason[]; fixedRows: AuditStep[]; skipped: boolean }> => {
  const effects: Effect[] = [],
    reasons: Reason[] = [],
    fixedRows: AuditStep[] = [];
  let skipped = false;
  const evidenceVisible = params.conversationId === params.evidenceConversationId;
  for (const task of evidenceVisible ? params.ai : []) {
    if (task.status !== "succeeded") continue;
    const request = jsonRecord(parsed(task.request)),
      output = parsed(task.output);
    if (task.kind === "classify" && typeof output === "string")
      reasons.push({
        kind: "ai_choice",
        value: output,
        choices: Array.isArray(request.choices) ? request.choices.filter((choice): choice is string => typeof choice === "string") : [],
      });
    if (task.kind === "extract_data")
      for (const [field, value] of Object.entries(jsonRecord(output))) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
          reasons.push({ kind: "ai_value", field, value, evidence: null });
      }
  }
  const planned = allSteps(params.steps);
  for (const row of params.outcomes) {
    const outcome = journalOutcome(row.outcome);
    if (row.kind === "if" && evidenceVisible) {
      const step = planned.find((step) => step.kind === "if" && JSON.stringify(step.sourcePath) === JSON.stringify(row.source_path));
      const branches = jsonRecord(outcome.control).branches;
      if (step?.kind === "if" && Array.isArray(branches)) {
        const text = JSON.stringify(step.condition),
          met = branches[0] === "then";
        reasons.push({ kind: "comparison", text, met });
        if (met && !params.ai.length) reasons.push({ kind: "condition", text });
      }
    }
    if (!row.action) continue;
    const output = jsonRecord(parsed(row.effect_output ?? outcome.output));
    if (typeof output.conversationId === "string" ? output.conversationId !== params.conversationId : !evidenceVisible) continue;
    if (output.skipped === "upper_rule") {
      skipped = true;
      if (typeof output.workflowId === "string")
        reasons.push({
          kind: "skipped_upper_rule",
          workflowId: output.workflowId,
          name: typeof output.name === "string" ? output.name : "",
        });
    } else if (output.skipped === "already_assigned" || output.skipped === "undone_before") {
      skipped = true;
      reasons.push({ kind: output.skipped });
    } else if (output.skipped) {
      skipped = true;
      if (output.skipped === "order_expired") reasons.push({ kind: "condition", text: "automation_order = expired" });
    }
    if (output.applied !== true) continue;
    const action = row.action;
    if (action === "assignConversation" && typeof output.value === "string") effects.push(...(await assignmentEffects(db, [output.value])));
    if (action === "setConversationStatus" && (output.value === "needs_action" || output.value === "waiting" || output.value === "done"))
      effects.push({ kind: "status", status: output.value });
    if (action === "addLocalTag") {
      const [tag] = await db<
        { name: string }[]
      >`SELECT name FROM mail.local_tags WHERE short_id = ${String(output.value ?? output.tagId ?? "")}`;
      if (tag) effects.push({ kind: "tag", name: tag.name });
    }
    if (action === "addFlag" && output.value === "seen") effects.push({ kind: "read" });
    if (action === "addComment") effects.push({ kind: "comment" });
    if (action === "setConversationSummary") effects.push({ kind: "summary" });
    if (["moveMessage", "archiveMessage", "trashMessage", "junkMessage"].includes(action)) {
      if (action === "archiveMessage") effects.push({ kind: "archive" });
      else {
        const [folder] = await db<{ name: string }[]>`SELECT name FROM mail.folders WHERE short_id = ${String(output.value ?? "")}`;
        if (folder) effects.push({ kind: "move", folder: folder.name });
      }
    }
  }
  const choice = reasons.find((reason) => reason.kind === "ai_choice");
  const assignment = effects.find((effect) => effect.kind === "assign");
  if (assignment?.kind === "assign")
    fixedRows.push({
      kind: "fixed_row",
      text: [
        ...reasons.filter((reason) => reason.kind === "ai_choice").map((reason) => reason.value),
        ...reasons.filter((reason) => reason.kind === "comparison").map((reason) => `${reason.text} = ${reason.met}`),
        `→ ${assignment.target.name}`,
      ].join(" · "),
      target: { kind: assignment.target.kind, name: assignment.target.name },
    });
  if (choice?.kind === "ai_choice" && !assignment && !skipped) {
    reasons.push({ kind: "no_target", choice: choice.value });
    fixedRows.push({ kind: "fixed_row", text: choice.value, target: null });
  }
  return { effects, reasons, fixedRows, skipped };
};

/** Rebuild one run's groups after a journal transition, also on replay after a crash. */
const projectMailWorkflowAudit = async (runId: string, db: SqlClient): Promise<void> => {
  const [run] = await db<
    {
      mailbox_id: string;
      mailbox_short_id: string;
      workflow_id: string;
      name: string;
      revision: number;
      context: unknown;
      plan: WorkflowBoundPlan;
      state: string;
      created_at: Date;
      position: number;
    }[]
  >`
    SELECT profile.mailbox_id, mailbox.short_id AS mailbox_short_id, run.workflow_id, workflow.name, version.revision,
      run.context, version.plan, run.state, run.created_at,
      (SELECT count(*)::int FROM mail.workflow_profile other WHERE other.mailbox_id = profile.mailbox_id AND (other.priority, other.id) <= (profile.priority, profile.id)) AS position
    FROM workflows.run run JOIN mail.workflow_profile profile ON profile.id = run.workflow_id
    JOIN mail.mailboxes mailbox ON mailbox.id = profile.mailbox_id JOIN workflows.workflow workflow ON workflow.id = run.workflow_id
    JOIN workflows.version version ON version.id = run.workflow_version_id
    WHERE run.id = ${runId}::uuid AND run.app_id = 'mail' AND run.mode = 'execute'
  `;
  if (!run) return;
  const outcomes = await db<OutcomeRow[]>`SELECT step_key, source_path, action, kind, state, outcome, effect_output
    FROM workflows.step_outcome WHERE run_id = ${runId}::uuid AND (state NOT IN ('running','waiting') OR effect_state = 'succeeded') ORDER BY started_at, step_key`;
  const ai = await db<{ kind: string; request: unknown; output: unknown; status: string }[]>`
    SELECT kind, request, output, status FROM ai.workflow_task WHERE run_id = ${runId}::uuid ORDER BY created_at, id`;
  const context = jsonRecord(parsed(run.context)),
    source = jsonRecord(context.source);
  const conversation = jsonRecord(source.conversation);
  const ids = new Set<string>();
  if (typeof conversation.id === "string") ids.add(conversation.id);
  for (const row of outcomes) {
    const output = jsonRecord(parsed(row.effect_output ?? journalOutcome(row.outcome).output));
    if (typeof output.conversationId === "string") ids.add(output.conversationId);
  }
  const plan = parsed(run.plan) as WorkflowBoundPlan;
  const order = jsonRecord(context.automationOrder);
  const position = typeof order.position === "number" ? order.position : run.position;
  const name = typeof order.name === "string" ? order.name : run.name;
  const hasAi = allSteps(plan.steps).some((step) => step.kind === "action" && step.action.startsWith("ai"));
  for (const id of ids) {
    const [conv] = await db<
      { id: string }[]
    >`SELECT id FROM mail.conversations WHERE mailbox_id = ${run.mailbox_id}::uuid AND short_id = ${id}`;
    if (!conv) continue;
    const snapshot = await automationConversationSnapshot(db, run.mailbox_id, conv.id);
    if (!snapshot) continue;
    const audit = await projectAutomationAudit(db, {
      steps: plan.steps,
      outcomes,
      ai,
      conversationId: id,
      evidenceConversationId: typeof conversation.id === "string" ? conversation.id : null,
    });
    const terminal = ["succeeded", "failed", "canceled", "needs_attention"].includes(run.state);
    if (
      !audit.effects.length &&
      !audit.skipped &&
      !(terminal && (ai.some((task) => task.status === "succeeded") || run.state === "failed" || run.state === "needs_attention"))
    )
      continue;
    const [existing] = await db<
      { id: string; created_at: Date }[]
    >`SELECT id, created_at FROM mail.automation_log WHERE run_id = ${runId}::uuid AND conversation_id = ${conv.id}::uuid`;
    const itemId = existing?.id ?? crypto.randomUUID();
    const uncertain = audit.reasons.some(
      (reason) => reason.kind === "ai_choice" && ["unsicher", "uncertain"].includes(reason.value.toLowerCase()),
    );
    const outcome: AutomationLogItem["outcome"] = ["failed", "needs_attention"].includes(run.state)
      ? "failed"
      : audit.skipped && !audit.effects.length
        ? "skipped"
        : uncertain
          ? "uncertain"
          : audit.effects.some((effect) => effect.kind === "assign")
            ? "assigned"
            : audit.effects.length
              ? "effects"
              : "nobody";
    const item: AutomationLogItem = {
      id: itemId,
      at: iso(existing?.created_at ?? run.created_at),
      conversation: snapshot,
      by: {
        kind: "rule",
        workflowId: run.workflow_id,
        name,
        position,
        version: run.revision,
        ai: hasAi,
        href: `/app/mail/${encodeURIComponent(run.mailbox_short_id)}/automations/workflows`,
      },
      outcome,
      effects: audit.effects,
      reasons: audit.reasons,
      undo: { state: "none", reason: null, by: null, at: null },
    };
    const preconditions = audit.reasons.filter((reason) => reason.kind === "condition").map((reason) => reason.text);
    if (Array.isArray(conversation.assigneeUserIds) && !conversation.assigneeUserIds.length) preconditions.push("assignees = []");
    const chain: AuditStep[] = [
      { kind: "rule_start", name, version: run.revision, position, preconditions },
      ...audit.reasons.filter(
        (reason): reason is Extract<Reason, { kind: "ai_choice" | "ai_value" }> =>
          reason.kind === "ai_choice" || reason.kind === "ai_value",
      ),
      ...audit.fixedRows,
      {
        kind: "result",
        effects: audit.effects,
        unchanged: audit.effects.some((effect) => effect.kind === "status")
          ? []
          : typeof conversation.workStatus === "string"
            ? [`workStatus = ${conversation.workStatus}`]
            : [],
      },
    ];
    const assignment = audit.effects.find((effect) => effect.kind === "assign");
    const changed = await db<
      { id: string }[]
    >`INSERT INTO mail.automation_log (id, mailbox_id, conversation_id, run_id, item, chain, assignment_user_id, created_at)
      VALUES (${itemId}::uuid, ${run.mailbox_id}::uuid, ${conv.id}::uuid, ${runId}::uuid, ${item}, ${chain}, ${assignment?.kind === "assign" ? assignment.target.id : null}::uuid, ${item.at}::timestamptz)
      ON CONFLICT (run_id, conversation_id) DO UPDATE SET item = EXCLUDED.item || jsonb_build_object('id', mail.automation_log.id, 'at', mail.automation_log.item->'at'), chain = EXCLUDED.chain, assignment_user_id = EXCLUDED.assignment_user_id
      WHERE (mail.automation_log.item, mail.automation_log.chain, mail.automation_log.assignment_user_id)
        IS DISTINCT FROM (EXCLUDED.item, EXCLUDED.chain, EXCLUDED.assignment_user_id)
      RETURNING id`;
    if (changed.length) await enqueueMailInvalidation(db, { mailboxId: run.mailbox_id, conversationId: conv.id });
  }
};

/** Serialize competing worker/recovery projections before reading the durable journal. */
export const recordMailWorkflowAudit = async (runId: string, db: SqlClient = sql): Promise<void> => {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mail:automation-log:${runId}`}, 0))`;
    await projectMailWorkflowAudit(runId, tx);
  });
  mailLive.wake();
};
