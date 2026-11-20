import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor, testFor, useMigratedDatabase } from "../../../../scripts/fixtures/test-infra";
import { sql } from "../runtime/clients";
import { appendAiChatDone, sweepAiChatDone } from "./chat-done";
import { enqueueAiChatSend } from "./chat-send";
import {
  AiQueuedChatStartError,
  assertQueuedMessageQuota,
  drainQueuedMessages,
  reconcileQueuedInterruptions,
  requestQueuedMessageSendNow,
  updateQueuedMessage,
} from "./message-queue";
import { publicAiStoredMessages } from "./public-projection";
import { AiQuotaError, aiQuotas } from "./quotas";
import { sweepAiRuntime } from "./runtime";
import { aiConversations } from "./store";
import type { AiChatTurnRunConfig } from "./types";

suiteFor("database")("delegated chat completion", () => {
  let database: Awaited<ReturnType<typeof useMigratedDatabase>>;
  const owner = "99000000-0000-4000-8000-000000000001";
  beforeAll(async () => {
    database = await useMigratedDatabase("chat_done");
    await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${owner}::uuid,'chat-done-owner','local','user')`;
  }, 30_000);
  afterAll(async () => {
    await database?.drop();
  });

  const queuedFixture = async () => {
    const source = await aiConversations.createConversation({ ownerUserId: owner, title: "Reise nach Lyon" });
    const target = await aiConversations.createConversation({ ownerUserId: owner, title: "Hotels in Lyon" });
    await sql`UPDATE ai.conversations SET title_source='user' WHERE id=${source.id}::uuid OR id=${target.id}::uuid`;
    const config: AiChatTurnRunConfig = {
      kind: "chat",
      input: "Find hotels",
      toolSource: { kind: "none" },
      writerOrigin: { kind: "person", id: owner },
      turnTrigger: { kind: "person", id: owner },
    };
    const sourceWork = await aiConversations.submitChatTurn({
      conversationId: source.id,
      modelId: "fixture",
      runConfig: config,
      userMessage: { role: "user", content: [{ type: "text", text: "Delegate" }] },
    });
    await aiConversations.completeTurn({ conversationId: source.id, turnId: sourceWork.turn.id, status: "completed" });
    const id = crypto.randomUUID();
    const runConfig: AiChatTurnRunConfig = {
      ...config,
      chatId: target.shortId,
      writerOrigin: { kind: "chat", id: source.shortId, turnId: sourceWork.turn.shortId },
      turnTrigger: { kind: "chat", id: source.shortId },
      send: { id, accountId: owner, keyHash: id, requestHash: id },
    };
    const submission = {
      conversationId: target.id,
      modelId: "fixture",
      runConfig,
      userMessage: { role: "user" as const, content: [{ type: "text" as const, text: "Find hotels" }] },
    };
    await sql.begin(async (db) => {
      await db`SELECT id FROM ai.conversations WHERE id=${target.id}::uuid FOR UPDATE`;
      await enqueueAiChatSend(submission, [{ type: "text", text: "Find hotels" }], db, {
        conversationId: source.id,
        turnId: sourceWork.turn.id,
      });
    });
    const facts = async () => (await aiConversations.listMessages({ conversationId: source.id })).filter((m) => m.meta?.chatDone);
    return { source, target, sourceWork, submission, id, facts };
  };
  const fixture = async (summary = "Three hotels compared.\nA long list follows.") => {
    const queued = await queuedFixture();
    const { source, target, sourceWork, submission, id, facts } = queued;
    const work = await aiConversations.submitChatTurn({ ...submission, queuedMessageId: id });
    await aiConversations
      .createSessionStore({ conversationId: target.id, turnId: work.turn.id })
      .append({ role: "assistant", content: [{ type: "text", text: summary }] });
    return {
      source,
      target,
      sourceWork,
      work,
      facts,
      end: (status: "completed" | "failed" | "aborted") =>
        aiConversations.completeTurn({
          conversationId: target.id,
          turnId: work.turn.id,
          status,
          ...(status === "failed" ? { error: "Fixture failure", turnError: { code: "failed" as const } } : {}),
        }),
    };
  };

  test.each(["completed", "failed", "aborted"] as const)(
    "%s records one activity, pins the end statements and never starts a source turn",
    async (status) => {
      const f = await fixture();
      const meter = await meterSql();
      let statements: string[];
      try {
        statements = await meter.during(async () => {
          expect(await f.end(status)).toBe("completed");
        });
      } finally {
        await meter.close();
      }
      // BEGIN/COMMIT and the short-ID savepoint are included. A delegated end adds exactly four statements.
      expect(statements).toHaveLength(status === "completed" ? 13 : 15);
      const facts = await f.facts();
      expect(facts).toHaveLength(1);
      expect(facts[0]?.loopId).toBeNull();
      expect(facts[0]?.meta?.chatDone).toMatchObject({ chatId: f.target.shortId, turnId: f.work.turn.shortId, status, messageSeq: 2 });
      expect(await sql`SELECT id FROM ai.turns WHERE conversation_id=${f.source.id}::uuid`).toHaveLength(1);
      expect(await sql`SELECT id FROM ai.queued_messages WHERE conversation_id=${f.source.id}::uuid`).toHaveLength(0);
      expect((await aiConversations.listContextMessages({ conversationId: f.source.id })).some((m) => m.meta?.chatDone)).toBe(false);
      const projectionMeter = await meterSql();
      let projected: typeof facts = [];
      try {
        const projectionStatements = await projectionMeter.during(async () => {
          projected = await publicAiStoredMessages(facts, f.source, owner, { userId: owner, locale: "de" });
        });
        // Existing origin + next-message snapshot queries: the preview adds no statement.
        expect(projectionStatements).toHaveLength(2);
      } finally {
        await projectionMeter.close();
      }
      expect(projected[0]?.meta?.chatDone?.summary).toBe(status === "completed" ? "Three hotels compared." : undefined);
      expect(projected[0]?.meta?.chatDone).toMatchObject({
        name: "Hotels in Lyon",
        href: `/app/assistant?conversation=${f.target.shortId}&message=2`,
      });
      await sql`UPDATE ai.conversations SET archived_at=now() WHERE id=${f.target.id}::uuid`;
      const unavailable = await publicAiStoredMessages(facts, f.source, owner, { userId: owner, locale: "de" });
      expect(unavailable[0]?.meta?.chatDone?.href).toBeUndefined();
      expect(unavailable[0]?.meta?.chatDone?.name).toBeUndefined();
      expect(unavailable[0]?.meta?.chatDone?.summary).toBeUndefined();
      const otherViewer = await publicAiStoredMessages(facts, f.source, null, { userId: null, locale: "de" });
      expect(otherViewer[0]?.meta?.chatDone?.summary).toBeUndefined();
      expect(projected[0]?.meta?.chatDone?.targetConversationId).toBeUndefined();
    },
  );

  test("the owner preview is bounded to the same 320 characters as chat answer previews", async () => {
    const f = await fixture("x".repeat(321) + "\nMore details");
    await f.end("completed");
    const projected = await publicAiStoredMessages(await f.facts(), f.source, owner, { userId: owner, locale: "de" });
    expect(projected[0]?.meta?.chatDone?.summary).toBe("x".repeat(320));
  });

  test("ordinary turn completion keeps its existing statement budget", async () => {
    const conversation = await aiConversations.createConversation({ ownerUserId: owner });
    const work = await aiConversations.submitChatTurn({
      conversationId: conversation.id,
      modelId: "fixture",
      runConfig: {
        kind: "chat",
        input: "Hello",
        toolSource: { kind: "none" },
        writerOrigin: { kind: "person", id: owner },
        turnTrigger: { kind: "person", id: owner },
      },
      userMessage: { role: "user", content: [{ type: "text", text: "Hello" }] },
    });
    const meter = await meterSql();
    try {
      const statements = await meter.during(async () => {
        expect(await aiConversations.completeTurn({ conversationId: conversation.id, turnId: work.turn.id, status: "completed" })).toBe(
          "completed",
        );
      });
      expect(statements).toHaveLength(9);
    } finally {
      await meter.close();
    }
  });

  test("terminal status and fact roll back together; restart sweep repairs a terminal turn and repeated keys stay singular", async () => {
    const f = await fixture();
    await expect(
      sql.begin(async (db) => {
        await db`UPDATE ai.turns SET status='completed',completed_at=now() WHERE id=${f.work.turn.id}::uuid`;
        await appendAiChatDone(f.work.turn.id, db);
        throw new Error("crash before commit");
      }),
    ).rejects.toThrow("crash before commit");
    expect(await f.facts()).toHaveLength(0);
    expect((await aiConversations.getTurn({ conversationId: f.target.id, turnId: f.work.turn.id }))?.status).toBe("queued");
    await sql`UPDATE ai.turns SET status='completed',completed_at=now() WHERE id=${f.work.turn.id}::uuid`;
    await Promise.all([sweepAiChatDone(200), sweepAiChatDone(200)]);
    expect(await f.facts()).toHaveLength(1);
    await sql`UPDATE ai.turns SET delegated_done_at=NULL WHERE id=${f.work.turn.id}::uuid`;
    await sweepAiChatDone(200);
    expect(await f.facts()).toHaveLength(1);
    expect(await sql`SELECT id FROM ai.turns WHERE id=${f.work.turn.id}::uuid AND delegated_done_at IS NULL`).toHaveLength(0);
    await aiConversations.truncateMessagesFrom({ conversationId: f.source.id, fromSeq: 1 });
    expect(await f.facts()).toHaveLength(1);
  });

  test.each(["deleted", "archived"])(
    "a %s origin receives no line or timestamp change, even if its public IDs are reused",
    async (state) => {
      const f = await fixture();
      const [before] = await sql<{ value: string }[]>`SELECT updated_at::text AS value FROM ai.conversations WHERE id=${f.source.id}::uuid`;
      if (state === "deleted") {
        await sql`DELETE FROM ai.conversations WHERE id=${f.source.id}::uuid`;
        const replacement = await aiConversations.createConversation({ ownerUserId: owner });
        await sql`UPDATE ai.conversations SET short_id=${f.source.shortId} WHERE id=${replacement.id}::uuid`;
        await sql`INSERT INTO ai.turns(short_id,conversation_id,status) VALUES(${f.sourceWork.turn.shortId},${replacement.id}::uuid,'completed')`;
      } else await sql`UPDATE ai.conversations SET archived_at=now() WHERE id=${f.source.id}::uuid`;
      await f.end("completed");
      await sweepAiChatDone(200);
      expect(await sql`SELECT id FROM ai.messages WHERE delegated_target_turn_id=${f.work.turn.id}::uuid`).toHaveLength(0);
      if (state === "archived") {
        const [after] = await sql<
          { value: string }[]
        >`SELECT updated_at::text AS value FROM ai.conversations WHERE id=${f.source.id}::uuid`;
        expect(after?.value).toBe(before?.value);
        await sql`UPDATE ai.conversations SET archived_at=NULL WHERE id=${f.source.id}::uuid`;
        await sweepAiChatDone(200);
        expect(await f.facts()).toHaveLength(0);
      }
    },
  );

  test("a busy origin defers its line without blocking the target; the next sweep repairs it", async () => {
    const f = await fixture();
    await sql.begin(async (lock) => {
      await lock`SELECT id FROM ai.conversations WHERE id=${f.source.id}::uuid FOR UPDATE`;
      expect(await f.end("completed")).toBe("completed");
      expect(await f.facts()).toHaveLength(0);
    });
    await sweepAiChatDone(200);
    expect(await f.facts()).toHaveLength(1);
  });

  test("a deleted target cannot redirect an old result link through a reused public ID", async () => {
    const f = await fixture();
    await f.end("completed");
    await sql`DELETE FROM ai.conversations WHERE id=${f.target.id}::uuid`;
    const replacement = await aiConversations.createConversation({ ownerUserId: owner, title: "Another conversation" });
    await sql`UPDATE ai.conversations SET short_id=${f.target.shortId} WHERE id=${replacement.id}::uuid`;
    const projected = await publicAiStoredMessages(await f.facts(), f.source, owner, { userId: owner, locale: "de" });
    expect(projected[0]?.meta?.chatDone?.href).toBeUndefined();
    expect(projected[0]?.meta?.chatDone?.name).toBeUndefined();
  });

  test.each(["cancel", "archive", "failed"] as const)(
    "a queued request that ends by %s writes exactly one fact without a target turn",
    async (state) => {
      const f = await queuedFixture();
      if (state === "cancel") expect(await updateQueuedMessage(f.target.id, f.id, "cancel")).toBe(true);
      else if (state === "archive")
        expect(await aiConversations.archiveConversation({ conversationId: f.target.id, ownerUserId: owner })).toBeTruthy();
      else
        await drainQueuedMessages(
          async () => {},
          f.target.id,
          async () => {
            throw new AiQueuedChatStartError("source_restricted");
          },
        );
      const [queued] = await sql<
        { status: string; error: string | null }[]
      >`SELECT status,error FROM ai.queued_messages WHERE id=${f.id}::uuid`;
      expect(queued?.status).toBe(state === "failed" ? "failed" : "cancelled");
      if (state === "failed") expect(queued?.error).toBe("source_restricted");
      const facts = await f.facts();
      expect(facts).toHaveLength(1);
      expect(facts[0]?.meta?.chatDone).toMatchObject({ turnId: null, messageSeq: null, status: state === "failed" ? "failed" : "aborted" });
      expect(await sql`SELECT id FROM ai.turns WHERE conversation_id=${f.target.id}::uuid`).toHaveLength(0);
      await sql`UPDATE ai.queued_messages SET delegated_done_at=NULL WHERE id=${f.id}::uuid`;
      await sweepAiChatDone(200);
      expect(await f.facts()).toHaveLength(1);
      expect(await sql`SELECT id FROM ai.queued_messages WHERE id=${f.id}::uuid AND delegated_done_at IS NULL`).toHaveLength(0);
    },
  );

  test("quota rejection records the queued failure before any target turn starts", async () => {
    const f = await queuedFixture();
    f.submission.runConfig.assistantChat = true;
    f.submission.runConfig.accessSubject = { type: "user", userId: owner };
    await sql`UPDATE ai.queued_messages SET submission=${JSON.stringify(f.submission)}::jsonb WHERE id=${f.id}::uuid`;
    const quota = spyOn(aiQuotas, "assertAllowed").mockRejectedValue(new AiQuotaError("quota_exhausted", "Fixture quota exhausted"));
    try {
      await expect(assertQueuedMessageQuota(f.target.id, f.id)).rejects.toThrow("Fixture quota exhausted");
      expect(await f.facts()).toHaveLength(1);
      expect((await f.facts())[0]?.meta?.chatDone).toMatchObject({ status: "failed", turnId: null, messageSeq: null });
      await expect(assertQueuedMessageQuota(f.target.id, f.id)).rejects.toThrow("Fixture quota exhausted");
      expect(await f.facts()).toHaveLength(1);
    } finally {
      quota.mockRestore();
    }
  });

  test("an unconfirmed interruption records the queued failure without ending the interrupted turn", async () => {
    const f = await queuedFixture();
    const { turn } = await aiConversations.submitChatTurn({
      ...f.submission,
      runConfig: { kind: "chat", input: "Old work", toolSource: { kind: "none" } },
    });
    await sql`UPDATE ai.turns SET status='running' WHERE id=${turn.id}::uuid`;
    await sql`INSERT INTO ai.tool_calls(turn_id,conversation_id,call_id,tool_name,status,started_at)
      VALUES(${turn.id}::uuid,${f.target.id}::uuid,'server-effect','write_file','running',now())`;
    await requestQueuedMessageSendNow(f.target.id, f.id);
    await reconcileQueuedInterruptions(f.target.id);
    await reconcileQueuedInterruptions(f.target.id);
    expect(
      await sql`SELECT id FROM ai.queued_messages WHERE id=${f.id}::uuid AND status='failed' AND error='interruption_unconfirmed'`,
    ).toHaveLength(1);
    expect(await f.facts()).toHaveLength(1);
    expect((await f.facts())[0]?.meta?.chatDone).toMatchObject({ status: "failed", turnId: null, messageSeq: null });
    expect((await aiConversations.getTurn({ conversationId: f.target.id, turnId: turn.id }))?.status).toBe("running");
    await aiConversations.completeTurn({ conversationId: f.target.id, turnId: turn.id, status: "completed" });
  });

  test("retry keeps the old fact but cannot link it to a removed or reused sequence", async () => {
    const f = await fixture();
    await f.end("aborted");
    await aiConversations.truncateMessagesFrom({ conversationId: f.target.id, fromSeq: 1 });
    const project = () => f.facts().then((facts) => publicAiStoredMessages(facts, f.source, owner, { userId: owner, locale: "de" }));
    expect((await project())[0]?.meta?.chatDone?.href).toBe(`/app/assistant?conversation=${f.target.shortId}`);
    const work = await aiConversations.submitChatTurn({
      conversationId: f.target.id,
      modelId: "fixture",
      retrySourceTurnId: f.work.turn.id,
      runConfig: { kind: "chat", input: "Retry", toolSource: { kind: "none" } },
      userMessage: { role: "user", content: [{ type: "text", text: "Retry" }] },
    });
    await aiConversations
      .createSessionStore({ conversationId: f.target.id, turnId: work.turn.id })
      .append({ role: "assistant", content: [{ type: "text", text: "New result" }] });
    await aiConversations.completeTurn({ conversationId: f.target.id, turnId: work.turn.id, status: "completed" });
    const facts = await project();
    expect(facts).toHaveLength(2);
    expect(facts[0]?.meta?.chatDone).toMatchObject({ messageSeq: null, href: `/app/assistant?conversation=${f.target.shortId}` });
    expect(facts[1]?.meta?.chatDone).toMatchObject({
      messageSeq: 2,
      summary: "New result",
      href: `/app/assistant?conversation=${f.target.shortId}&message=2`,
    });
  });

  test("a source SELECT error rolls back to the savepoint and recovery can repair it", async () => {
    const f = await fixture();
    const config = await aiConversations.getTurnRunConfig({ conversationId: f.target.id, turnId: f.work.turn.id });
    await sql`UPDATE ai.turns SET run_config=jsonb_set(run_config,'{send,id}','"invalid"'::jsonb) WHERE id=${f.work.turn.id}::uuid`;
    expect(await f.end("completed")).toBe("completed");
    expect(await f.facts()).toHaveLength(0);
    expect(
      await sql`SELECT id FROM ai.turns WHERE id=${f.work.turn.id}::uuid AND status='completed'
      AND delegated_done_at IS NULL AND delegated_done_fail_count=1`,
    ).toHaveLength(1);
    await sql`UPDATE ai.turns SET run_config=${JSON.stringify(config)}::jsonb WHERE id=${f.work.turn.id}::uuid`;
    await sweepAiChatDone(200);
    expect(await f.facts()).toHaveLength(1);
  });

  test("a permanent source INSERT failure cannot roll back the target or starve the recovery batch", async () => {
    const f = await fixture();
    await sql.unsafe(`CREATE FUNCTION ai.reject_done_fixture() RETURNS trigger AS $$ BEGIN
      IF NEW.conversation_id='${f.source.id}'::uuid AND NEW.meta ? 'chatDone' THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='fixture'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await sql`CREATE TRIGGER reject_done_fixture BEFORE INSERT ON ai.messages FOR EACH ROW EXECUTE FUNCTION ai.reject_done_fixture()`.simple();
    try {
      expect(await f.end("completed")).toBe("completed");
      for (let attempt = 0; attempt < 4; attempt++) await sweepAiChatDone(1);
      expect(
        await sql`SELECT id FROM ai.turns WHERE id=${f.work.turn.id}::uuid AND status='completed'
        AND delegated_done_at IS NULL AND delegated_done_fail_count=5`,
      ).toHaveLength(1);
      const healthy = await fixture();
      await sql`UPDATE ai.turns SET status='completed',completed_at=now() WHERE id=${healthy.work.turn.id}::uuid`;
      await sweepAiChatDone(1);
      expect(await healthy.facts()).toHaveLength(1);
    } finally {
      await sql`DROP TRIGGER reject_done_fixture ON ai.messages`.simple();
      await sql`DROP FUNCTION ai.reject_done_fixture()`.simple();
    }
    await sweepAiChatDone(200);
    expect(await f.facts()).toHaveLength(0);
  });

  testFor(
    "database",
    "nats",
    "valkey",
  )("the runtime sweep repairs a delegated turn that sweepTurns itself finalizes", async () => {
    const f = await fixture();
    await sql`UPDATE ai.turns SET attempt=5 WHERE id=${f.work.turn.id}::uuid`;
    const finished: string[] = [];
    await sweepAiRuntime(async (event) => {
      finished.push(event.turnId);
    });
    expect(finished).toContain(f.work.turn.id);
    expect((await aiConversations.getTurn({ conversationId: f.target.id, turnId: f.work.turn.id }))?.status).toBe("failed");
    expect(await f.facts()).toHaveLength(1);
    expect((await f.facts())[0]?.meta?.chatDone?.status).toBe("failed");
  });
});
