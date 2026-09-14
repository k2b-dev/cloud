import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { migrate as migrateAuth } from "../../../core/src/migrate/core/auth";
import { migrateCloudAi } from "./migrate";
import { aiConversations } from "./store";
import type { AiTodoPlan } from "./todo-contracts";

const isolated = /\/cloud_working_plan_test$/.test(process.env.DATABASE_URL ?? "");
(isolated ? describe : describe.skip)("working plan and execution budget in disposable Postgres", () => {
  const userId = crypto.randomUUID();
  beforeAll(async () => {
    await migrateAuth();
    await sql`CREATE SCHEMA settings`;
    await sql`CREATE TABLE settings.entries(key text PRIMARY KEY,value text)`;
    await migrateCloudAi();
    await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${userId},'plan-fixture','local','user')`;
  });
  test("plan survives compaction and fork, rolls back on retry, ignores failed updates", async () => {
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const store = aiConversations.createSessionStore({ conversationId: chat.id, modelProfileId: "fixture" });
    const plan: AiTodoPlan = { todos: [{ id: "check", content: "Check the data", status: "pending" }] };
    await store.append({ role: "tool_result", callId: "one", name: "todo_write", result: plan });
    const checkpoint = (await aiConversations.listMessages({ conversationId: chat.id })).at(-1)!;
    await aiConversations.compactMessages({ conversationId: chat.id, checkpointSeq: checkpoint.seq, summary: { role: "assistant", content: [{ type: "text", text: "A short handoff" }] } });
    const fork = await aiConversations.forkConversation({ sourceConversationId: chat.id, ownerUserId: userId, throughSeq: checkpoint.seq });
    expect((await aiConversations.getConversation({ conversationId: fork.id }))?.todoPlan?.todos).toEqual(plan.todos);
    expect(JSON.stringify(await aiConversations.listContextMessages({ conversationId: fork.id }))).toContain("Check the data");
    expect(await aiConversations.getConversation({ conversationId: chat.id, ownerUserId: crypto.randomUUID() })).toBeNull();
    await store.append({ role: "tool_result", callId: "bad", name: "todo_write", result: { todos: [] }, isError: true });
    expect((await aiConversations.getConversation({ conversationId: chat.id }))?.todoPlan?.todos).toEqual(plan.todos);
    await store.append({ role: "tool_result", callId: "clear", name: "todo_write", result: { todos: [] } });
    expect((await aiConversations.getConversation({ conversationId: chat.id }))?.todoPlan?.todos).toEqual([]);
    const last = (await aiConversations.listMessages({ conversationId: chat.id })).at(-1)!;
    await aiConversations.truncateMessagesFrom({ conversationId: chat.id, fromSeq: last.seq });
    expect((await aiConversations.getConversation({ conversationId: chat.id }))?.todoPlan?.todos).toEqual(plan.todos);
  });
  test("zero budget has no deadline, lease reclaim keeps the original budget", async () => {
    for (const budget of [0, 30 * 60_000]) {
      const chat = await aiConversations.createConversation({ ownerUserId: userId });
      const { turn } = await aiConversations.submitChatTurn({ conversationId: chat.id, modelProfileId: "fixture", runConfig: { kind: "chat", input: "work", toolSource: { kind: "none" } }, userMessage: { role: "user", content: [{ type: "text", text: "work" }] } });
      const claim = await aiConversations.claimTurn({ conversationId: chat.id, turnId: turn.id, from: "queue", leaseOwner: "fixture", leaseMs: 45000, maxAttempts: 5, runBudgetMs: budget });
      expect(claim?.turn.runBudgetMs).toBe(budget);
      expect(claim?.turn.deadline === null).toBe(budget === 0);
      await sql`UPDATE ai.turns SET lease_expires_at=now()-interval '1 second' WHERE id=${turn.id}`;
      const resumed = await aiConversations.claimTurn({ conversationId: chat.id, turnId: turn.id, from: "queue", leaseOwner: "fixture-2", leaseMs: 45000, maxAttempts: 5, runBudgetMs: 60000 });
      expect(resumed?.turn.runBudgetMs).toBe(budget);
      expect(resumed?.turn.deadline).toBe(claim?.turn.deadline);
    }
  });
});
