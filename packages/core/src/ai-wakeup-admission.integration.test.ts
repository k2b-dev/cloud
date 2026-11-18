import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import * as publicAi from "@k2b/cloud/ai";
import { aiConversations, aiWakeups } from "@k2b/cloud/ai";
import { type AiChatTurnAdmission, enqueueAiChatSend, type QueuedChatSubmission } from "@k2b/cloud/ai/runtime";
import { accounts, coreSettings } from "@k2b/cloud/services";
import { useTestAppRegistry } from "../../../scripts/fixtures/app-registry";
import { aiModelFixture, aiSettingsFixture } from "../../../scripts/fixtures/code-platform";
import { suiteFor, useMigratedDatabase } from "../../../scripts/fixtures/test-infra";
import { admitCodeChatTurn } from "./ai-chat-budget";
import { validateQueuedChatStart } from "./ai-chat-queue";
import { codeSettings } from "./code/settings";

const owner = "5d000000-0000-4000-8000-000000000001";
const other = "5d000000-0000-4000-8000-000000000002";
const now = new Date("2026-11-18T12:00:00Z");
const planned = "2026-11-18T12:01:00.000Z";
const profile = aiModelFixture({
  id: "alarm-admission",
  pricing: { inputPerMillion: 2.5, outputPerMillion: 10 },
  contextWindow: 128_000,
  maxOutputTokens: 4096,
});
const state = aiSettingsFixture({ profiles: [profile] });
const leaseOwner = "alarm-admission-worker";

suiteFor(
  "database",
  "valkey",
  "nats",
)("Core alarm queue and worker admission", () => {
  useTestAppRegistry(["core", "assistant"]);
  let database: Awaited<ReturnType<typeof useMigratedDatabase>>;
  let budgetSettings: ReturnType<typeof spyOn<typeof codeSettings, "get">>;
  let globalSettings: ReturnType<typeof spyOn<typeof coreSettings, "get">>;
  let selectModel: ReturnType<typeof spyOn<typeof publicAi, "selectAssistantAiModel">>;
  beforeAll(async () => {
    database = await useMigratedDatabase("ai_wakeup_admission");
    for (const id of [owner, other]) await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${id}::uuid,${id},'local','user')`;
  }, 30_000);
  beforeEach(async () => {
    setSystemTime(now);
    await sql`DELETE FROM code.chat_turn_budgets`;
    await sql`DELETE FROM code.ai_daily_budget`;
    await sql`DELETE FROM ai.conversations WHERE created_by_user_id=${owner}::uuid`;
    await sql`UPDATE ai.cost_config SET enabled=false,rules='[]',background=NULL WHERE singleton`;
    budgetSettings = spyOn(codeSettings, "get").mockResolvedValue(1);
    globalSettings = spyOn(coreSettings, "get").mockResolvedValue("UTC");
    selectModel = spyOn(publicAi, "selectAssistantAiModel").mockResolvedValue({ id: profile.id });
  });
  afterEach(() => {
    selectModel?.mockRestore();
    globalSettings?.mockRestore();
    budgetSettings?.mockRestore();
    setSystemTime();
  });
  afterAll(async () => {
    await database?.drop();
  });

  const fixture = async () => {
    const user = await accounts.users.get({ id: owner });
    if (!user) throw new Error("Alarm owner missing");
    const subject = { actor: { kind: "user" as const, user }, accessSubject: { type: "user" as const, userId: owner } };
    const chat = await aiConversations.createConversation({ ownerUserId: owner });
    const alarm = await aiWakeups.create(chat.shortId, { at: planned, note: "Check later", timezone: "UTC" }, subject, "en", now);
    const messageId = crypto.randomUUID();
    const submission: QueuedChatSubmission = {
      conversationId: chat.id,
      modelId: profile.id,
      expectedProjectId: null,
      userMessage: { role: "user", content: [{ type: "text", text: alarm.note }] },
      runConfig: {
        kind: "chat",
        input: alarm.note,
        chatId: chat.shortId,
        actor: subject.actor,
        assistantChat: true,
        writerOrigin: { kind: "wakeup", id: alarm.id, scheduledAt: planned },
        turnTrigger: { kind: "wakeup", id: alarm.id },
        wakeup: { id: alarm.id, scheduledAt: planned, firedAt: planned, snoozes: 0 },
        send: { id: messageId, accountId: owner, keyHash: messageId, requestHash: messageId },
        toolSource: { kind: "default" },
        locale: "en",
      },
    };
    await sql.begin((db) => enqueueAiChatSend(submission, [{ type: "text", text: alarm.note }], db));
    await sql`UPDATE ai.wakeups SET status='done',next_at=NULL,last_message_id=${messageId}::uuid WHERE id=${alarm.id}::uuid`;
    const { turn } = await aiConversations.submitChatTurn({ ...submission, queuedMessageId: messageId });
    await sql`UPDATE ai.turns SET status='running',lease_owner=${leaseOwner},lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=${turn.id}::uuid`;
    const worker: Parameters<AiChatTurnAdmission>[0] = {
      turnId: turn.id,
      conversationId: chat.id,
      leaseOwner,
      runConfig: submission.runConfig,
      profile,
      signal: new AbortController().signal,
    };
    return { chat, alarm, submission, messageId, worker };
  };
  const validate = (f: Awaited<ReturnType<typeof fixture>>) =>
    sql.begin((db) => validateQueuedChatStart(f.submission, db, state, f.messageId));

  test("valid queue admission reserves nothing; the worker reserves once and installs the automation allocation", async () => {
    const f = await fixture();
    expect((await validate(f)).runConfig.actor).toMatchObject({ kind: "user", user: { id: owner } });
    expect(await sql`SELECT 1 FROM code.chat_turn_budgets WHERE turn_id=${f.worker.turnId}::uuid`).toHaveLength(0);
    await admitCodeChatTurn(f.worker);
    await admitCodeChatTurn(f.worker);
    expect(await sql<{ reserved: number }[]>`SELECT reserved::float8 AS reserved FROM code.chat_turn_budgets WHERE turn_id=${f.worker.turnId}::uuid`).toEqual([
      { reserved: 0.68 },
    ]);
    const saved = await aiConversations.getTurnRunConfig({ conversationId: f.chat.id, turnId: f.worker.turnId });
    expect(saved).toMatchObject({ inferenceBudget: { modelProfileId: profile.id, modelCalls: 12 } });
  });

  test("deleting an alarm rejects both the queue and worker admission", async () => {
    const f = await fixture();
    await sql`UPDATE ai.wakeups SET status='deleted' WHERE id=${f.alarm.id}::uuid`;
    await expect(validate(f)).rejects.toMatchObject({ code: "source_restricted" });
    await expect(admitCodeChatTurn(f.worker)).rejects.toMatchObject({ code: "not_allowed" });
    expect(await sql`SELECT 1 FROM code.chat_turn_budgets WHERE turn_id=${f.worker.turnId}::uuid`).toHaveLength(0);
  });

  test.each(["owner", "origin", "hash"] as const)("a changed receipt %s is rejected at both admission boundaries", async (field) => {
    const f = await fixture();
    if (field === "owner") await sql`UPDATE ai.chat_send_receipts SET account_id=${other}::uuid WHERE id=${f.messageId}::uuid`;
    if (field === "origin")
      await sql`UPDATE ai.chat_send_receipts SET origin=jsonb_set(origin,'{scheduledAt}','"2026-11-18T13:00:00.000Z"') WHERE id=${f.messageId}::uuid`;
    if (field === "hash") await sql`UPDATE ai.chat_send_receipts SET input_hash='changed' WHERE id=${f.messageId}::uuid`;
    await expect(validate(f)).rejects.toMatchObject({ code: "source_restricted" });
    await expect(admitCodeChatTurn(f.worker)).rejects.toMatchObject({ code: "not_allowed" });
    expect(await sql`SELECT 1 FROM code.chat_turn_budgets WHERE turn_id=${f.worker.turnId}::uuid`).toHaveLength(0);
  });

  test("a worker budget refusal marks the occurrence missed and exposes host_budget_limit", async () => {
    const f = await fixture();
    await validate(f);
    budgetSettings.mockResolvedValue(0.2);
    await expect(admitCodeChatTurn(f.worker)).rejects.toMatchObject({ code: "host_budget_limit" });
    expect(await sql<{ status: string; missed_reason: string | null }[]>`SELECT status,missed_reason FROM ai.wakeups WHERE id=${f.alarm.id}::uuid`).toEqual([
      { status: "missed", missed_reason: "budget" },
    ]);
    expect(
      await sql`SELECT 1 FROM ai.messages WHERE conversation_id=${f.chat.id}::uuid AND meta#>>'{wakeupEvent,kind}'='missed'`,
    ).toHaveLength(1);
  });

  test("lease loss neither marks the alarm missed nor creates a turn reservation", async () => {
    const f = await fixture();
    await sql`UPDATE ai.turns SET lease_owner='replacement-worker' WHERE id=${f.worker.turnId}::uuid`;
    await expect(admitCodeChatTurn(f.worker)).rejects.toMatchObject({ code: "not_allowed" });
    expect(await sql<{ status: string; missed_reason: string | null }[]>`SELECT status,missed_reason FROM ai.wakeups WHERE id=${f.alarm.id}::uuid`).toEqual([
      { status: "done", missed_reason: null },
    ]);
    expect(
      await sql`SELECT 1 FROM ai.messages WHERE conversation_id=${f.chat.id}::uuid AND meta#>>'{wakeupEvent,kind}'='missed'`,
    ).toHaveLength(0);
    expect(await sql`SELECT 1 FROM code.chat_turn_budgets WHERE turn_id=${f.worker.turnId}::uuid`).toHaveLength(0);
  });
});
