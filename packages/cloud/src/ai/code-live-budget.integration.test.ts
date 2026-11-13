import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { createSync, type Sync } from "@k2b/sync";
import { meterSql, type SqlMeter } from "../../../../scripts/fixtures/sql-meter";
import { connectTestNats, suiteFor, testSyncNamespace, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAuth } from "../../../core/src/migrate/core/auth";
import { migrate as migrateEvents } from "../../../core/src/migrate/core/events";
import { migrate as migrateSettings } from "../../../core/src/migrate/core/settings";
import { bindProcessSync, unbindProcessSync } from "../_internal/process-sync";
import { liveTopic } from "../events/live-delivery";
import { createLiveEngine, type LiveViewer } from "../events/live-engine";
import { sql } from "../runtime/clients";
import { accounts } from "../services/accounts";
import { __aiExecutorTest } from "./executor";
import { aiLiveChannels } from "./live";
import { migrateCloudAi } from "./migrate";
import { aiConversations } from "./store";
import { aiStreamTopic, streamAiConversationEvents } from "./stream";

suiteFor(
  "database",
  "nats",
  "valkey",
)("Code preview SQL budget (DATA-13)", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  let connection: Awaited<ReturnType<typeof connectTestNats>>;
  let sync: Sync;
  let meter: SqlMeter;
  beforeAll(async () => {
    database = await useFreshDatabase("code_live_budget");
    // Core owns these prerequisites; the preview exercises the real AI store and NATS stream.
    for (const migrate of [migrateAuth, migrateEvents, migrateSettings]) await migrate();
    await migrateCloudAi();
    await sql`INSERT INTO auth.users(id,uid,provider,profile)
      VALUES('11111111-1111-4111-8111-111111111111'::uuid,'code-live-budget','local','user')`;
    connection = await connectTestNats();
    sync = createSync({ connection, namespace: testSyncNamespace("code-live-budget"), application: "core", defaults: { replicas: 1 } });
    bindProcessSync(sync);
    aiStreamTopic();
    liveTopic("core");
    await sync.ready();
    meter = await meterSql();
  });
  afterAll(async () => {
    setSystemTime();
    await meter?.close();
    await sync?.drain();
    unbindProcessSync();
    await connection?.drain();
    await database?.drop();
  });
  test("tool_args_delta reaches each chat reader with no SQL; a snapshot checkpoint writes once", async () => {
    const owner = "11111111-1111-4111-8111-111111111111";
    const conversation = await aiConversations.createConversation({ ownerUserId: owner });
    const { turn } = await aiConversations.submitChatTurn({
      conversationId: conversation.id,
      modelId: "fixture",
      runConfig: { kind: "chat", input: "Code", toolSource: { kind: "none" } },
      userMessage: { role: "user", content: [{ type: "text", text: "Code" }] },
    });
    await aiConversations.claimTurn({
      conversationId: conversation.id,
      turnId: turn.id,
      leaseOwner: "budget",
      leaseMs: 60_000,
      from: "queue",
      maxAttempts: 1,
      runBudgetMs: 60_000,
    });
    const pipeline = new __aiExecutorTest.StreamPipeline({
      conversationId: conversation.id,
      turnId: turn.id,
      attempt: 1,
      startSeq: 0,
      leaseOwner: "budget",
      seedBlocks: [],
      allowRememberedApprovals: false,
    });
    pipeline.setStreamArgs(new Map([["code", ["code"]]]));
    const abort = new AbortController();
    const readers = Array.from({ length: 3 }, () => streamAiConversationEvents({ conversation, signal: abort.signal }));
    const fixed = new Date("2026-11-13T00:00:00Z").getTime();
    setSystemTime(fixed);
    try {
      await pipeline.emitTurnStarted("fixture");
      await pipeline.emitBaseline();
      const admission = await meter.during(async () => {
        for (const reader of readers) expect((await reader.next()).value?.type).toBe("state");
      });
      console.log("SQL BUDGET chat setup per reader", admission.length / readers.length, admission);
      const event = (delta: string) => ({
        type: "tool_args_delta" as const,
        agentId: "cloud",
        loopId: turn.id,
        turnId: `${turn.id}:turn:0`,
        turnIndex: 0,
        callId: "code-preview",
        name: "code",
        delta,
      });
      const deltas = ['{"code":"export ', "async function ", "run() {}"];
      for (const [index, delta] of deltas.entries()) {
        setSystemTime(fixed + 250 * (index + 1));
        const statements = await meter.during(async () => {
          const pending = readers.map((reader) => reader.next());
          await pipeline.apply(event(delta));
          for (const result of await Promise.all(pending)) {
            expect(result.value).toMatchObject({ type: "block_set", block: { name: "code", liveArgs: expect.any(Object) } });
          }
        });
        expect({ perEvent: statements.length, statements }).toEqual({ perEvent: 0, statements: [] });
      }
      // Code's progress and output previews use the same block events, without per-step persistence.
      for (const progress of ["Starting", "Calling the app", "Finished"]) {
        const statements = await meter.during(async () => {
          const pending = readers.map((reader) => reader.next());
          await pipeline.reportToolProgress("code-preview", progress);
          for (const result of await Promise.all(pending)) expect(result.value).toMatchObject({ type: "block_set", block: { progress } });
        });
        expect(statements).toEqual([]);
      }
      const persisted = await meter.during(() => pipeline.persistSnapshot());
      console.log("SQL BUDGET lazy chat snapshot", persisted.length, persisted);
      expect(persisted).toHaveLength(1);
      expect(admission).toHaveLength(24);
    } finally {
      abort.abort();
      await pipeline.flush();
      await Promise.all(readers.map((reader) => reader.return(undefined)));
      setSystemTime();
    }
  });
  test("one generic decision invalidation reaches three readers over NATS with no delivery SQL, including after cache expiry", async () => {
    const user = await accounts.users.get({ id: "11111111-1111-4111-8111-111111111111" });
    if (!user) throw new Error("Missing fixture user");
    const viewer: LiveViewer = {
      id: `user:${user.id}`,
      actor: { kind: "user", user },
      accessSubject: { type: "user", userId: user.id },
      scopes: [],
    };
    const topic = liveTopic("core");
    const engine = createLiveEngine({ appId: "core", topic: () => topic, channels: aiLiveChannels });
    const cards = Array.from({ length: 3 }, () => ({
      frames: [] as Array<{ t: string; data?: unknown }>,
      ready: Promise.withResolvers<void>(),
      events: Array.from({ length: 3 }, () => Promise.withResolvers<void>()),
    }));
    const fixed = new Date("2026-11-13T00:00:00Z").getTime();
    setSystemTime(fixed);
    try {
      const setup = await meter.during(async () => {
        for (const card of cards) {
          const socket = engine.open(
            {
              send: (frame) => {
                const received: (typeof card.frames)[number] = JSON.parse(frame);
                card.frames.push(received);
                if (received.t === "ready") card.ready.resolve();
                if (received.t === "event") card.events[card.frames.filter((item) => item.t === "event").length - 1]?.resolve();
              },
              close: () => {},
              getBufferedAmount: () => 0,
            },
            viewer,
            async () => viewer,
          );
          socket.message(JSON.stringify({ t: "sub", id: "card", channel: "user", scope: {}, after: await topic.head() }));
        }
        await Promise.all(cards.map((card) => card.ready.promise));
        expect(cards.every((card) => card.frames.some((frame) => frame.t === "ready"))).toBe(true);
      });
      expect(setup).toEqual([]);
      for (let index = 0; index < 3; index++) {
        setSystemTime(fixed + index * 2_001);
        const statements = await meter.during(async () => {
          await topic.publish({
            data: {
              v: 1,
              k: `u:${user.id}`,
              d: {
                type: "ai.invalidated",
                changeId: "33333333-3333-4333-8333-333333333333",
                conversationId: null,
                projectId: null,
                domains: ["code-versions"],
                at: new Date(fixed).toISOString(),
              },
            },
          });
          await Promise.all(cards.map((card) => card.events[index]!.promise));
          expect(cards.every((card) => card.frames.filter((frame) => frame.t === "event").length === index + 1)).toBe(true);
        });
        expect(statements).toEqual([]);
        for (const { frames } of cards)
          expect(frames.at(-1)?.data).toEqual({
            type: "ai.invalidated",
            changeId: "33333333-3333-4333-8333-333333333333",
            conversationId: null,
            projectId: null,
            domains: ["code-versions"],
            at: new Date(fixed).toISOString(),
          });
      }
    } finally {
      engine.stop();
      setSystemTime();
    }
  });
});
