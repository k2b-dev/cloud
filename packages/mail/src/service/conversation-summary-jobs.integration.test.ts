import { afterAll, afterEach, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { accounts } from "@k2b/cloud/services";
import { unwrap } from "@k2b/stdlib";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { grantMailboxAccess } from "./access";
import { getAiDailySourceStats, updateMailboxAiDailyLimit } from "./ai-daily-budget";
import type { MailRequestContext } from "./auth";
import { getConversationSummary, updateConversationSummary } from "./conversation-summary";
import * as summaryAi from "./conversation-summary-ai";
import {
  executeConversationSummary,
  generateConversationSummary,
  SUMMARY_QUIET_PERIOD_MS,
  scheduleConversationSummary,
} from "./conversation-summary-jobs";
import { createMailbox } from "./mailboxes";

const suite = suiteFor("database", "nats", "valkey");
const NOW = new Date("2026-10-27T12:00:00.000Z");

suite("durable conversation summaries", () => {
  let context: MailRequestContext;
  let reader: MailRequestContext;
  let mailboxId = "";
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
    const [event] = await sql<{ skipped: string }[]>`SELECT metadata->>'skipped' AS skipped FROM mail.activity_events
      WHERE conversation_id = ${scope.conversationId}::uuid ORDER BY created_at DESC, id DESC LIMIT 1`;
    expect(event?.skipped).toBe("edited_by_person");
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
    const events = await sql<{ status: string }[]>`SELECT metadata->>'summaryStatus' AS status
      FROM mail.activity_events WHERE conversation_id = ${scope.conversationId}::uuid AND action = 'conversation.summary_updated'
      ORDER BY created_at, id`;
    expect(events.map((event) => event.status)).toEqual(["pending", "writing", "idle"]);
    // activity_events has the same transaction-owned live invalidation trigger as human summary edits.
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
