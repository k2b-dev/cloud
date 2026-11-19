import { afterAll, beforeAll, expect, test } from "bun:test";
import { suiteFor, useMigratedDatabase } from "../../../../scripts/fixtures/test-infra";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { sql } from "../runtime/clients";
import { appendAiChatDone, sweepAiChatDone } from "./chat-done";
import { enqueueAiChatSend } from "./chat-send";
import { publicAiStoredMessages } from "./public-projection";
import { aiConversations } from "./store";
import type { AiChatTurnRunConfig } from "./types";

suiteFor("database")("delegated chat completion", () => {
  let database: Awaited<ReturnType<typeof useMigratedDatabase>>;
  const owner = "99000000-0000-4000-8000-000000000001";
  beforeAll(async () => {
    database = await useMigratedDatabase("chat_done");
    await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${owner}::uuid,'chat-done-owner','local','user')`;
  }, 30_000);
  afterAll(async () => { await database?.drop(); });

  const fixture = async () => {
    const source = await aiConversations.createConversation({ ownerUserId: owner, title: "Reise nach Lyon" });
    const target = await aiConversations.createConversation({ ownerUserId: owner, title: "Hotels in Lyon" });
    const config: AiChatTurnRunConfig = { kind: "chat", input: "Find hotels", toolSource: { kind: "none" },
      writerOrigin: { kind: "person", id: owner }, turnTrigger: { kind: "person", id: owner } };
    const sourceWork = await aiConversations.submitChatTurn({ conversationId: source.id, modelId: "fixture", runConfig: config,
      userMessage: { role: "user", content: [{ type: "text", text: "Delegate" }] } });
    await aiConversations.completeTurn({ conversationId: source.id, turnId: sourceWork.turn.id, status: "completed" });
    const id = crypto.randomUUID();
    const runConfig: AiChatTurnRunConfig = { ...config, chatId: target.shortId,
      writerOrigin: { kind: "chat", id: source.shortId, turnId: sourceWork.turn.shortId },
      turnTrigger: { kind: "chat", id: source.shortId }, send: { id, accountId: owner, keyHash: id, requestHash: id } };
    const submission = { conversationId: target.id, modelId: "fixture", runConfig,
      userMessage: { role: "user" as const, content: [{ type: "text" as const, text: "Find hotels" }] } };
    await sql.begin(async (db) => {
      await db`SELECT id FROM ai.conversations WHERE id=${target.id}::uuid FOR UPDATE`;
      await enqueueAiChatSend(submission, [{ type: "text", text: "Find hotels" }], db,
        { conversationId: source.id, turnId: sourceWork.turn.id });
    });
    const work = await aiConversations.submitChatTurn({ ...submission, queuedMessageId: id });
    await aiConversations.createSessionStore({ conversationId: target.id, turnId: work.turn.id }).append(
      { role: "assistant", content: [{ type: "text", text: "Three hotels compared." }] });
    const facts = async () => (await aiConversations.listMessages({ conversationId: source.id })).filter((m) => m.meta?.chatDone);
    return { source, target, sourceWork, work, facts,
      end: (status: "completed" | "failed" | "aborted") => aiConversations.completeTurn({
        conversationId: target.id, turnId: work.turn.id, status,
        ...(status === "failed" ? { error: "Fixture failure", turnError: { code: "failed" as const } } : {}),
      }) };
  };

  test.each(["completed", "failed", "aborted"] as const)("%s records one activity, pins the end statements and never starts a source turn", async (status) => {
    const f = await fixture();
    const meter = await meterSql();
    let statements: string[];
    try { statements = await meter.during(async () => { expect(await f.end(status)).toBe("completed"); }); }
    finally { await meter.close(); }
    // BEGIN/COMMIT and the short-ID savepoint are included. A delegated end adds exactly four statements.
    expect(statements).toHaveLength(status === "completed" ? 13 : 15);
    const facts = await f.facts();
    expect(facts).toHaveLength(1);
    expect(facts[0]?.loopId).toBeNull();
    expect(facts[0]?.meta?.chatDone).toMatchObject({ chatId: f.target.shortId, turnId: f.work.turn.shortId, status, messageSeq: 2 });
    expect(await sql`SELECT id FROM ai.turns WHERE conversation_id=${f.source.id}::uuid`).toHaveLength(1);
    expect(await sql`SELECT id FROM ai.queued_messages WHERE conversation_id=${f.source.id}::uuid`).toHaveLength(0);
    expect((await aiConversations.listContextMessages({ conversationId: f.source.id })).some((m) => m.meta?.chatDone)).toBe(false);
    const projected = await publicAiStoredMessages(facts, f.source, owner, { userId: owner, locale: "de" });
    expect(projected[0]?.meta?.chatDone).toMatchObject({ name: "Hotels in Lyon",
      href: `/app/assistant?conversation=${f.target.shortId}&message=2` });
    await sql`UPDATE ai.conversations SET archived_at=now() WHERE id=${f.target.id}::uuid`;
    const unavailable = await publicAiStoredMessages(facts, f.source, owner, { userId: owner, locale: "de" });
    expect(unavailable[0]?.meta?.chatDone?.href).toBeUndefined();
    expect(unavailable[0]?.meta?.chatDone?.name).toBeUndefined();
    expect(projected[0]?.meta?.chatDone?.targetConversationId).toBeUndefined();
  });

  test("ordinary turn completion keeps its existing statement budget", async () => {
    const conversation = await aiConversations.createConversation({ ownerUserId: owner });
    const work = await aiConversations.submitChatTurn({ conversationId: conversation.id, modelId: "fixture",
      runConfig: { kind: "chat", input: "Hello", toolSource: { kind: "none" },
        writerOrigin: { kind: "person", id: owner }, turnTrigger: { kind: "person", id: owner } },
      userMessage: { role: "user", content: [{ type: "text", text: "Hello" }] } });
    const meter = await meterSql();
    try {
      const statements = await meter.during(async () => {
        expect(await aiConversations.completeTurn({ conversationId: conversation.id, turnId: work.turn.id, status: "completed" })).toBe("completed");
      });
      expect(statements).toHaveLength(9);
    } finally { await meter.close(); }
  });

  test("terminal status and fact roll back together; restart sweep repairs a terminal turn and repeated keys stay singular", async () => {
    const f = await fixture();
    await expect(sql.begin(async (db) => {
      await db`UPDATE ai.turns SET status='completed',completed_at=now() WHERE id=${f.work.turn.id}::uuid`;
      await appendAiChatDone(f.work.turn.id, db);
      throw new Error("crash before commit");
    })).rejects.toThrow("crash before commit");
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

  test.each(["deleted", "archived"])("a %s origin receives no line or timestamp change, even if its public IDs are reused", async (state) => {
    const f = await fixture();
    const before = (await aiConversations.getConversation({ conversationId: f.source.id }))?.updatedAt;
    if (state === "deleted") {
      await sql`DELETE FROM ai.conversations WHERE id=${f.source.id}::uuid`;
      const replacement = await aiConversations.createConversation({ ownerUserId: owner });
      await sql`UPDATE ai.conversations SET short_id=${f.source.shortId} WHERE id=${replacement.id}::uuid`;
      await sql`INSERT INTO ai.turns(short_id,conversation_id,status) VALUES(${f.sourceWork.turn.shortId},${replacement.id}::uuid,'completed')`;
    } else await sql`UPDATE ai.conversations SET archived_at=now() WHERE id=${f.source.id}::uuid`;
    await f.end("completed");
    await sweepAiChatDone(200);
    expect(await sql`SELECT id FROM ai.messages WHERE delegated_target_turn_id=${f.work.turn.id}::uuid`).toHaveLength(0);
    if (state === "archived") expect((await aiConversations.getConversation({ conversationId: f.source.id, archived: true }))?.updatedAt).toBe(before);
  });

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
});
