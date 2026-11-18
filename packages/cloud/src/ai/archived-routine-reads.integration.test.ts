import { afterAll, beforeAll, expect, test } from "bun:test";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { databaseSuite, testInfra, useMigratedDatabase } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import { reviewFixture } from "../_internal/capability-review.test-fixture";
import type { AiActionCheck } from "./action-review";
import type { AiTurnBlock } from "./protocol";

const database = testInfra.database ? await useMigratedDatabase("archived_routine_reads") : null;
afterAll(async () => {
  await database?.drop();
});
const { sql } = await import("../runtime/clients");
const { aiConversations, readAiToolCheck } = await import("./store");

const review = reviewFixture();
const check: AiActionCheck = { state: "done", receipt: { text: "Preserved receipt" }, at: "2026-11-06T08:00:00.000Z" };
const callId = "archived-call";
const turnId = "22222222-2222-4222-8222-222222222222";
const activeTurnId = "33333333-3333-4333-8333-333333333333";
let conversationId: string;
let activeConversationId: string;

databaseSuite()("archived routine message reads", () => {
  beforeAll(async () => {
    const [owner] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, mail)
      VALUES ('archived-routine-reads-owner', 'local', 'user', 'archive@example.test') RETURNING id`;
    conversationId = (await aiConversations.createConversation({ ownerUserId: owner!.id })).id;
    activeConversationId = (await aiConversations.createConversation({ ownerUserId: owner!.id })).id;
    const blocks: AiTurnBlock[] = [
      { id: "tool-archived-call", kind: "tool", callId, name: "demo.send", status: "failed", check: { state: "pending" } },
    ];
    await sql.begin(async (db) => {
      // Model pre-retirement data only in our private database; restore both fences before reading.
      await db`ALTER TABLE ai.turns DISABLE TRIGGER ai_retired_routine_turn`;
      await db`ALTER TABLE ai.task_messages DISABLE TRIGGER ai_routine_archive_read_only`;
      await db`INSERT INTO ai.turns(id, short_id, conversation_id, status, run_config)
        VALUES (${turnId}::uuid, ${testShortId()}, ${conversationId}::uuid, 'aborted',
          '{"kind":"chat","background":{"taskId":"Task01","occurrenceId":"Run001","context":[]}}'::jsonb)`;
      // An interactive turn stays active; routine metadata must never bleed into it.
      await db`INSERT INTO ai.turns(id, short_id, conversation_id, status, run_config, live_blocks)
        VALUES (${activeTurnId}::uuid, ${testShortId()}, ${activeConversationId}::uuid, 'running',
          '{"kind":"chat"}'::jsonb, ${JSON.stringify(blocks)}::text::jsonb)`;
      await db`INSERT INTO ai.task_messages(short_id, conversation_id, seq, kind, role, message, loop_id, meta, compacted_at)
        VALUES (${testShortId()}, ${conversationId}::uuid, 1, 'message', 'assistant',
          ${JSON.stringify({ role: "assistant", content: [{ type: "tool_call", id: callId, name: "demo.send", args: {} }] })}::text::jsonb,
          ${turnId}, ${JSON.stringify({ toolReviews: { [callId]: review }, toolChecks: { [callId]: check } })}::text::jsonb,
          '2026-11-06T08:00:00Z')`;
      await db`ALTER TABLE ai.task_messages ENABLE TRIGGER ai_routine_archive_read_only`;
      await db`ALTER TABLE ai.turns ENABLE TRIGGER ai_retired_routine_turn`;
    });
    // A missing live check still falls through to the preserved archive check.
    await sql`INSERT INTO ai.messages(short_id, conversation_id, seq, kind, role, message, loop_id, meta)
      VALUES (${testShortId()}, ${conversationId}::uuid, 1, 'message', 'assistant',
        ${JSON.stringify({ role: "assistant", content: [{ type: "tool_call", id: callId, name: "demo.send", args: {} }] })}::text::jsonb,
        ${turnId}, ${JSON.stringify({ toolChecks: { [callId]: null } })}::text::jsonb)`;
  });

  test("readAiToolCheck reads an archived call in one statement and keeps its scope", async () => {
    const meter = await meterSql();
    try {
      const statements = await meter.during(async () => {
        expect(await readAiToolCheck({ conversationId, turnId, callId })).toEqual(check);
      });
      expect(statements).toHaveLength(1);
      expect(await readAiToolCheck({ conversationId: activeConversationId, turnId, callId })).toBeNull();
      expect(await readAiToolCheck({ conversationId, turnId: activeTurnId, callId })).toBeNull();
      expect(await readAiToolCheck({ conversationId, turnId, callId: "missing-call" })).toBeNull();
      const liveCheck: AiActionCheck = { state: "not_done", at: "2026-11-06T09:00:00.000Z" };
      await sql`UPDATE ai.messages SET meta=${JSON.stringify({ toolChecks: { [callId]: liveCheck } })}::text::jsonb
        WHERE conversation_id=${conversationId}::uuid AND loop_id=${turnId}`;
      expect(await readAiToolCheck({ conversationId, turnId, callId })).toEqual(liveCheck);
    } finally {
      await meter.close();
    }
  });

  test("getActiveTurn excludes archived routines, rejects revival, and keeps the interactive statement budget", async () => {
    const meter = await meterSql();
    try {
      const archivedStatements = await meter.during(async () => {
        expect(await aiConversations.getActiveTurn({ conversationId })).toBeNull();
      });
      expect(archivedStatements).toHaveLength(1);
      await expect(sql`UPDATE ai.turns SET status='running' WHERE id=${turnId}::uuid`.execute()).rejects.toThrow(
        "routines are retired",
      );
      await expect(
        sql`UPDATE ai.task_messages SET loop_id=${activeTurnId}, conversation_id=${activeConversationId}::uuid
          WHERE loop_id=${turnId}`.execute(),
      ).rejects.toThrow("read-only");
      const activeStatements = await meter.during(async () => {
        const active = await aiConversations.getActiveTurn({ conversationId: activeConversationId });
        expect(active?.turn.id).toBe(activeTurnId);
        expect(active?.liveBlocks).toEqual([
          { id: "tool-archived-call", kind: "tool", callId, name: "demo.send", status: "failed", check: { state: "pending" } },
        ]);
      });
      expect(activeStatements).toHaveLength(3);
    } finally {
      await meter.close();
    }
  });

  test("listTurnToolReviews reads archived reviews in one statement and keeps its scope", async () => {
    const meter = await meterSql();
    try {
      const statements = await meter.during(async () => {
        expect(await aiConversations.listTurnToolReviews({ conversationId, turnId })).toEqual(new Map([[callId, review]]));
      });
      expect(statements).toHaveLength(1);
      expect(await aiConversations.listTurnToolReviews({ conversationId: activeConversationId, turnId })).toEqual(new Map());
      expect(await aiConversations.listTurnToolReviews({ conversationId, turnId: activeTurnId })).toEqual(new Map());
    } finally {
      await meter.close();
    }
  });
});
