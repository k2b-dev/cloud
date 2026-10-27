import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import type { RunAiStructuredInput, RunAiStructuredResult } from "@k2b/cloud/ai";
import { workflowPathKey } from "@k2b/cloud/workflows";
import { createWorkflowAiTask } from "@k2b/cloud/workflows/ai";
import { deleteWorkflowScope, emitWorkflowEvent } from "@k2b/cloud/workflows/store";
import type { Result } from "@k2b/stdlib";
import { sql } from "bun";
import { Hono } from "hono";
import type { z } from "zod";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
// Test-only processor seam, shared with the workflow AI store integration suite.
import { processWorkflowAiTask } from "../../../cloud/src/workflows/ai/runtime";
import automationLogRoutes from "../api/automation-log";
import type { MailApiContext } from "../api/public-resource-boundary";
import {
  automationLogDetailSchema,
  automationLogPageSchema,
  automationLogUndoConflictSchema,
  workflowEffectBudgetSchema,
} from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { changeAutomationLogAssignment, getAutomationLogItem, getConversationAutomationTrace, listAutomationLog } from "./automation-log";
import { recordMailWorkflowAudit } from "./automation-log-recording";
import { loadMailAutomationLog } from "./automation-workspace";
import { applyConversationCollaboration } from "./collaboration";
import { createMailbox } from "./mailboxes";
import { ingestEnvelope } from "./sync-runtime";
import { getWorkflowSnapshot, mailWorkflowEventContext } from "./workflow-data";
import { activateWorkflow, createWorkflow, createWorkflowVersion } from "./workflow-definition-service";
import { captureMailWorkflowEffectOrder } from "./workflow-effect-order";
import { runMailWorkflow } from "./workflow-runtime";
import { loadMailboxConversationDetail } from "./workspace";

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.data;
};
const suite = suiteFor("database", "nats");
suite("Mail conversation automation log and undo", () => {
  const fixed = new Date("2026-01-15T12:00:00Z"),
    day = "2026-01-15";
  const suffix = crypto.randomUUID().slice(0, 8);
  let mailboxId = "",
    mailboxShortId = "",
    resourceId = "",
    folderId = "",
    uid = 30000;
  const users: MailRequestContext[] = [];
  const userId = (index = 0) => {
    const actor = users[index]?.actor;
    if (actor?.kind !== "user") throw new Error("User missing");
    return actor.user.id;
  };
  beforeAll(async () => {
    setSystemTime(fixed);
    await migrate();
    for (const name of ["Owner", "Can", "Nora", "Restricted"]) {
      const uid = `s4-audit-${name}-${suffix}`;
      const [row] = await sql<
        { id: string }[]
      >`INSERT INTO auth.users (uid, provider, profile, display_name, admin) VALUES (${uid}, 'local', 'user', ${name}, false) RETURNING id`;
      if (!row) throw new Error("User fixture failed");
      users.push({
        actor: {
          kind: "user",
          user: {
            id: row.id,
            uid,
            provider: "local",
            profile: "user",
            displayName: name,
            givenname: name,
            sn: "Audit",
            mail: `${uid}@example.test`,
            avatarHash: null,
            roles: ["user"],
            ipa: null,
            accountExpires: null,
            lastLoginLocal: null,
            memberofGroup: [],
            memberofGroupIds: [],
            manages: [],
            managesGroupIds: [],
          },
        },
        accessSubject: { type: "user", userId: row.id },
        requestId: `s4-audit-${suffix}`,
      });
    }
    const mailbox = unwrap(await createMailbox(users[0]!, { name: `S4 audit ${suffix}` }));
    mailboxId = mailbox.id;
    const [row] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    mailboxShortId = row!.short_id;
    for (const index of [1, 2])
      unwrap(
        await grantMailboxAccess({
          context: users[0]!,
          mailboxId,
          principal: { type: "user", userId: userId(index) },
          permission: "write",
        }),
      );
    unwrap(
      await grantMailboxAccess({
        context: users[0]!,
        mailboxId,
        principal: { type: "user", userId: userId(3) },
        permission: "write",
        scope: "assigned",
      }),
    );
    const [resource] = await sql<
      { id: string }[]
    >`INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${"b".repeat(64)}, 'active') RETURNING id`;
    resourceId = resource!.id;
    const [folder] = await sql<
      { id: string }[]
    >`INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${resourceId}::uuid, 'audit-inbox', 'Inbox', 'inbox', 'current') RETURNING id`;
    folderId = folder!.id;
  });
  afterAll(async () => {
    setSystemTime();
    if (mailboxId) {
      const access = await sql<
        { access_id: string }[]
      >`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid UNION SELECT access_id FROM mail.mailbox_assigned_access WHERE mailbox_id = ${mailboxId}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      await deleteWorkflowScope({ appId: "mail", scopeId: mailboxId });
      await sql`DELETE FROM events.outbox WHERE app_id = 'mail' AND ordering_key LIKE ${`${mailboxId}%`}`;
      for (const row of access) await sql`DELETE FROM auth.access WHERE id = ${row.access_id}::uuid`;
    }
    await sql`DELETE FROM audit.events WHERE request_id = ${`s4-audit-${suffix}`}`;
    for (let index = 0; index < users.length; index++) await sql`DELETE FROM auth.users WHERE id = ${userId(index)}::uuid`;
  });
  const message = async () => {
    const id = `<s4-audit-${++uid}-${suffix}@example.test>`;
    await ingestEnvelope({
      db: sql,
      mailboxId,
      remoteResourceId: resourceId,
      folderId,
      captureWorkflowTriggers: false,
      message: {
        remoteRef: { folderStableKey: "audit-inbox", uidValidity: "1", uid: String(uid), modseq: "1" },
        providerMessageId: id,
        providerThreadId: null,
        messageId: id,
        inReplyTo: null,
        references: [],
        subject: `Invoice ${uid}`,
        sentAt: fixed,
        internalDate: fixed,
        sizeBytes: 100,
        flags: [],
        labels: [],
        addresses: { from: [{ name: "Buyer Name", address: "buyer@example.test" }], replyTo: [], to: [], cc: [], bcc: [] },
        mimeStructure: {},
      },
    });
    const [ref] = await sql<
      { id: string }[]
    >`SELECT ref.id FROM mail.remote_message_refs ref JOIN mail.message_contents message ON message.id = ref.message_id WHERE message.message_id = ${id} AND message.mailbox_id = ${mailboxId}::uuid`;
    const snapshot = await getWorkflowSnapshot({ mailboxId, remoteMessageRefId: ref!.id });
    if (!snapshot?.preconditions.conversation) throw new Error("Snapshot missing");
    return { snapshot, refId: ref!.id, conversationId: snapshot.preconditions.conversation.id };
  };
  const rule = async (target = "Can", extra = "") => {
    const definition = unwrap(
      await createWorkflow({
        context: users[0]!,
        mailboxId,
        input: {
          name: `Assign ${target} ${suffix}`,
          priority: 0,
          source: `inputs:\n  conversation: { type: mailConversation, required: true }\ntriggers:\n  messageReceived:\n    with: { conversation: "\${{ trigger.conversation }}" }\nsteps:\n  - assignConversation: { conversation: inputs.conversation, user: ${target} }\n${extra}`,
          effectBudget: workflowEffectBudgetSchema.parse({ maxCollaborationChanges: 10, maxAiCalls: 2, maxTargets: 1 }),
        },
      }),
    );
    unwrap(
      await activateWorkflow({
        context: users[0]!,
        mailboxId,
        workflowId: definition.id,
        input: { expectedVersionId: definition.currentVersion.id },
      }),
    );
    return definition;
  };
  const run = async (definition: Awaited<ReturnType<typeof rule>>, input: Awaited<ReturnType<typeof message>>, position = 1) => {
    const emission = await sql.begin(async (tx) => {
      const event = await emitWorkflowEvent(
        {
          appId: "mail",
          scopeId: mailboxId,
          type: "mail.messageReceived",
          targetWorkflowId: definition.id,
          data: { conversation: input.snapshot.source.conversation },
          context: { ...mailWorkflowEventContext(input.snapshot), automationOrder: { position, name: definition.name } },
          occurredAt: fixed,
          dedupeKey: `${input.refId}:${definition.id}`,
        },
        { db: tx, dispatch: "now" },
      );
      await captureMailWorkflowEffectOrder(tx, {
        eventId: event.eventId,
        mailboxId,
        remoteMessageRefId: input.refId,
        workflowId: definition.id,
        position,
        name: definition.name,
      });
      return event;
    });
    await sql`UPDATE workflows.run SET created_at = ${fixed} WHERE id = ${emission.runIds[0]!}::uuid`;
    return emission.runIds[0]!;
  };
  const assignment = async (conversationId: string) =>
    (await sql<{ user_id: string }[]>`SELECT user_id FROM mail.conversation_assignees WHERE conversation_id = ${conversationId}::uuid`).map(
      (row) => row.user_id,
    );
  const manual = async (conversationId: string, ids: string[], actorIndex = 0) => {
    const [row] = await sql<{ revision: number }[]>`SELECT revision FROM mail.conversations WHERE id = ${conversationId}::uuid`;
    return unwrap(
      await applyConversationCollaboration({
        context: users[actorIndex]!,
        mailboxId,
        conversationId,
        input: { expectedRevision: Number(row!.revision), assigneeUserIds: ids },
      }),
    );
  };

  const apiFor = (actorIndex = 0) =>
    new Hono<MailApiContext>()
      .use("*", async (c, next) => {
        c.set("actor", users[actorIndex]!.actor);
        c.set("accessSubject", users[actorIndex]!.accessSubject);
        await next();
      })
      .route("/", automationLogRoutes);

  test("assignment is auditable, undo suppresses the rule across messages, redo restores it", async () => {
    const definition = await rule(),
      first = await message();
    const runId = await run(definition, first);
    expect(await runMailWorkflow(runId)).toMatchObject({ result: { state: "succeeded" } });
    expect(await assignment(first.conversationId)).toEqual([userId(1)]);
    const log = unwrap(await listAutomationLog(users[0]!, mailboxId, { day, q: "cAn" }));
    expect(automationLogPageSchema.safeParse(log).success).toBe(true);
    const item = log.items.find((item) => item.conversation.id === first.snapshot.source.conversation!.id)!;
    expect(item).toMatchObject({
      outcome: "assigned",
      undo: { state: "available", at: null },
      effects: [{ kind: "assign", target: { name: "Can" } }],
    });
    expect(item.conversation.href).toContain(first.snapshot.source.conversation!.id);
    const detail = unwrap(await getAutomationLogItem(users[0]!, mailboxId, item.id));
    expect(automationLogDetailSchema.safeParse(detail).success).toBe(true);
    expect(detail.chain.map((step) => step.kind)).toEqual(["rule_start", "fixed_row", "result"]);
    expect(
      (await loadMailboxConversationDetail({ context: users[0]!, mailboxId, conversationId: first.conversationId }))?.automationTrace,
    ).toContainEqual(item);
    const undone = unwrap(await changeAutomationLogAssignment(users[0]!, mailboxId, item.id, "undo"));
    const [persistedUndo] = await sql<{ undone_at: Date }[]>`SELECT undone_at FROM mail.automation_log WHERE id = ${item.id}::uuid`;
    expect(undone.item.undo).toEqual({
      state: "done",
      reason: null,
      by: { userId: userId(), name: "Owner" },
      at: persistedUndo!.undone_at.toISOString(),
    });
    expect(unwrap(await getAutomationLogItem(users[0]!, mailboxId, item.id)).undo).toEqual(undone.item.undo);
    expect(
      (await loadMailboxConversationDetail({ context: users[0]!, mailboxId, conversationId: first.conversationId }))?.automationTrace,
    ).toContainEqual(undone.item);
    expect(await assignment(first.conversationId)).toEqual([]);
    const [marker] = await sql<
      { present: boolean }[]
    >`SELECT EXISTS (SELECT 1 FROM mail.automation_assignment_undone WHERE conversation_id = ${first.conversationId}::uuid AND workflow_id = ${definition.id}::uuid) AS present`;
    expect(marker?.present).toBe(true);
    // A distinct received message in the same conversation must preserve the marker.
    const next = await message();
    await sql`UPDATE mail.conversation_messages SET conversation_id = ${first.conversationId}::uuid WHERE message_id = ${next.snapshot.preconditions.message.id}::uuid`;
    const refreshed = await getWorkflowSnapshot({ mailboxId, remoteMessageRefId: next.refId });
    if (!refreshed?.preconditions.conversation) throw new Error("Reply missing");
    const nextRun = await run(definition, { snapshot: refreshed, refId: next.refId, conversationId: first.conversationId });
    expect(await runMailWorkflow(nextRun)).toMatchObject({ result: { state: "succeeded" } });
    expect(await assignment(first.conversationId)).toEqual([]);
    const trace = unwrap(await getConversationAutomationTrace(users[0]!, mailboxId, first.conversationId));
    expect(trace.items.some((entry) => entry.reasons.some((reason) => reason.kind === "undone_before"))).toBe(true);
    expect(unwrap(await changeAutomationLogAssignment(users[0]!, mailboxId, item.id, "redo")).item.undo).toEqual({
      state: "available",
      reason: null,
      by: null,
      at: null,
    });
    expect(await assignment(first.conversationId)).toEqual([userId(1)]);
  });

  test("recovery keeps the original run day when the initial log projection was lost", async () => {
    const definition = await rule(),
      input = await message(),
      runId = await run(definition, input);
    expect(await runMailWorkflow(runId)).toMatchObject({ result: { state: "succeeded" } });
    const original = unwrap(await getConversationAutomationTrace(users[0]!, mailboxId, input.conversationId)).items[0]!;
    await sql`DELETE FROM mail.automation_log WHERE run_id = ${runId}::uuid`;
    setSystemTime(new Date("2026-01-16T12:00:00Z"));
    try {
      await Promise.all([recordMailWorkflowAudit(runId), recordMailWorkflowAudit(runId)]);
      const restored = unwrap(await getConversationAutomationTrace(users[0]!, mailboxId, input.conversationId)).items;
      expect(restored).toHaveLength(1);
      expect(restored[0]?.at).toBe(original.at);
      expect(unwrap(await listAutomationLog(users[0]!, mailboxId, { day })).items.some((item) => item.id === restored[0]?.id)).toBe(true);
    } finally {
      setSystemTime(fixed);
    }
  });

  test("manual changes invalidate undo permanently and existing assignees skip rule assignment", async () => {
    const definition = await rule(),
      input = await message(),
      runId = await run(definition, input);
    expect(await runMailWorkflow(runId)).toMatchObject({ result: { state: "succeeded" } });
    const item = unwrap(await getConversationAutomationTrace(users[0]!, mailboxId, input.conversationId)).items.find(
      (item) => item.by.kind === "rule",
    )!;
    await manual(input.conversationId, [userId(2)]);
    await manual(input.conversationId, [userId(1)], 1);
    const changedAt = new Date("2026-01-15T12:10:00Z");
    await sql`UPDATE mail.automation_assignment SET changed_at = ${changedAt} WHERE conversation_id = ${input.conversationId}::uuid`;
    const before = await assignment(input.conversationId);
    const response = await apiFor().request(`/mailboxes/${mailboxShortId}/automation-log/${item.id}/undo`, { method: "POST" });
    expect(response.status).toBe(409);
    const conflict = automationLogUndoConflictSchema.parse(await response.json());
    expect(conflict).toMatchObject({
      code: "mail.automation.undo_not_possible",
      reason: "changed_by_person",
      item: {
        id: item.id,
        undo: { state: "not_possible", reason: "changed_by_person", by: { userId: userId(1), name: "Can" }, at: changedAt.toISOString() },
      },
    });
    expect(unwrap(await getAutomationLogItem(users[0]!, mailboxId, item.id)).undo).toEqual(conflict.item.undo);
    expect(await assignment(input.conversationId)).toEqual(before);
    expect(
      unwrap(await getConversationAutomationTrace(users[0]!, mailboxId, input.conversationId)).items.some(
        (item) => item.outcome === "manual_change",
      ),
    ).toBe(true);
    const second = await message();
    await manual(second.conversationId, [userId(2)]);
    expect(await runMailWorkflow(await run(definition, second))).toMatchObject({ result: { state: "succeeded" } });
    const skipped = unwrap(await getConversationAutomationTrace(users[0]!, mailboxId, second.conversationId)).items[0]!;
    expect(skipped).toMatchObject({ outcome: "skipped", reasons: [{ kind: "already_assigned" }] });
    expect(await assignment(second.conversationId)).toEqual([userId(2)]);
  });

  test("redo conflicts return the later person's refreshed item rather than the undo actor", async () => {
    const definition = await rule(),
      input = await message(),
      runId = await run(definition, input);
    expect(await runMailWorkflow(runId)).toMatchObject({ result: { state: "succeeded" } });
    const item = unwrap(await getConversationAutomationTrace(users[0]!, mailboxId, input.conversationId)).items[0]!;
    unwrap(await changeAutomationLogAssignment(users[0]!, mailboxId, item.id, "undo"));
    await manual(input.conversationId, [userId(2)], 2);
    const changedAt = new Date("2026-01-15T12:15:00Z");
    await sql`UPDATE mail.automation_assignment SET changed_at = ${changedAt} WHERE conversation_id = ${input.conversationId}::uuid`;
    for (const operation of ["redo", "undo"]) {
      const response = await apiFor().request(`/mailboxes/${mailboxShortId}/automation-log/${item.id}/${operation}`, { method: "POST" });
      expect(response.status).toBe(409);
      const conflict = automationLogUndoConflictSchema.parse(await response.json());
      expect(conflict.item.undo).toEqual({
        state: "not_possible",
        reason: "changed_by_person",
        by: { userId: userId(2), name: "Nora" },
        at: changedAt.toISOString(),
      });
      expect(conflict.item.id).toBe(item.id);
      expect(await assignment(input.conversationId)).toEqual([userId(2)]);
    }
  });

  test("legacy snapshots and missing provenance or conversation return a complete conflict item with unknown attribution", async () => {
    const definition = await rule(),
      input = await message(),
      runId = await run(definition, input);
    expect(await runMailWorkflow(runId)).toMatchObject({ result: { state: "succeeded" } });
    const item = unwrap(await getConversationAutomationTrace(users[0]!, mailboxId, input.conversationId)).items[0]!;
    await sql`UPDATE mail.automation_log SET item = item #- '{undo,at}' WHERE id = ${item.id}::uuid`;
    await sql`DELETE FROM mail.automation_assignment WHERE conversation_id = ${input.conversationId}::uuid`;
    const unknown = await apiFor().request(`/mailboxes/${mailboxShortId}/automation-log/${item.id}/undo`, { method: "POST" });
    expect(unknown.status).toBe(409);
    const unknownConflict = automationLogUndoConflictSchema.parse(await unknown.json());
    expect(unknownConflict.item.undo).toEqual({ state: "not_possible", reason: "changed_by_person", by: null, at: null });
    expect(await assignment(input.conversationId)).toEqual([userId(1)]);
    await sql`DELETE FROM mail.conversations WHERE id = ${input.conversationId}::uuid`;
    for (const operation of ["undo", "redo"]) {
      const response = await apiFor().request(`/mailboxes/${mailboxShortId}/automation-log/${item.id}/${operation}`, { method: "POST" });
      expect(response.status).toBe(409);
      const conflict = automationLogUndoConflictSchema.parse(await response.json());
      expect(conflict).toMatchObject({
        reason: "conversation_gone",
        item: { id: item.id, undo: { state: "not_possible", reason: "conversation_gone", by: null, at: null } },
      });
    }
  });

  test("a skipped assignment's live snapshot cannot authorize overwriting a person's later status", async () => {
    const definition = await rule("Can", "  - setConversationStatus: { conversation: inputs.conversation, status: waiting }\n"),
      input = await message(),
      runId = await run(definition, input);
    const changed = await applyConversationCollaboration({
      context: users[0]!,
      mailboxId,
      conversationId: input.conversationId,
      input: { expectedRevision: input.snapshot.source.conversation!.revision, assigneeUserIds: [userId(2)], completion: "done" },
    });
    expect(changed.ok).toBe(true);
    expect(await runMailWorkflow(runId)).toMatchObject({ result: { state: "failed" } });
    const [current] = await sql<
      { work_status: string }[]
    >`SELECT work_status FROM mail.conversations WHERE id = ${input.conversationId}::uuid`;
    expect(current?.work_status).toBe("done");
    expect(await assignment(input.conversationId)).toEqual([userId(2)]);
  });

  test("a skipped rule publishes its trace after projection, and unchanged recovery publishes nothing", async () => {
    const definition = await rule(),
      input = await message();
    await manual(input.conversationId, [userId(3)]);
    const runId = await run(definition, input);
    await sql`DELETE FROM events.outbox WHERE app_id = 'mail' AND ordering_key LIKE ${`${mailboxId}%`}`;
    expect(await runMailWorkflow(runId)).toMatchObject({ result: { state: "succeeded" } });
    const updates = await sql<{ ordering_key: string; payload: { d: { conversationId: string } } }[]>`
      SELECT ordering_key, payload FROM events.outbox WHERE app_id = 'mail' AND kind = 'live' AND ordering_key LIKE ${`${mailboxId}%`}`;
    expect(updates.map((row) => row.ordering_key).sort()).toEqual([mailboxId, `${mailboxId}:${userId(3)}`].sort());
    expect(updates.every((row) => row.payload.d.conversationId === input.snapshot.source.conversation!.id)).toBe(true);
    const detail = await loadMailboxConversationDetail({ context: users[3]!, mailboxId, conversationId: input.conversationId });
    expect(detail?.automationTrace).toContainEqual(
      expect.objectContaining({ outcome: "skipped", reasons: [{ kind: "already_assigned" }] }),
    );
    await sql`DELETE FROM events.outbox WHERE app_id = 'mail' AND ordering_key LIKE ${`${mailboxId}%`}`;
    await recordMailWorkflowAudit(runId);
    const [pending] = await sql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM events.outbox WHERE app_id = 'mail' AND kind = 'live' AND ordering_key LIKE ${`${mailboxId}%`}`;
    expect(pending?.count).toBe(0);
    await manual(input.conversationId, [userId(1)]);
  });

  test("AI audit uses the fake structured provider's stored choice, fields and executed fixed row", async () => {
    const input = await message();
    const definition = unwrap(
      await createWorkflow({
        context: users[0]!,
        mailboxId,
        input: {
          name: "Fixed target after AI",
          priority: 0,
          source: `inputs:
  conversation: { type: mailConversation, required: true }
triggers:
  messageReceived:
    with: { conversation: "\${{ trigger.conversation }}" }
steps:
  - aiClassify:
      input: Customer named Can in a complaint of 650 EUR.
      prompt: Select the message kind, never a person.
      choices: [Complaint, Other, Uncertain]
      saveAs: category
  - aiExtractData:
      input: Customer named Can in a complaint of 650 EUR.
      prompt: Read the amount.
      fields:
        - { name: amount, type: number, description: Invoice amount, required: true }
      saveAs: values
  - if:
      equals: ["\${{ category }}", Complaint]
    then:
      - assignConversation: { conversation: inputs.conversation, user: Nora }
`,
          effectBudget: workflowEffectBudgetSchema.parse({ maxAiCalls: 2, maxCollaborationChanges: 1, maxTargets: 1 }),
        },
      }),
    );
    unwrap(
      await activateWorkflow({
        context: users[0]!,
        mailboxId,
        workflowId: definition.id,
        input: { expectedVersionId: definition.currentVersion.id },
      }),
    );
    const runId = await run(definition, input);
    let calls = 0;
    const fake = async <T extends z.ZodType>(request: RunAiStructuredInput<T>): Promise<RunAiStructuredResult<T>> => {
      calls++;
      return {
        output: request.output.parse(request.task === "workflow-classify" ? { choice: "Complaint" } : { amount: 650 }),
        modelProfileId: "fixture",
        structuredMeta: { mode: "native", repaired: false, attempts: 1, usedResponseFormat: true },
      };
    };
    // Materialize the existing durable task contract and process it through the real worker's injected provider.
    // The Mail run subsequently restores these tasks and cannot call a model resolver or remote provider.
    for (const step of definition.currentVersion.boundPlan.steps) {
      if (step.kind !== "action" || (step.action !== "aiClassify" && step.action !== "aiExtractData")) continue;
      const stepKey = workflowPathKey(step.sourcePath);
      const request =
        step.action === "aiClassify"
          ? { kind: "classify" as const, input: "650 EUR", prompt: "Classify", choices: ["Complaint", "Other", "Uncertain"] }
          : {
              kind: "extract_data" as const,
              input: "650 EUR",
              prompt: "Read the amount",
              fields: [{ name: "amount", type: "number" as const, description: "Invoice amount", required: true }],
            };
      const task = await createWorkflowAiTask({
        runId,
        stepKey,
        effectKey: `workflow:${runId}:step:${stepKey}`,
        request,
        modelProfileId: "fixture",
      });
      await processWorkflowAiTask(
        task.task.id,
        { signal: new AbortController().signal, heartbeat: async () => undefined },
        { runStructured: fake, maxAttempts: 1, cancelPollMs: 10 },
      );
    }
    expect(await runMailWorkflow(runId)).toMatchObject({ result: { state: "succeeded" } });
    expect(calls).toBe(2);
    expect(await assignment(input.conversationId)).toEqual([userId(2)]);
    const item = unwrap(await getConversationAutomationTrace(users[0]!, mailboxId, input.conversationId)).items[0]!;
    const detail = unwrap(await getAutomationLogItem(users[0]!, mailboxId, item.id));
    expect(detail.reasons).toContainEqual({ kind: "ai_choice", value: "Complaint", choices: ["Complaint", "Other", "Uncertain"] });
    expect(detail.reasons).toContainEqual({ kind: "ai_value", field: "amount", value: 650, evidence: null });
    expect(detail.reasons).toContainEqual(expect.objectContaining({ kind: "comparison", met: true }));
    expect(detail.chain).toContainEqual(expect.objectContaining({ kind: "fixed_row", target: { kind: "user", name: "Nora" } }));
    expect(detail.aiCalls.run).toBe(2);
    // Count the same rule across versions, excluding other rules and conversations hidden from an assigned-only reader.
    await sql`UPDATE ai.workflow_task SET created_at = ${fixed} WHERE run_id = ${runId}::uuid`;
    const version = unwrap(
      await createWorkflowVersion({
        context: users[0]!,
        mailboxId,
        workflowId: definition.id,
        input: {
          source: definition.currentVersion.source,
          effectBudget: workflowEffectBudgetSchema.parse(definition.currentVersion.effectBudget),
        },
      }),
    );
    unwrap(
      await activateWorkflow({
        context: users[0]!,
        mailboxId,
        workflowId: definition.id,
        input: { expectedVersionId: version.currentVersion.id },
      }),
    );
    const sibling = await message(),
      siblingRunId = await run(version, sibling);
    const other = await rule(),
      otherRunId = await run(other, await message());
    const taskFor = async (taskRunId: string) => {
      const { task } = await createWorkflowAiTask({
        runId: taskRunId,
        stepKey: "steps.0",
        effectKey: `workflow:${taskRunId}:step:steps.0`,
        request: { kind: "classify", input: "650 EUR", prompt: "Classify", choices: ["Complaint", "Other"] },
        modelProfileId: "fixture",
      });
      await sql`UPDATE ai.workflow_task SET created_at = ${fixed} WHERE id = ${task.id}::uuid`;
    };
    await taskFor(siblingRunId);
    await taskFor(otherRunId);
    expect(unwrap(await getAutomationLogItem(users[0]!, mailboxId, item.id)).aiCalls).toEqual({ run: 2, today: 3, limit: null });
    await manual(input.conversationId, [userId(3)]);
    expect(unwrap(await getAutomationLogItem(users[3]!, mailboxId, item.id)).aiCalls).toEqual({ run: 2, today: 2, limit: null });
    await manual(sibling.conversationId, [userId(3)]);
    expect(unwrap(await getAutomationLogItem(users[3]!, mailboxId, item.id)).aiCalls.today).toBe(3);
    await manual(input.conversationId, [userId(1)]);
    await manual(sibling.conversationId, [userId(1)]);
    expect(detail.by).toMatchObject({ kind: "rule", ai: true });
  });

  test("search counts ignore the active chip, cursor pages do not overlap, and assigned-only readers see only their conversations", async () => {
    const page = unwrap(await listAutomationLog(users[0]!, mailboxId, { day, q: "BUYER@example.test", filter: "skipped", limit: 1 }));
    expect(page.counts.all).toBeGreaterThan(page.items.length);
    const all = unwrap(await listAutomationLog(users[0]!, mailboxId, { day, q: "BUYER@example.test", limit: 1 }));
    expect(page.counts).toEqual(all.counts);
    expect(all.nextCursor).not.toBeNull();
    const next = unwrap(await listAutomationLog(users[0]!, mailboxId, { day, q: "BUYER@example.test", before: all.nextCursor!, limit: 1 }));
    expect(next.items[0]?.id).not.toBe(all.items[0]?.id);
    expect(unwrap(await listAutomationLog(users[3]!, mailboxId, { day })).counts.all).toBe(0);
    expect(unwrap(await loadMailAutomationLog(users[3]!, mailboxId, { day })).mailbox.timeZone).toBe("UTC");
    const input = await message(),
      definition = await rule();
    expect(await runMailWorkflow(await run(definition, input))).toMatchObject({ result: { state: "succeeded" } });
    await manual(input.conversationId, [userId(3)]);
    const scoped = unwrap(await listAutomationLog(users[3]!, mailboxId, { day }));
    expect(scoped.items.every((item) => item.conversation.id === input.snapshot.source.conversation!.id)).toBe(true);
    expect(scoped.counts.all).toBe(scoped.items.length);
    expect(scoped.items.length).toBeGreaterThan(0);
    expect((await getAutomationLogItem(users[3]!, mailboxId, all.items[0]!.id)).ok).toBe(false);
    expect((await changeAutomationLogAssignment(users[3]!, mailboxId, scoped.items[0]!.id, "undo")).ok).toBe(false);
  });
});
