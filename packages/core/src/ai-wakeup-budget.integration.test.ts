import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { aiConversations } from "@k2b/cloud/ai";
import { aiModelFixture } from "../../../scripts/fixtures/code-platform";
import { suiteFor, useMigratedDatabase } from "../../../scripts/fixtures/test-infra";
import {
  CodeChatBudgetError,
  checkAutomationChatBudget,
  reserveCodeChatTurnBudget,
  settleCodeChatTurnBudget,
} from "./code/chat-turn-budget";

const owner = "5c000000-0000-4000-8000-000000000001";
const at = new Date("2026-11-18T12:00:00Z");
const limits = { code: 1, owner: 1, timeZone: "UTC" };
const profile = aiModelFixture({
  id: "alarm-budget",
  pricing: { inputPerMillion: 2.5, outputPerMillion: 10 },
  contextWindow: 128_000,
  maxOutputTokens: 4096,
});

suiteFor(
  "database",
  "valkey",
  "nats",
)("alarms reuse automation day and turn reservations", () => {
  let database: Awaited<ReturnType<typeof useMigratedDatabase>>;
  beforeAll(async () => {
    setSystemTime(at);
    database = await useMigratedDatabase("ai_wakeup_budget");
    await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${owner}::uuid,'alarm-budget-owner','local','user')`;
  }, 30_000);
  afterAll(async () => {
    setSystemTime();
    await database?.drop();
  });

  test("alarms share the Code owner's day: a waiting turn checks but a worker reserves", async () => {
    const chat = await aiConversations.createConversation({ ownerUserId: owner });
    const { turn } = await aiConversations.submitChatTurn({
      conversationId: chat.id,
      modelId: profile.id,
      userMessage: { role: "user", content: ["Prüfe die Antwort"] },
      runConfig: { kind: "chat", input: "Prüfe die Antwort", turnTrigger: { kind: "wakeup", id: "alarm" } },
    });
    const admission = { turnId: turn.id, codeId: "wakeup:alarm", ownerUserId: owner, profile };
    await sql.begin((db) => checkAutomationChatBudget(admission, db, limits, at));
    expect(await sql`SELECT 1 FROM code.chat_turn_budgets WHERE turn_id=${turn.id}::uuid`).toHaveLength(0);
    await sql.begin((db) => reserveCodeChatTurnBudget(admission, db, limits, at));
    const [reserved] = await sql<{ reserved: string }[]>`SELECT reserved::text FROM code.chat_turn_budgets WHERE turn_id=${turn.id}::uuid`;
    expect(Number(reserved?.reserved)).toBe(0.68);
    // A Code and a second alarm both see the same already-reserved owner counter.
    for (const codeId of ["c_another", "wakeup:another"])
      await expect(sql.begin((db) => checkAutomationChatBudget({ ...admission, codeId }, db, limits, at))).rejects.toBeInstanceOf(
        CodeChatBudgetError,
      );
    // A worker retry reuses its own reservation, instead of spending twice.
    await sql.begin((db) => reserveCodeChatTurnBudget(admission, db, limits, at));
    expect(await sql`SELECT 1 FROM code.chat_turn_budgets WHERE turn_id=${turn.id}::uuid`).toHaveLength(1);
    await sql`UPDATE ai.turns SET status='completed' WHERE id=${turn.id}::uuid`;
    await sql.begin((db) => settleCodeChatTurnBudget(turn.id, db));
    // No provider was called: finalization releases the whole reservation through the normal settlement.
    await sql.begin((db) => checkAutomationChatBudget({ ...admission, codeId: "c_another" }, db, limits, at));
  });
});
