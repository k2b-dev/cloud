import { afterAll, afterEach, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import * as applicationAi from "@k2b/cloud/ai";
import { accounts, serviceAccountCredentials } from "@k2b/cloud/services";
import { createTestBrowserSignIn } from "@k2b/cloud/services/session/session.test-fixture";
import { unwrap } from "@k2b/stdlib";
import { sql } from "bun";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import api from "../api";
import { newShortId } from "../lib/short-id";
import { grantMailboxAccess } from "./access";
import { getAiDailySourceStats, updateMailboxAiDailyLimit } from "./ai-daily-budget";
import type { MailRequestContext } from "./auth";
import {
  getConversationSummary,
  loadConversationSummary,
  updateConversationSummary,
  updateWorkflowConversationSummaryInTransaction,
} from "./conversation-summary";
import * as summaryAi from "./conversation-summary-ai";
import {
  executeConversationSummary,
  generateConversationSummary,
  SUMMARY_QUIET_PERIOD_MS,
  scheduleConversationSummary,
} from "./conversation-summary-jobs";
import { discardConversationSummaries, reconcileConversationSummaryTasks } from "./conversation-summary-lifecycle";
import { migrateConversationSummaries } from "./conversation-summary-migrate";
import { createMailbox, deleteMailbox } from "./mailboxes";

const suite = suiteFor("database", "nats", "valkey");
const NOW = new Date("2026-10-27T12:00:00.000Z");

suite("durable conversation summaries", () => {
  let context: MailRequestContext;
  let reader: MailRequestContext;
  let mailboxId = "";
  let token = "";
  const userIds: string[] = [];
  const grants: string[] = [];
  let messageSequence = 0;
  const source = { id: "summary-rule", name: "Summary rule", maxAiCallsPerDay: 200 };
  let available: ReturnType<typeof spyOn<typeof summaryAi, "getConversationSummaryAiAvailability">>;

  beforeAll(async () => {
    setSystemTime(NOW);
    const makeContext = async (name: string): Promise<MailRequestContext> => {
      const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
        VALUES (${`summary-${name}-${crypto.randomUUID()}`}, 'local', 'user', ${name}) RETURNING id`;
      if (!row) throw new Error("Missing test user");
      userIds.push(row.id);
      const user = await accounts.users.get({ id: row.id });
      if (!user) throw new Error("Missing test user profile");
      return { actor: { kind: "user", user }, accessSubject: { type: "user", userId: user.id } };
    };
    context = await makeContext("Summary writer");
    reader = await makeContext("Summary reader");
    if (context.actor.kind !== "user") throw new Error("Expected writer");
    token = unwrap(
      await serviceAccountCredentials.createUserApiToken({
        user: context.actor.user,
        browserSignIn: await createTestBrowserSignIn(context.actor.user.id),
        name: "Summary API test",
      }),
    ).token;
    mailboxId = unwrap(await createMailbox(context, { name: "Summary fixture" })).id;
    if (reader.accessSubject.type !== "user") throw new Error("Expected reader");
    grants.push(unwrap(await grantMailboxAccess({ context, mailboxId, principal: reader.accessSubject, permission: "read" })).id);
    available = spyOn(summaryAi, "getConversationSummaryAiAvailability").mockResolvedValue({
      allowance: { unlimited: true, usedPercent: null, resetsAt: null },
      canGenerate: true,
    });
  });
  afterEach(() => {
    setSystemTime(NOW);
    available.mockResolvedValue({ allowance: { unlimited: true, usedPercent: null, resetsAt: null }, canGenerate: true });
  });
  afterAll(async () => {
    available.mockRestore();
    setSystemTime();
    await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    for (const id of grants) await sql`DELETE FROM auth.access WHERE id = ${id}::uuid`;
    for (const id of userIds) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });

  const conversation = async (messageCount = 1) => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO mail.conversations (short_id,mailbox_id,subject,latest_message_at)
      VALUES (${newShortId()},${mailboxId}::uuid,'Summary test',${NOW}) RETURNING id`;
    if (!row) throw new Error("Missing conversation");
    const scope = { mailboxId, conversationId: row.id };
    await addMessages(scope.conversationId, messageCount);
    return scope;
  };
  const addMessages = async (conversationId: string, count: number) => {
    for (let i = 0; i < count; i++) {
      const [message] = await sql<{ id: string }[]>`INSERT INTO mail.message_contents
        (short_id,mailbox_id,message_id,subject,normalized_subject,internal_date,size_bytes,content_hash,hydration_status,plain_text)
        VALUES (${newShortId()},${mailboxId}::uuid,${`<${crypto.randomUUID()}@example.test>`},'Summary','summary',${NOW},100,${(++messageSequence).toString(16).padStart(64, "0")},'complete',${`Message ${i}`}) RETURNING id`;
      if (!message) throw new Error("Missing message");
      await sql`INSERT INTO mail.conversation_messages (conversation_id,message_id,position)
        VALUES (${conversationId}::uuid,${message.id}::uuid,${i})`;
    }
  };
  const ready = async (scope: { conversationId: string }) => {
    await sql`UPDATE mail.conversation_summary_requests SET due_at = ${NOW} WHERE conversation_id = ${scope.conversationId}::uuid`;
  };
  const output = {
    summary: "- Agreed the offer.",
    nextStep: { text: "Confirm the offer", due: "2026-10-30" },
    coveredMessageCount: 1,
    truncated: false,
  };
  const run = (
    scope: { mailboxId: string; conversationId: string },
    generate: typeof summaryAi.generateConversationSummaryAi = async () => output,
  ) => executeConversationSummary(scope, { generate });
  const state = async (scope: { mailboxId: string; conversationId: string }) => unwrap(await getConversationSummary({ ...scope, context }));

  test("migration restores legacy provenance while unknown summaries stay unknown", async () => {
    const workflow = await conversation();
    const human = await conversation();
    const unknown = await conversation();
    for (const [scope, kind] of [
      [workflow, "workflow"],
      [human, "user"],
    ] as const) {
      await sql`UPDATE mail.conversations SET summary = 'Old summary', summary_revision = 2 WHERE id = ${scope.conversationId}::uuid`;
      await sql`INSERT INTO mail.activity_events (mailbox_id,conversation_id,actor_kind,actor_id,action,outcome,target_type,target_id,metadata)
        VALUES (${mailboxId}::uuid,${scope.conversationId}::uuid,${kind},${userIds[0]}::uuid,
          'conversation.summary_updated','confirmed','conversation',${scope.conversationId}::uuid,
          ${{ after: { summaryRevision: 2 } }}::jsonb)`;
    }
    await sql`UPDATE mail.conversations SET summary = 'Unknown summary' WHERE id = ${unknown.conversationId}::uuid`;
    await migrateConversationSummaries(sql);
    await migrateConversationSummaries(sql);
    expect(await state(workflow)).toMatchObject({ source: "workflow", newMessagesSince: 0 });
    expect(await state(human)).toMatchObject({ source: "person", author: { id: userIds[0] } });
    expect(await state(unknown)).toMatchObject({ source: null, newMessagesSince: 0 });
    const mutation = unwrap(
      await sql.begin((db) =>
        updateWorkflowConversationSummaryInTransaction({
          ...workflow,
          db,
          workflowVersionId: userIds[0]!,
          input: { summary: "Continued summary", expectedSummaryRevision: 2 },
        }),
      ),
    );
    expect(mutation.value.summary).toBe("Continued summary");
    expect(unwrap(await scheduleConversationSummary({ ...human, context, source })).skipped).toBe("edited_by_person");
  });

  test("summary locking permits sync's conversation key-share then mailbox update", async () => {
    const scope = await conversation();
    const syncLocked = Promise.withResolvers<void>();
    const mailboxLocked = Promise.withResolvers<void>();
    const sync = sql.begin(async (db) => {
      await db`SELECT id FROM mail.conversations WHERE id = ${scope.conversationId}::uuid FOR KEY SHARE`;
      syncLocked.resolve();
      await mailboxLocked.promise;
      await db`UPDATE mail.mailboxes SET name = name WHERE id = ${mailboxId}::uuid`;
    });
    await syncLocked.promise;
    const summary = sql.begin(async (db) => {
      await db`SELECT id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid FOR UPDATE`;
      mailboxLocked.resolve();
      return loadConversationSummary({ ...scope, db, lock: true });
    });
    const [, row] = await Promise.all([sync, summary]);
    expect(Number(row?.summary_revision)).toBe(1);
  });

  test("20 rapid requests keep one durable request and make one call", async () => {
    const scope = await conversation(20);
    for (let i = 0; i < 20; i++) unwrap(await scheduleConversationSummary({ ...scope, context, source }));
    const [pending] = await sql<{ count: number; due: Date }[]>`SELECT count(*)::int AS count, max(due_at) AS due
      FROM mail.conversation_summary_requests WHERE conversation_id = ${scope.conversationId}::uuid`;
    expect(pending?.count).toBe(1);
    expect(pending?.due.getTime()).toBe(NOW.getTime() + SUMMARY_QUIET_PERIOD_MS);
    expect((await run(scope)).status).toBe("pending");
    await ready(scope);
    let calls = 0;
    await run(scope, async () => {
      calls++;
      return { ...output, coveredMessageCount: 20 };
    });
    await run(scope, async () => {
      calls++;
      return output;
    });
    expect(calls).toBe(1);
    expect(await state(scope)).toMatchObject({
      status: "idle",
      ai: true,
      source: "workflow",
      coveredMessageCount: 20,
      nextStep: output.nextStep,
      author: { kind: "workflow", id: source.id, name: source.name },
    });
  });

  test("a person's edit and clear both permanently skip a rule", async () => {
    const scope = await conversation();
    unwrap(await updateConversationSummary({ ...scope, context, input: { summary: "Human text", expectedSummaryRevision: 1 } }));
    expect(unwrap(await scheduleConversationSummary({ ...scope, context, source })).skipped).toBe("edited_by_person");
    unwrap(await updateConversationSummary({ ...scope, context, input: { summary: null, expectedSummaryRevision: 2 } }));
    expect(unwrap(await scheduleConversationSummary({ ...scope, context, source })).skipped).toBe("edited_by_person");
    expect(await state(scope)).toMatchObject({ summary: null, source: "person", nextStep: null, ai: false });
  });

  test("a human edit while inference is running wins", async () => {
    const scope = await conversation();
    unwrap(await scheduleConversationSummary({ ...scope, context, source }));
    await ready(scope);
    await run(scope, async () => {
      unwrap(await updateConversationSummary({ ...scope, context, input: { summary: "Keep my words", expectedSummaryRevision: 1 } }));
      return output;
    });
    expect(await state(scope)).toMatchObject({ summary: "Keep my words", source: "person", ai: false });
  });

  test("pending work is skipped after a human edits it, without inference", async () => {
    const scope = await conversation();
    unwrap(await scheduleConversationSummary({ ...scope, context, source }));
    unwrap(await updateConversationSummary({ ...scope, context, input: { summary: "Mine", expectedSummaryRevision: 1 } }));
    await ready(scope);
    await run(scope, async () => {
      throw new Error("Must never call AI");
    });
    expect((await state(scope)).status).toBe("idle");
    const [event] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM mail.activity_events
      WHERE conversation_id = ${scope.conversationId}::uuid AND action = 'conversation.summary_updated'`;
    expect(event?.count).toBe(1); // Only the person's edit; skipping is a live-state change.
  });

  test("rule denial leaves content and revisions unchanged and exposes the limit", async () => {
    const scope = await conversation();
    const first = await conversation();
    const rule = { ...source, id: "one-rule", maxAiCallsPerDay: 1 };
    unwrap(await scheduleConversationSummary({ ...first, context, source: rule }));
    await ready(first);
    await run(first);
    const before = await state(scope);
    const result = unwrap(await scheduleConversationSummary({ ...scope, context, source: rule }));
    expect(result.summaryState).toMatchObject({
      summary: before.summary,
      summaryRevision: before.summaryRevision,
      conversationRevision: before.conversationRevision,
      status: "limited",
      limit: { scope: "rule", limit: 1 },
    });
    expect((await run(scope)).status).toBe("idle");
  });

  test("mailbox denial leaves content unchanged", async () => {
    const scope = await conversation();
    unwrap(await updateMailboxAiDailyLimit({ context, mailboxId, maxAiCallsPerDay: 0 }));
    try {
      const result = unwrap(await scheduleConversationSummary({ ...scope, context, source }));
      expect(result.summaryState).toMatchObject({
        summary: null,
        summaryRevision: 1,
        status: "limited",
        limit: { scope: "mailbox", limit: 0 },
      });
    } finally {
      unwrap(await updateMailboxAiDailyLimit({ context, mailboxId, maxAiCallsPerDay: null }));
    }
  });

  test("failure releases a reservation and publishes a visible retry state", async () => {
    const scope = await conversation();
    const rule = { ...source, id: "failure-rule", maxAiCallsPerDay: 1 };
    unwrap(await scheduleConversationSummary({ ...scope, context, source: rule }));
    await ready(scope);
    await run(scope, async () => {
      throw Object.assign(new Error("Slow provider"), { code: "WORKFLOW_AI_TIMEOUT" });
    });
    expect(await state(scope)).toMatchObject({
      summary: null,
      status: "failed",
      failure: { code: "timeout", attempts: 1, workflow: { id: rule.id } },
    });
    expect(unwrap(await getAiDailySourceStats({ mailboxId, sourceId: rule.id }))).toMatchObject({ aiCallsToday: 0, reservedAiCalls: 0 });
    expect(unwrap(await scheduleConversationSummary({ ...scope, context, source: rule })).summaryState.status).toBe("pending");
  });

  test("manual request overwrites human text only on request and clears next step when edited", async () => {
    const scope = await conversation();
    unwrap(await updateConversationSummary({ ...scope, context, input: { summary: "Human words", expectedSummaryRevision: 1 } }));
    expect(
      unwrap(await generateConversationSummary({ ...scope, context, input: { mode: "rolling", expectedSummaryRevision: 2 } })).summaryState
        .status,
    ).toBe("writing");
    await run(scope, async (input) => {
      expect(input.previousSummary).toBe("Human words");
      expect(input.usageSubject).toEqual(context.accessSubject);
      return { ...output, truncated: true };
    });
    expect(await state(scope)).toMatchObject({ source: "manual_ai", ai: true, truncated: true, nextStep: output.nextStep });
    unwrap(await updateConversationSummary({ ...scope, context, input: { summary: "My new words", expectedSummaryRevision: 3 } }));
    expect(await state(scope)).toMatchObject({ source: "person", ai: false, nextStep: null, truncated: false });
  });

  test("manual acceptance never overwrites a later edit before worker start", async () => {
    const scope = await conversation();
    unwrap(await generateConversationSummary({ ...scope, context, input: { mode: "replace", expectedSummaryRevision: 1 } }));
    unwrap(
      await updateConversationSummary({ ...scope, context, input: { summary: "Written after the request", expectedSummaryRevision: 1 } }),
    );
    let calls = 0;
    await run(scope, async () => {
      calls++;
      return output;
    });
    expect(calls).toBe(0);
    expect(await state(scope)).toMatchObject({ summary: "Written after the request", source: "person", status: "idle" });
  });

  test("pending, writing and success all invalidate the existing summary live path", async () => {
    const scope = await conversation();
    unwrap(await scheduleConversationSummary({ ...scope, context, source }));
    expect((await state(scope)).status).toBe("pending");
    await ready(scope);
    await run(scope, async () => {
      expect((await state(scope)).status).toBe("writing");
      return output;
    });
    const [event] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM mail.activity_events
      WHERE conversation_id = ${scope.conversationId}::uuid AND action = 'conversation.summary_updated'`;
    expect(event?.count).toBe(1);
    const [live] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM events.outbox
      WHERE app_id = 'mail' AND kind = 'live' AND ordering_key = ${mailboxId}
        AND payload->'d'->>'conversationId' = (SELECT short_id FROM mail.conversations WHERE id = ${scope.conversationId}::uuid)`;
    expect(live?.count).toBeGreaterThanOrEqual(3);
    expect((await state(scope)).status).toBe("idle");
  });

  test("manual request requires write permission", async () => {
    const scope = await conversation();
    const result = await generateConversationSummary({ ...scope, context: reader, input: { mode: "replace", expectedSummaryRevision: 1 } });
    expect(result.ok).toBe(false);
    expect((await state(scope)).status).toBe("idle");
  });

  test("exhausted personal allowance has a stable code and changes nothing", async () => {
    const scope = await conversation();
    available.mockResolvedValue({
      allowance: { unlimited: false, usedPercent: 100, resetsAt: "2026-10-28T00:00:00Z" },
      canGenerate: false,
    });
    const result = await generateConversationSummary({ ...scope, context, input: { mode: "replace", expectedSummaryRevision: 1 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("mail.summary.allowance_exhausted");
    expect(await state(scope)).toMatchObject({
      summary: null,
      summaryRevision: 1,
      conversationRevision: 1,
      status: "idle",
      canGenerate: false,
    });
  });

  test("a second manual request reuses the in-flight request", async () => {
    const scope = await conversation();
    const input = { mode: "replace" as const, expectedSummaryRevision: 1 };
    unwrap(await generateConversationSummary({ ...scope, context, input }));
    const [before] = await sql<
      { request_id: string }[]
    >`SELECT request_id FROM mail.conversation_summary_requests WHERE conversation_id = ${scope.conversationId}::uuid`;
    unwrap(await generateConversationSummary({ ...scope, context, input }));
    const [after] = await sql<
      { request_id: string }[]
    >`SELECT request_id FROM mail.conversation_summary_requests WHERE conversation_id = ${scope.conversationId}::uuid`;
    expect(after?.request_id).toBe(before?.request_id);
  });

  test("new replies during inference produce at most one follow-up and a stale count", async () => {
    const scope = await conversation();
    unwrap(await scheduleConversationSummary({ ...scope, context, source }));
    await ready(scope);
    await run(scope, async () => {
      await addMessages(scope.conversationId, 19);
      return output;
    });
    expect(await state(scope)).toMatchObject({ newMessagesSince: 19, status: "pending" });
    await ready(scope);
    let calls = 0;
    await run(scope, async () => {
      calls++;
      return { ...output, coveredMessageCount: 20 };
    });
    expect(calls).toBe(1);
    expect(await state(scope)).toMatchObject({ newMessagesSince: 0, status: "idle" });
  });

  test("an automatic trigger during manual inference schedules only a source-paid follow-up", async () => {
    const scope = await conversation();
    unwrap(await generateConversationSummary({ ...scope, context, input: { mode: "rolling", expectedSummaryRevision: 1 } }));
    await run(scope, async (input) => {
      expect(input.usageSubject).toMatchObject({ type: "user" });
      await addMessages(scope.conversationId, 1);
      unwrap(await scheduleConversationSummary({ ...scope, context, source }));
      return output;
    });
    expect(await state(scope)).toMatchObject({ status: "pending", newMessagesSince: 1 });
    await ready(scope);
    await run(scope, async (input) => {
      expect(input.usageSubject).toBeUndefined();
      return output;
    });
  });

  test("a failed manual call retains an automatic follow-up for new replies", async () => {
    const scope = await conversation();
    unwrap(await generateConversationSummary({ ...scope, context, input: { mode: "rolling", expectedSummaryRevision: 1 } }));
    await run(scope, async () => {
      await addMessages(scope.conversationId, 1);
      unwrap(await scheduleConversationSummary({ ...scope, context, source }));
      throw new Error("Provider failed");
    });
    expect(await state(scope)).toMatchObject({ status: "pending", summary: null });
    await ready(scope);
    await run(scope, async (input) => {
      expect(input.usageSubject).toBeUndefined();
      return output;
    });
  });

  test("worker shutdown retains the writing request and its reservation", async () => {
    const scope = await conversation();
    const rule = { ...source, id: "shutdown-rule", maxAiCallsPerDay: 1 };
    unwrap(await scheduleConversationSummary({ ...scope, context, source: rule }));
    await ready(scope);
    const controller = new AbortController();
    const result = await executeConversationSummary(scope, {
      signal: controller.signal,
      generate: async () => {
        controller.abort(new Error("worker stopped"));
        throw controller.signal.reason;
      },
    });
    expect(result.status).toBe("writing");
    expect(await state(scope)).toMatchObject({ summary: null, status: "writing", failure: null });
    expect(unwrap(await getAiDailySourceStats({ mailboxId, sourceId: rule.id }))).toMatchObject({ reservedAiCalls: 1, aiCallsToday: 0 });
    await ready(scope);
    await run(scope);
    expect(unwrap(await getAiDailySourceStats({ mailboxId, sourceId: rule.id }))).toMatchObject({ reservedAiCalls: 0, aiCallsToday: 1 });
  });

  test("interrupted generation keeps its original coverage when another message arrives", async () => {
    const scope = await conversation();
    const rule = { ...source, id: "snapshot-rule" };
    unwrap(await scheduleConversationSummary({ ...scope, context, source: rule }));
    await ready(scope);
    const controller = new AbortController();
    let boundary: string | null = null;
    let effectKey = "";
    await executeConversationSummary(scope, {
      signal: controller.signal,
      generate: async (input) => {
        boundary = input.throughMessageSeq;
        effectKey = input.effectKey;
        controller.abort(new Error("stop"));
        throw controller.signal.reason;
      },
    });
    await addMessages(scope.conversationId, 1);
    unwrap(await scheduleConversationSummary({ ...scope, context, source: rule }));
    await ready(scope);
    await run(scope, async (input) => {
      expect(input.effectKey).toBe(effectKey);
      expect(input.throughMessageSeq).toBe(boundary);
      return output;
    });
    expect(await state(scope)).toMatchObject({ status: "pending", newMessagesSince: 1 });
  });

  test("an interrupted manual request keeps one personal call", async () => {
    const scope = await conversation();
    const input = { mode: "rolling" as const, expectedSummaryRevision: 1 };
    unwrap(await generateConversationSummary({ ...scope, context, input }));
    const controller = new AbortController();
    let effectKey = "";
    await executeConversationSummary(scope, {
      signal: controller.signal,
      generate: async (request) => {
        effectKey = request.effectKey;
        controller.abort(new Error("stop"));
        throw controller.signal.reason;
      },
    });
    expect(unwrap(await generateConversationSummary({ ...scope, context, input })).summaryState.status).toBe("writing");
    await ready(scope);
    await run(scope, async (request) => {
      expect(request.effectKey).toBe(effectKey);
      return output;
    });
  });

  test("a successful AI call stays counted if permission disappears before settlement", async () => {
    const scope = await conversation();
    const rule = { ...source, id: "settlement-rule" };
    unwrap(await scheduleConversationSummary({ ...scope, context, source: rule }));
    await ready(scope);
    const personId = userIds[0]!;
    try {
      await run(scope, async () => {
        await sql`UPDATE auth.users SET account_expires = now() - interval '1 day' WHERE id = ${personId}::uuid`;
        return output;
      });
      expect(unwrap(await getAiDailySourceStats({ mailboxId, sourceId: rule.id }))).toMatchObject({ aiCallsToday: 1, reservedAiCalls: 0 });
    } finally {
      await sql`UPDATE auth.users SET account_expires = NULL WHERE id = ${personId}::uuid`;
    }
    expect(await state(scope)).toMatchObject({ status: "failed", summary: null });
  });

  const seedTask = async (scope: { mailboxId: string; conversationId: string }, suffix: string) => {
    const [task] = await sql<{ id: string }[]>`INSERT INTO ai.workflow_task
      (app_id,scope_id,source_id,step_key,effect_key,kind,request,input_hash,model_profile_id,status,completed_at)
      VALUES ('mail',${scope.mailboxId},${`${scope.conversationId}:${suffix}`},'conversation-summary',${crypto.randomUUID()},
        'generate_text',${{ input: "Private summary source" }}::jsonb,${"0".repeat(64)},'fixture','succeeded',now()) RETURNING id`;
    if (!task) throw new Error("Missing task fixture");
    return task.id;
  };

  test("conversation cleanup releases holds and removes every snapshot without touching another conversation", async () => {
    const scope = await conversation();
    const other = await conversation();
    const rule = { ...source, id: "cleanup-rule" };
    unwrap(await scheduleConversationSummary({ ...scope, context, source: rule }));
    const ids = [await seedTask(scope, "snapshot"), await seedTask(scope, "manual:request")];
    const neighbor = await seedTask(other, "snapshot");
    try {
      await sql.begin(async (db) => {
        await db`SELECT id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid FOR NO KEY UPDATE`;
        await discardConversationSummaries(db, scope);
      });
      expect(await sql`SELECT id FROM ai.workflow_task WHERE id IN (${ids[0]}::uuid,${ids[1]}::uuid)`).toHaveLength(0);
      expect(await sql`SELECT id FROM ai.workflow_task WHERE id = ${neighbor}::uuid`).toHaveLength(1);
      expect(unwrap(await getAiDailySourceStats({ mailboxId, sourceId: rule.id }))).toMatchObject({ reservedAiCalls: 0 });
      expect(await state(scope)).toMatchObject({ status: "idle", summary: null });
    } finally {
      await sql`DELETE FROM ai.workflow_task WHERE scope_id = ${mailboxId}`;
    }
  });

  test("mailbox deletion discards its pending summaries and AI task payloads", async () => {
    const mailbox = unwrap(await createMailbox(context, { name: "Summary deletion" }));
    try {
      const [row] = await sql<{ id: string }[]>`INSERT INTO mail.conversations(short_id,mailbox_id,subject,latest_message_at)
        VALUES (${newShortId()},${mailbox.id}::uuid,'Deletion',${NOW}) RETURNING id`;
      if (!row) throw new Error("Missing deletion conversation");
      const scope = { mailboxId: mailbox.id, conversationId: row.id };
      unwrap(await scheduleConversationSummary({ ...scope, context, source }));
      const taskId = await seedTask(scope, "snapshot");
      unwrap(await deleteMailbox(context, mailbox.id));
      expect(await sql`SELECT id FROM ai.workflow_task WHERE id = ${taskId}::uuid`).toHaveLength(0);
      expect(await sql`SELECT conversation_id FROM mail.conversation_summary_requests WHERE mailbox_id = ${mailbox.id}::uuid`).toHaveLength(
        0,
      );
    } finally {
      await sql`DELETE FROM ai.workflow_task WHERE scope_id = ${mailbox.id}`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailbox.id}::uuid`;
    }
  });

  test("recovery removes crash-orphaned sources while retaining a live owner's dormant result", async () => {
    const scope = await conversation();
    const other = await conversation();
    const orphanId = await seedTask(scope, "snapshot");
    const retainedId = await seedTask(other, "snapshot");
    try {
      await sql`DELETE FROM mail.conversations WHERE id = ${scope.conversationId}::uuid`;
      await reconcileConversationSummaryTasks();
      expect(await sql`SELECT id FROM ai.workflow_task WHERE id = ${orphanId}::uuid`).toHaveLength(0);
      expect(await sql`SELECT id FROM ai.workflow_task WHERE id = ${retainedId}::uuid`).toHaveLength(1);
    } finally {
      await sql`DELETE FROM ai.workflow_task WHERE scope_id = ${mailboxId}`;
    }
  });

  test("a late task created after conversation deletion is removed when its worker settles", async () => {
    const scope = await conversation();
    unwrap(await scheduleConversationSummary({ ...scope, context, source }));
    await ready(scope);
    let lateTaskId = "";
    await run(scope, async () => {
      await sql.begin(async (db) => {
        await db`SELECT id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid FOR NO KEY UPDATE`;
        await discardConversationSummaries(db, scope);
        await db`DELETE FROM mail.conversations WHERE id = ${scope.conversationId}::uuid`;
      });
      lateTaskId = await seedTask(scope, "late-snapshot");
      return output;
    });
    expect(await sql`SELECT id FROM ai.workflow_task WHERE id = ${lateTaskId}::uuid`).toHaveLength(0);
  });

  test("shutdown after owner deletion discards a task created in the deletion race", async () => {
    const scope = await conversation();
    unwrap(await scheduleConversationSummary({ ...scope, context, source }));
    await ready(scope);
    const abort = new AbortController();
    let lateTaskId = "";
    await executeConversationSummary(scope, {
      signal: abort.signal,
      generate: async () => {
        await sql.begin(async (db) => {
          await db`SELECT id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid FOR NO KEY UPDATE`;
          await discardConversationSummaries(db, scope);
          await db`DELETE FROM mail.conversations WHERE id = ${scope.conversationId}::uuid`;
        });
        lateTaskId = await seedTask(scope, "shutdown-race");
        abort.abort(new Error("Shutdown"));
        throw abort.signal.reason;
      },
    });
    expect(await sql`SELECT id FROM ai.workflow_task WHERE id = ${lateTaskId}::uuid`).toHaveLength(0);
  });

  test("manual settlement releases its personal task while graceful interruption retains replay", async () => {
    const release = spyOn(applicationAi, "releaseApplicationAiTask");
    try {
      const scope = await conversation();
      unwrap(await generateConversationSummary({ ...scope, context, input: { mode: "rolling", expectedSummaryRevision: 1 } }));
      await ready(scope);
      const abort = new AbortController();
      await executeConversationSummary(scope, {
        signal: abort.signal,
        generate: async () => {
          abort.abort(new Error("Shutdown"));
          throw abort.signal.reason;
        },
      });
      expect(release).not.toHaveBeenCalled();
      await ready(scope);
      await run(scope);
      expect(release).toHaveBeenCalledTimes(1);
      expect(release.mock.calls[0]?.[0]).toMatchObject({ appId: "mail", scopeId: mailboxId, usageSubject: context.accessSubject });
    } finally {
      release.mockRestore();
    }
  });

  test("a newly eligible older link is stale and schedules a follow-up even below the captured sequence", async () => {
    const scope = await conversation(2);
    unwrap(await scheduleConversationSummary({ ...scope, context, source }));
    await ready(scope);
    await run(scope, async () => {
      await addMessages(scope.conversationId, 1);
      await sql`UPDATE mail.conversation_messages SET link_seq = 0
        WHERE conversation_id = ${scope.conversationId}::uuid AND link_seq = (
          SELECT max(link_seq) FROM mail.conversation_messages WHERE conversation_id = ${scope.conversationId}::uuid)`;
      return output;
    });
    expect(await state(scope)).toMatchObject({ status: "pending", newMessagesSince: 1 });
  });

  const requestApi = async (scope: { conversationId: string }, body: unknown) => {
    const [ids] = await sql<{ mailbox: string; conversation: string }[]>`SELECT m.short_id AS mailbox, c.short_id AS conversation
      FROM mail.conversations c JOIN mail.mailboxes m ON m.id = c.mailbox_id WHERE c.id = ${scope.conversationId}::uuid`;
    if (!ids) throw new Error("Missing public IDs");
    return api.request(`/mailboxes/${ids.mailbox}/conversations/${ids.conversation}/summary/generate`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-forwarded-for": uniqueCallerAddress() },
      body: JSON.stringify(body),
    });
  };

  test("reader HTTP route returns 202 with the full writing contract", async () => {
    const scope = await conversation();
    const response = await requestApi(scope, { mode: "rolling", expectedSummaryRevision: 1 });
    expect(response.status).toBe(202);
    const result = await response.json();
    expect(result).toMatchObject({ status: "writing", summaryRevision: 1, canGenerate: true });
    expect(result).not.toHaveProperty("summaryState");
  });

  test("reader HTTP route rejects a revision conflict and bad input", async () => {
    const scope = await conversation();
    expect((await requestApi(scope, { mode: "rolling", expectedSummaryRevision: 9 })).status).toBe(409);
    expect((await requestApi(scope, { mode: "invalid", expectedSummaryRevision: 1 })).status).toBe(400);
    expect((await state(scope)).status).toBe("idle");
  });

  test("a queued API request checks its credential again before inference", async () => {
    const scope = await conversation();
    expect((await requestApi(scope, { mode: "rolling", expectedSummaryRevision: 1 })).status).toBe(202);
    const [row] = await sql<{ credential: string }[]>`SELECT request->'context'->'actor'->>'credentialId' AS credential
      FROM mail.conversation_summary_requests WHERE conversation_id = ${scope.conversationId}::uuid`;
    if (!row?.credential) throw new Error("Missing API credential");
    let calls = 0;
    try {
      await sql`UPDATE auth.service_account_credentials SET status = 'revoked', revoked_at = now() WHERE id = ${row.credential}::uuid`;
      await run(scope, async () => {
        calls++;
        return output;
      });
    } finally {
      await sql`UPDATE auth.service_account_credentials SET status = 'active', revoked_at = NULL WHERE id = ${row.credential}::uuid`;
    }
    expect(calls).toBe(0);
    expect(await state(scope)).toMatchObject({ summary: null, status: "failed" });
  });

  test("editing after a failed request clears its old failure state", async () => {
    const scope = await conversation();
    unwrap(await scheduleConversationSummary({ ...scope, context, source }));
    await ready(scope);
    await run(scope, async () => {
      throw new Error("Provider failed");
    });
    expect((await state(scope)).status).toBe("failed");
    expect(
      unwrap(await updateConversationSummary({ ...scope, context, input: { summary: "My words", expectedSummaryRevision: 1 } })),
    ).toMatchObject({ source: "person", status: "idle", failure: null });
  });

  test("reader HTTP route exposes the stable allowance error", async () => {
    const scope = await conversation();
    available.mockResolvedValue({
      allowance: { unlimited: false, usedPercent: 100, resetsAt: "2026-10-28T00:00:00Z" },
      canGenerate: false,
    });
    const response = await requestApi(scope, { mode: "replace", expectedSummaryRevision: 1 });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "mail.summary.allowance_exhausted" });
    expect((await state(scope)).status).toBe("idle");
  });

  test("an interrupted writing claim resumes the same request after its lease expires", async () => {
    const scope = await conversation();
    unwrap(await scheduleConversationSummary({ ...scope, context, source }));
    await ready(scope);
    await sql`UPDATE mail.conversation_summary_requests SET status = 'writing', claim_id = gen_random_uuid(),
      claimed_at = now() - interval '10 minutes' WHERE conversation_id = ${scope.conversationId}::uuid`;
    expect((await run(scope)).status).toBe("idle");
    expect(await state(scope)).toMatchObject({ ai: true, status: "idle" });
  });
});
