import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor, useMigratedDatabase } from "../../../../scripts/fixtures/test-infra";
import { sql } from "../runtime/clients";
import { accounts } from "../services";
import { AUTOMATION_TURN_BUDGET } from "./code-authoring-turn";
import { aiLiveChannels } from "./live";
import { drainQueuedMessages, type QueuedChatSubmission } from "./message-queue";
import { aiSettingsFixture } from "./model-fixture";
import * as runtime from "./runtime";
import * as settings from "./settings";
import { aiConversations } from "./store";
import { catchUpAiWakeup } from "./wakeup-catch-up";
import { AI_WAKEUP_CHAT_LIMIT, AI_WAKEUP_FAILURE_LIMIT, AI_WAKEUP_TICK_INTERVAL_MS, AI_WAKEUP_MISSED_DAYS } from "./wakeup-contracts";
import { markAiWakeupMissed } from "./wakeup-store";
import { AiWakeupBudgetError, aiWakeupOccurrenceId, tickAiWakeups } from "./wakeup-tick";
import type { AiWakeupAuthority } from "./wakeups";
import { aiWakeups } from "./wakeups";

const owner = "5b000000-0000-4000-8000-000000000001";
const other = "5b000000-0000-4000-8000-000000000002";
const now = new Date("2026-11-18T12:00:00Z");
const due = new Date("2026-11-18T12:01:00Z");
const note = { at: due.toISOString(), note: "Prüfe die Antwort", timezone: "Europe/Berlin" };

suiteFor(
  "database",
  "valkey",
  "nats",
)("scheduled ai.chat.send alarms", () => {
  let database: Awaited<ReturnType<typeof useMigratedDatabase>>;
  let subject: AiWakeupAuthority;
  beforeAll(async () => {
    database = await useMigratedDatabase("ai_wakeups");
    for (const id of [owner, other])
      await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${id}::uuid,${`alarm-${id}`},'local','user')`;
    const user = await accounts.users.get({ id: owner });
    if (!user) throw new Error("Fixture owner missing");
    subject = { actor: { kind: "user", user }, accessSubject: { type: "user", userId: owner } };
  }, 30_000);
  beforeEach(async () => {
    setSystemTime(now);
    await sql`DELETE FROM ai.conversations WHERE created_by_user_id IN (${owner}::uuid,${other}::uuid)`;
    spyOn(runtime, "wakeAiMessageQueue").mockImplementation(() => {});
    spyOn(runtime, "prepareAiChatTurn").mockImplementation(async (input) => ({
      conversationId: input.conversationId,
      modelId: "chat",
      userMessage: input.userMessage,
      expectedProjectId: input.expectedProjectId,
      truncateFromSeq: undefined,
      expectedDraftRevision: undefined,
      resources: undefined,
      retrySourceTurnId: undefined,
      runConfig: {
        kind: "chat",
        input: input.input,
        assistantChat: true,
        actor: input.actor,
        chatId: input.chatId,
        writerOrigin: input.writerOrigin,
        turnTrigger: input.turnTrigger,
        wakeup: input.wakeup,
        send: input.send,
        locale: input.locale,
        toolSource: input.toolSource,
      },
    }));
    spyOn(settings, "readAiSettingsState").mockResolvedValue(aiSettingsFixture());
  });
  afterEach(() => {
    mock.restore();
    setSystemTime();
  });
  afterAll(async () => {
    await database?.drop();
  });
  const chat = () => aiConversations.createConversation({ ownerUserId: owner });
  const tick = (at = due) => tickAiWakeups(async () => {}, { now: at });

  test("only owner with matching accessSubject can create, edit, delete or list", async () => {
    const own = await chat();
    const foreign = await aiConversations.createConversation({ ownerUserId: other });
    await expect(aiWakeups.create(foreign.shortId, note, subject, "de", now)).rejects.toMatchObject({ code: "not_found" });
    const alarm = await aiWakeups.create(own.shortId, note, subject, "de", now);
    const wrong = { ...subject, accessSubject: { type: "user" as const, userId: other } };
    await expect(aiWakeups.list(own.shortId, wrong, "de")).rejects.toMatchObject({ code: "forbidden" });
    await expect(aiWakeups.update(foreign.shortId, alarm.id, { revision: 0, note: "Other" }, subject, "de", now)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(aiWakeups.remove(foreign.shortId, alarm.id, 0, subject, "de", now)).rejects.toMatchObject({ code: "not_found" });
    await sql`UPDATE ai.conversations SET allowed_tools='{}'::text[] WHERE id=${own.id}::uuid`;
    await expect(aiWakeups.create(own.shortId, note, subject, "de", now)).rejects.toMatchObject({ code: "forbidden" });
  });

  test("five concurrent commitments per chat, optimistic edit conflict and renewal", async () => {
    const own = await chat();
    const results = await Promise.allSettled(
      Array.from({ length: AI_WAKEUP_CHAT_LIMIT + 1 }, () => aiWakeups.create(own.shortId, note, subject, "de", now)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(AI_WAKEUP_CHAT_LIMIT);
    const first = (await aiWakeups.list(own.shortId, subject, "de")).items[0]!;
    const edited = await aiWakeups.update(own.shortId, first.id, { revision: first.revision, note: "Neue Notiz" }, subject, "de", now);
    await expect(aiWakeups.remove(own.shortId, first.id, first.revision, subject, "de", now)).rejects.toMatchObject({ code: "conflict" });
    await aiWakeups.remove(own.shortId, first.id, edited.revision, subject, "de", now);
    const recurring = await aiWakeups.create(own.shortId, { ...note, cron: "0 8 * * *" }, subject, "de", now);
    await sql`UPDATE ai.wakeups SET status='expired',next_at=NULL WHERE id=${recurring.id}::uuid`;
    const renewed = await aiWakeups.update(own.shortId, recurring.id, { revision: 0, endsAt: "2026-12-18T12:00:00Z" }, subject, "de", now);
    expect(renewed).toMatchObject({ status: "active", at: "2026-11-19T07:00:00.000Z" });
  });

  test("a due alarm queues the same send contract once, without consuming the person's draft", async () => {
    const own = await chat();
    await sql`UPDATE ai.conversations SET draft_content='[{"type":"text","text":"Entwurf"}]'::jsonb,draft_revision=4 WHERE id=${own.id}::uuid`;
    const alarm = await aiWakeups.create(own.shortId, note, subject, "de", now);
    expect(await tick()).toMatchObject({ queued: 1 });
    expect(await tick()).toMatchObject({ queued: 0 });
    const id = aiWakeupOccurrenceId(alarm.id, due);
    const [entry] = await sql<
      { origin: unknown; submission: { runConfig: unknown } }[]
    >`SELECT origin,submission FROM ai.queued_messages WHERE id=${id}::uuid`;
    expect(entry?.origin).toEqual({ kind: "wakeup", id: alarm.id, scheduledAt: due.toISOString() });
    expect(entry?.submission.runConfig).toMatchObject({
      turnTrigger: { kind: "wakeup", id: alarm.id },
      send: { id, accountId: owner },
      wakeup: { scheduledAt: due.toISOString(), snoozes: 0 },
    });
    expect(await sql`SELECT id FROM ai.chat_send_receipts WHERE id=${id}::uuid`).toHaveLength(1);
    expect((await aiConversations.getConversation({ conversationId: own.id }))?.draft).toMatchObject({
      revision: 4,
      content: [{ type: "text", text: "Entwurf" }],
    });
  });

  test("downtime coalesces recurrence, pending source stays unique, archive pauses", async () => {
    const own = await chat();
    const alarm = await aiWakeups.create(own.shortId, { ...note, cron: "*/15 * * * *" }, subject, "de", now);
    await sql`UPDATE ai.conversations SET archived_at=${now} WHERE id=${own.id}::uuid`;
    expect((await tick(new Date("2026-11-20T12:05:00Z"))).queued).toBe(0);
    await sql`UPDATE ai.conversations SET archived_at=NULL WHERE id=${own.id}::uuid`;
    expect((await tick(new Date("2026-11-20T12:05:00Z"))).queued).toBe(1);
    expect((await aiWakeups.list(own.shortId, subject, "de")).items[0]?.at).toBe("2026-11-20T12:15:00.000Z");
    expect((await tick(new Date("2026-11-20T12:16:00Z"))).queued).toBe(0);
    expect(await sql`SELECT 1 FROM ai.queued_messages WHERE automation_source=${`wakeup:${alarm.id}`} AND status='pending'`).toHaveLength(
      1,
    );
  });

  test("editing a waiting commitment cancels the old occurrence before scheduling the replacement", async () => {
    const own = await chat();
    const alarm = await aiWakeups.create(own.shortId, note, subject, "de", now);
    await tick();
    const updated = await aiWakeups.update(
      own.shortId,
      alarm.id,
      { revision: alarm.revision + 1, at: "2026-11-18T13:00:00Z", note: "Neue Aufgabe" },
      subject,
      "de",
      due,
    );
    expect(await sql`SELECT 1 FROM ai.queued_messages WHERE conversation_id=${own.id}::uuid AND status='pending'`).toHaveLength(0);
    expect((await tick(new Date(updated.at!))).queued).toBe(1);
    const [entry] = await sql<
      { content: unknown }[]
    >`SELECT content FROM ai.queued_messages WHERE conversation_id=${own.id}::uuid AND status='pending'`;
    expect(entry?.content).toEqual([{ type: "text", text: "Neue Aufgabe" }]);
  });

  test("Stop hold leaves due work queued; a later tick never releases it", async () => {
    const own = await chat();
    await aiWakeups.create(own.shortId, note, subject, "de", now);
    await sql`UPDATE ai.conversations SET queue_held_at=${now} WHERE id=${own.id}::uuid`;
    expect((await tick()).queued).toBe(1);
    const dispatch = mock(async () => {});
    await drainQueuedMessages(
      dispatch,
      own.id,
      Object.assign(async (input: QueuedChatSubmission) => input, {}),
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(await sql`SELECT 1 FROM ai.queued_messages WHERE conversation_id=${own.id}::uuid AND status='pending'`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM ai.turns WHERE conversation_id=${own.id}::uuid`).toHaveLength(0);
  });

  test("budget refusal produces a missed timeline fact without a model call; person can catch up once", async () => {
    const own = await chat();
    const alarm = await aiWakeups.create(own.shortId, note, subject, "de", now);
    await tickAiWakeups(
      async () => {
        throw new AiWakeupBudgetError("spent");
      },
      { now: due },
    );
    const missed = (await aiWakeups.list(own.shortId, subject, "de")).items[0]!;
    expect(missed).toMatchObject({ status: "missed", missedReason: "budget", at: due.toISOString() });
    expect(
      await sql`SELECT 1 FROM ai.messages WHERE conversation_id=${own.id}::uuid AND meta#>>'{wakeupEvent,kind}'='missed'`,
    ).toHaveLength(1);
    expect(await sql`SELECT 1 FROM ai.turns WHERE conversation_id=${own.id}::uuid`).toHaveLength(0);
    await catchUpAiWakeup(own.shortId, alarm.id, missed.revision, subject, "de", due);
    await expect(catchUpAiWakeup(own.shortId, alarm.id, missed.revision, subject, "de", due)).rejects.toMatchObject({ code: "conflict" });
    const [entry] = await sql<{ origin: unknown }[]>`SELECT origin FROM ai.queued_messages WHERE conversation_id=${own.id}::uuid`;
    expect(entry?.origin).toEqual({ kind: "person", id: owner });
  });

  test("a final queue refusal preserves the planned time and cannot overwrite a later human edit", async () => {
    const own = await chat();
    const alarm = await aiWakeups.create(own.shortId, note, subject, "de", now);
    await tick();
    const messageId = aiWakeupOccurrenceId(alarm.id, due);
    const mark = () =>
      sql.begin(async (db) => {
        await db`SELECT id FROM ai.conversations WHERE id=${own.id}::uuid FOR UPDATE`;
        await markAiWakeupMissed(own.id, messageId, "access", "de", db);
      });
    await mark();
    const missed = (await aiWakeups.list(own.shortId, subject, "de")).items[0]!;
    expect(missed).toMatchObject({ status: "missed", missedReason: "access", at: due.toISOString() });
    const edited = await aiWakeups.update(
      own.shortId,
      alarm.id,
      { revision: missed.revision, at: "2026-11-18T13:00:00Z" },
      subject,
      "de",
      due,
    );
    await mark();
    expect((await aiWakeups.list(own.shortId, subject, "de")).items[0]).toEqual(edited);
  });

  test("an alarm turn cannot create or alter another alarm, and can postpone its own only three times", async () => {
    const own = await chat();
    const first = await aiWakeups.create(own.shortId, note, subject, "de", now);
    const otherAlarm = await aiWakeups.create(own.shortId, note, subject, "de", now);
    const { turn } = await aiConversations.submitChatTurn({
      conversationId: own.id,
      modelId: "chat",
      userMessage: { role: "user", content: ["Alarm"] },
      runConfig: {
        kind: "chat",
        input: "Alarm",
        actor: subject.actor,
        assistantChat: true,
        toolSource: { kind: "default" },
        turnTrigger: { kind: "wakeup", id: first.id },
      },
      expectedProjectId: null,
    });
    await sql`UPDATE ai.turns SET status='running' WHERE id=${turn.id}::uuid`;
    const source = { ...subject, turnId: turn.id };
    await expect(aiWakeups.create(own.shortId, note, source, "de", now)).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      aiWakeups.update(own.shortId, otherAlarm.id, { revision: 0, at: "2026-11-18T13:00:00Z" }, source, "de", now),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      aiWakeups.update(own.shortId, first.id, { revision: 0, note: "New instruction" }, source, "de", now),
    ).rejects.toMatchObject({ code: "forbidden" });
    let revision = first.revision;
    for (let count = 1; count <= 3; count++) {
      const updated = await aiWakeups.update(own.shortId, first.id, { revision, at: `2026-11-18T${12 + count}:10:00Z` }, source, "de", now);
      expect(updated.snoozes).toBe(count);
      revision = updated.revision;
    }
    await expect(
      aiWakeups.update(own.shortId, first.id, { revision, at: "2026-11-18T16:00:00Z" }, source, "de", now),
    ).rejects.toMatchObject({ code: "snooze_limit" });
  });

  test("a person's retry keeps alarm attribution but never unattended alarm authority or budget", async () => {
    const own = await chat();
    const id = crypto.randomUUID();
    const original = await aiConversations.submitChatTurn({
      conversationId: own.id,
      modelId: "chat",
      userMessage: { role: "user", content: ["Alarm"] },
      runConfig: {
        kind: "chat",
        input: "Alarm",
        actor: subject.actor,
        writerOrigin: { kind: "wakeup", id, scheduledAt: due.toISOString() },
        turnTrigger: { kind: "wakeup", id },
        wakeup: { id, scheduledAt: due.toISOString(), firedAt: due.toISOString(), snoozes: 2 },
        inferenceBudget: {
          inputTokens: AUTOMATION_TURN_BUDGET.inputTokens,
          modelCalls: AUTOMATION_TURN_BUDGET.modelCalls,
          unknownInputTokens: AUTOMATION_TURN_BUDGET.unknownInputTokens,
        },
      },
    });
    await sql`UPDATE ai.turns SET status='completed' WHERE id=${original.turn.id}::uuid`;
    const originalConfig = await aiConversations.getTurnRunConfig({ conversationId: own.id, turnId: original.turn.id });
    if (originalConfig?.kind !== "chat") throw new Error("Missing original alarm turn");
    const retry = await aiConversations.submitChatTurn({
      conversationId: own.id,
      modelId: "chat",
      userMessage: { role: "user", content: ["Alarm"] },
      retrySourceTurnId: original.turn.id,
      runConfig: originalConfig,
    });
    const config = await aiConversations.getTurnRunConfig({ conversationId: own.id, turnId: retry.turn.id });
    expect(config).toMatchObject({ writerOrigin: originalConfig.writerOrigin, turnTrigger: { kind: "person", id: owner } });
    if (config?.kind !== "chat") throw new Error("Missing retry turn");
    expect(config.wakeup).toBeUndefined();
    expect(config.inferenceBudget).toBeUndefined();
    expect(config.codeOrigin).toBeUndefined();
  });

  test("deletion cancels pending work and deleting the chat cascades all alarms", async () => {
    const own = await chat();
    const alarm = await aiWakeups.create(own.shortId, note, subject, "de", now);
    await tick();
    const [current] = (await aiWakeups.list(own.shortId, subject, "de")).items;
    expect(current).toBeUndefined();
    await aiWakeups.remove(own.shortId, alarm.id, alarm.revision + 1, subject, "de", due);
    expect(await sql`SELECT 1 FROM ai.queued_messages WHERE conversation_id=${own.id}::uuid AND status='pending'`).toHaveLength(0);
    await sql`DELETE FROM ai.conversations WHERE id=${own.id}::uuid`;
    expect(await sql`SELECT 1 FROM ai.wakeups WHERE id=${alarm.id}::uuid`).toHaveLength(0);
  });

  test("alarm facts stay visible in history but never enter current or subsequent model context", async () => {
    const own = await chat();
    const alarm = await aiWakeups.create(own.shortId, note, subject, "en", now);
    const { turn } = await aiConversations.submitChatTurn({ conversationId: own.id, modelId: "chat",
      userMessage: { role: "user", content: ["Continue"] }, runConfig: { kind: "chat", input: "Continue" } });
    await aiWakeups.update(own.shortId, alarm.id, { revision: alarm.revision, note: "Later" }, subject, "en", now);
    const current = await aiConversations.createSessionStore({ conversationId: own.id, turnId: turn.id, leaseOwner: "context-test" }).load();
    expect(current.filter((entry) => entry.meta?.wakeupEvent)).toEqual([]);
    expect(JSON.stringify(current)).not.toContain("Alarm set");
    expect(JSON.stringify(current)).not.toContain("Alarm changed");
    await sql`UPDATE ai.turns SET status='completed' WHERE id=${turn.id}::uuid`;
    const next = await aiConversations.submitChatTurn({ conversationId: own.id, modelId: "chat",
      userMessage: { role: "user", content: ["Next"] }, runConfig: { kind: "chat", input: "Next" } });
    const following = await aiConversations.createSessionStore({ conversationId: own.id, turnId: next.turn.id, leaseOwner: "next-context" }).load();
    expect(following.filter((entry) => entry.meta?.wakeupEvent)).toEqual([]);
    const context = await aiConversations.listContextMessages({ conversationId: own.id });
    expect(context.filter((entry) => entry.meta?.wakeupEvent)).toEqual([]);
    for (const entries of [following, context]) {
      expect(JSON.stringify(entries)).not.toContain("Alarm set");
      expect(JSON.stringify(entries)).not.toContain("Alarm changed");
    }
    expect((await aiConversations.listMessages({ conversationId: own.id })).filter((entry) => entry.meta?.wakeupEvent)).toHaveLength(2);
  });

  test("three recurring refusals record only the transition; an already queued occurrence skips silently", async () => {
    const own = await chat();
    const recurring = { ...note, at: "2026-11-18T12:15:00Z", cron: "*/15 * * * *" };
    await aiWakeups.create(own.shortId, recurring, subject, "en", now);
    for (const minute of [15, 30, 45]) await tickAiWakeups(async () => { throw new AiWakeupBudgetError("spent"); }, { now: new Date(`2026-11-18T12:${minute}:00Z`) });
    expect(await sql`SELECT 1 FROM ai.messages WHERE conversation_id=${own.id}::uuid AND meta#>>'{wakeupEvent,kind}'='missed'`).toHaveLength(1);
    await sql`UPDATE ai.conversations SET allowed_tools='{}'::text[] WHERE id=${own.id}::uuid`;
    await tick(new Date("2026-11-18T13:00:00Z"));
    await tick(new Date("2026-11-18T13:15:00Z"));
    expect(await sql`SELECT 1 FROM ai.messages WHERE conversation_id=${own.id}::uuid AND meta#>>'{wakeupEvent,kind}'='missed'`).toHaveLength(2);
    const queuedChat = await chat();
    await aiWakeups.create(queuedChat.shortId, recurring, subject, "en", now);
    for (const minute of [15, 30, 45]) await tick(new Date(`2026-11-18T12:${minute}:00Z`));
    expect(await sql`SELECT 1 FROM ai.queued_messages WHERE conversation_id=${queuedChat.id}::uuid AND status='pending'`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM ai.messages WHERE conversation_id=${queuedChat.id}::uuid AND meta#>>'{wakeupEvent,kind}'='missed'`).toHaveLength(0);
  });

  test("deleted alarms cannot be revived by a person or the stored alarm turn", async () => {
    const own = await chat();
    const alarm = await aiWakeups.create(own.shortId, note, subject, "en", now);
    const { turn } = await aiConversations.submitChatTurn({ conversationId: own.id, modelId: "chat",
      userMessage: { role: "user", content: ["Alarm"] }, runConfig: { kind: "chat", input: "Alarm", actor: subject.actor,
        assistantChat: true, toolSource: { kind: "default" }, turnTrigger: { kind: "wakeup", id: alarm.id } } });
    await sql`UPDATE ai.turns SET status='running' WHERE id=${turn.id}::uuid`;
    const removed = await aiWakeups.remove(own.shortId, alarm.id, alarm.revision, subject, "en", now);
    for (const authority of [subject, { ...subject, turnId: turn.id }])
      await expect(aiWakeups.update(own.shortId, alarm.id, { revision: removed.revision, at: "2026-11-18T13:00:00Z" }, authority, "en", now)).rejects.toMatchObject({ code: "not_found" });
  });

  test("notes retain session or Gustav turn provenance, including the delivery framing", async () => {
    const own = await chat();
    const person = await aiWakeups.create(own.shortId, note, subject, "en", now);
    expect(person.noteSource).toEqual({ kind: "person", userId: owner });
    const { turn } = await aiConversations.submitChatTurn({ conversationId: own.id, modelId: "chat", userMessage: { role: "user", content: ["Later"] },
      runConfig: { kind: "chat", input: "Later", actor: subject.actor, assistantChat: true, toolSource: { kind: "default" }, turnTrigger: { kind: "person", id: owner } } });
    await sql`UPDATE ai.turns SET status='running' WHERE id=${turn.id}::uuid`;
    const alarm = await aiWakeups.create(own.shortId, note, { ...subject, turnId: turn.id }, "en", now);
    expect(alarm.noteSource).toEqual({ kind: "gustav", userId: owner, turnId: turn.id });
    const shifted = await aiWakeups.update(own.shortId, alarm.id, { revision: alarm.revision, at: due.toISOString() }, subject, "en", now);
    expect(shifted.noteSource).toEqual(alarm.noteSource);
    const changed = await aiWakeups.update(own.shortId, person.id, { revision: person.revision, note: "Saved by Gustav" }, { ...subject, turnId: turn.id }, "en", now);
    expect(changed.noteSource).toEqual(alarm.noteSource);
    const prepare = spyOn(runtime, "prepareAiChatTurn");
    await tick();
    const inputs = prepare.mock.calls.map((call) => call[0]);
    expect(inputs.find((input) => input.wakeup?.id === alarm.id)?.systemPrompt).toContain("previously stored reminder");
    expect(inputs.find((input) => input.wakeup?.id === alarm.id)?.systemPrompt).toContain(turn.id);
  });

  test("unknown delivery failures back off on the minute ticks and become one actionable missed fact", async () => {
    const own = await chat();
    const alarm = await aiWakeups.create(own.shortId, { ...note, cron: "*/15 * * * *" }, subject, "en", now);
    const prepare = spyOn(runtime, "prepareAiChatTurn").mockRejectedValue(new Error("Delivery unavailable"));
    let at = due;
    for (let attempt = 1; attempt <= AI_WAKEUP_FAILURE_LIMIT; attempt++) {
      await tick(at);
      if (attempt < AI_WAKEUP_FAILURE_LIMIT) {
        await tick(new Date(+at + AI_WAKEUP_TICK_INTERVAL_MS / 2));
        expect(prepare).toHaveBeenCalledTimes(attempt);
        at = new Date(+at + 2 ** (attempt - 1) * AI_WAKEUP_TICK_INTERVAL_MS);
      }
    }
    expect((await aiWakeups.list(own.shortId, subject, "en")).items[0]).toMatchObject({ id: alarm.id, status: "missed", missedReason: "delivery" });
    expect(await sql`SELECT 1 FROM ai.messages WHERE conversation_id=${own.id}::uuid AND meta#>>'{wakeupEvent,kind}'='missed'`).toHaveLength(1);
    await tick(new Date(+at + 15 * AI_WAKEUP_TICK_INTERVAL_MS));
    expect(prepare).toHaveBeenCalledTimes(AI_WAKEUP_FAILURE_LIMIT);
  });

  test("a missed one-off releases its place after the seven-day catch-up period", async () => {
    const own = await chat();
    const alarm = await aiWakeups.create(own.shortId, note, subject, "en", now);
    await tickAiWakeups(async () => { throw new AiWakeupBudgetError("spent"); }, { now: due });
    const expiredAt = new Date(+due + AI_WAKEUP_MISSED_DAYS * 86_400_000);
    await tick(expiredAt);
    expect(await sql`SELECT status FROM ai.wakeups WHERE id=${alarm.id}::uuid`).toEqual([{ status: "expired" }]);
    expect((await aiWakeups.list(own.shortId, subject, "en")).items).toEqual([]);
    for (let i = 0; i < AI_WAKEUP_CHAT_LIMIT; i++) await aiWakeups.create(own.shortId, { ...note, at: new Date(+expiredAt + 60_000).toISOString() }, subject, "en", expiredAt);
    expect((await aiWakeups.list(own.shortId, subject, "en")).items).toHaveLength(AI_WAKEUP_CHAT_LIMIT);
  });

  test("DATA-13: empty tick is one read; alarm live delivery authorizes in memory with zero SQL", async () => {
    const meter = await meterSql();
    try {
      const empty = await meter.during(() => tick());
      expect(empty).toHaveLength(1);
      expect(empty[0]).toContain("SELECT w.id");
      const delivery = await meter.during(async () => {
        expect(
          await aiLiveChannels.user.authorize(`u:${owner}`, [
            { id: "reader", actor: subject.actor, accessSubject: subject.accessSubject, scopes: [] },
          ]),
        ).toEqual(new Set(["reader"]));
      });
      expect(delivery).toEqual([]);
    } finally {
      await meter.close();
    }
  });
});
