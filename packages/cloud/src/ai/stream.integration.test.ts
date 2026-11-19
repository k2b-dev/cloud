import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import type { Message } from "@k2b/nessi";
import { createSync, type Sync } from "@k2b/sync";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { connectTestNats, suiteFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { reviewFixture } from "../_internal/capability-review.test-fixture";
import { bindProcessSync, unbindProcessSync } from "../_internal/process-sync";
import * as registry from "../_internal/registry";
import { appAccess } from "../contracts/app-access";
import { sql } from "../runtime/clients";
import { latestTopicCursor } from "../services/topic-cursor";
import { migrateCloudAi } from "./migrate";
import type { AiStreamEvent, AiTurnBlock, AiWireEvent } from "./protocol";
import { publicAiStoredMessages } from "./public-projection";
import { createAiShortId } from "./short-id";
import { aiConversations } from "./store";
import {
  type AiLiveTopicEvent,
  aiStreamTopic,
  publishAiTurnInterrupt,
  publishAiWireEvent,
  streamAiConversationEvents,
  subscribeAiTurnInterrupts,
} from "./stream";
import type { AiConversation } from "./types";

const suite = suiteFor("database", "nats");
const leaseOwner = "stream-test";
const cleanup: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});

const userMessage = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });

const createChat = async (): Promise<AiConversation> => {
  const suffix = crypto.randomUUID();
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
    VALUES (${`ai-stream-${suffix}`}, 'local', 'user', 'AI Stream', ${`ai-stream-${suffix}@example.test`}, 'AI', 'Stream')
    RETURNING id
  `;
  const chat = await aiConversations.createConversation({ ownerUserId: user!.id });
  cleanup.push(async () => {
    await sql`DELETE FROM ai.conversations WHERE id = ${chat.id}::uuid`;
    await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
  });
  return chat;
};

/** A turn a worker has claimed, as attempt 1 that has saved nothing yet. */
const startTurn = async (chat: AiConversation, text = "Build the report") => {
  const { turn } = await aiConversations.submitChatTurn({
    conversationId: chat.id,
    modelId: "test-model",
    runConfig: { kind: "chat", input: text, toolSource: { kind: "none" } },
    userMessage: userMessage(text),
  });
  await aiConversations.claimTurn({
    conversationId: chat.id,
    turnId: turn.id,
    leaseOwner,
    leaseMs: 30_000,
    from: "queue",
    maxAttempts: 5,
    runBudgetMs: 60_000,
  });
  const event = <T extends Partial<AiWireEvent>>(seq: number, partial: T) =>
    ({ v: 1, conversationId: chat.id, turnId: turn.id, attempt: 1, seq, ...partial }) as AiWireEvent;
  /** What the worker saves as the turn's live state. */
  const save = (blocks: AiTurnBlock[], seq: number) =>
    aiConversations.saveTurnLiveState({ conversationId: chat.id, turnId: turn.id, leaseOwner, blocks, seq });
  return { turn, event, save };
};

/** Follow a conversation's stream and read its events one by one. */
const follow = (chat: AiConversation, originViewer: { locale: string; userId?: string | null } = { locale: "en" }) => {
  const abort = new AbortController();
  const events: AiStreamEvent[] = [];
  let wake: (() => void) | undefined;
  void (async () => {
    for await (const event of streamAiConversationEvents({ conversation: chat, originViewer, signal: abort.signal })) {
      events.push(event);
      wake?.();
    }
  })().catch((error) => console.error("stream failed", error));
  cleanup.push(async () => abort.abort());
  let read = 0;
  const next = async (timeoutMs = 10_000): Promise<AiStreamEvent> => {
    const deadline = Date.now() + timeoutMs;
    while (events.length <= read) {
      if (Date.now() > deadline) throw new Error(`No stream event after ${events.map((event) => event.type).join(", ")}`);
      await Promise.race([new Promise<void>((resolve) => (wake = resolve)), Bun.sleep(50)]);
    }
    return events[read++]!;
  };
  /** Nothing more arrives within `ms`. */
  const quiet = async (ms: number) => {
    await Bun.sleep(ms);
    return events.slice(read).map((event) => event.type);
  };
  return { next, quiet };
};

const text = (id: string, value: string): AiTurnBlock => ({ id, kind: "text", text: value });

const expectState = (event: AiStreamEvent) => {
  if (event.type !== "state") throw new Error(`Expected a state event, got ${event.type}`);
  return event;
};

suite("AI conversation stream repair", () => {
  let connection: Awaited<ReturnType<typeof connectTestNats>>;
  let sync: Sync;

  beforeAll(async () => {
    await migrateCloudAi();
    connection = await connectTestNats({ ignoreClusterUpdates: true });
    sync = createSync({ connection, namespace: testSyncNamespace("ai-stream"), application: "ai-stream-test", defaults: { replicas: 1 } });
    bindProcessSync(sync);
  });

  afterAll(async () => {
    if (!sync) return;
    await sync.drain();
    for (const resource of await sync.resources())
      for (const name of resource.natsNames)
        await connection.request(`$JS.API.STREAM.DELETE.${name}`, new Uint8Array(), { timeout: 5_000 });
    unbindProcessSync();
    await connection.drain();
  });

  test("all public reads combine private thinking Code and viewer-safe writer labels", async () => {
    const chat = await createChat();
    const { turn, save, event } = await startTurn(chat);
    const thinking = "INTERNAL_INSTRUCTION code_Open42 22222222-2222-4222-8222-222222222222";
    const source = "export default () => 'sync59-private-source'";
    const blocks: AiTurnBlock[] = [
      { id: "thought", kind: "thinking", text: thinking },
      { id: "tool-run", kind: "tool", callId: "run", name: "code_run", args: { code: source }, status: "running" },
    ];
    const store = aiConversations.createSessionStore({ conversationId: chat.id, turnId: turn.id, modelId: "fixture" });
    await store.append({
      role: "assistant",
      content: [
        { type: "thinking", thinking, signature: "sync59-signature", redacted: "sync59-redacted" },
        { type: "tool_call", id: "run", name: "code_run", args: { code: source } },
      ],
    });
    await store.append({
      role: "tool_result",
      callId: "check",
      name: "code_check",
      result: {
        project: { files: { "code.ts": source } },
        result: { ok: false, diagnostics: [{ code: "TS2322", message: "PRIVATE_C5_DIAGNOSTIC", file: "code.ts", line: 1 }] },
      },
    });
    const app = spyOn(registry, "getApp").mockResolvedValue({
      id: "notebooks",
      name: "Notebooks",
      description: "Notes",
      icon: "ti ti-app",
      baseUrl: "http://notebooks.test",
      routes: [],
      access: appAccess.signedIn(),
      presentation: { baseLocale: "en", translations: { de: { name: "Notizbücher" } } },
    });
    cleanup.push(async () => app.mockRestore());
    await sql`UPDATE ai.messages SET meta=${JSON.stringify({ toolPresentations: { run: { kind: "capability", appId: "notebooks", appName: "Stored name", appIcon: "ti ti-app", title: "Notiz erstellen", capabilityKind: "action" } }, toolReviews: { run: { ...reviewFixture(), locale: "de" } } })}::text::jsonb
      WHERE conversation_id=${chat.id}::uuid AND role='assistant'`;
    for (const origin of [
      { kind: "person", id: chat.createdByUserId },
      { kind: "chat", id: chat.shortId, turnId: turn.shortId },
      { kind: "automation", id: "c_private" },
    ]) {
      await sql`INSERT INTO ai.messages(short_id,conversation_id,seq,kind,role,message,search_text,loop_id,meta)
        SELECT ${createAiShortId()},${chat.id}::uuid,COALESCE(max(seq),0)+1,'message','user',
          '{"role":"user","content":[{"type":"text","text":"Attributed"}]}'::jsonb,'Attributed',${turn.id},
          ${JSON.stringify({ writerOrigin: origin })}::text::jsonb FROM ai.messages WHERE conversation_id=${chat.id}::uuid`;
    }
    await save(blocks, 1);
    const expectPublic = (value: unknown) => {
      for (const forbidden of [thinking, source, "sync59-signature", "sync59-redacted", "PRIVATE_C5_DIAGNOSTIC", "writerOrigin"])
        expect(JSON.stringify(value)).not.toContain(forbidden);
    };
    const stream = follow(chat);
    const initial = expectState(await stream.next());
    expectPublic(initial);
    const assertAuthors = (messages: typeof initial.messages) => {
      const origins = messages.flatMap((message) => (message.meta?.origin ? [message.meta.origin] : []));
      expect(origins).toContainEqual(expect.objectContaining({ kind: "person", name: "AI Stream" }));
      // An automation origin without a resource (written before #3665) and without a service account has no name any
      // reader may see: it is marked unnamed, so surfaces say "From an automation" instead of showing "Automation" as a name.
      expect(origins).toContainEqual({ kind: "automation", id: "c_private", name: "Automation", named: false });
      expect(origins.find((origin) => origin.kind === "chat")?.href).toBeUndefined();
      expect(messages.find((message) => message.message.role === "assistant")?.meta?.toolPresentations?.run?.appName).toBe("Notizbücher");
    };
    assertAuthors(initial.messages);
    const page = await aiConversations.listMessagesPage({ conversationId: chat.id });
    const paged = await publicAiStoredMessages(page.messages, chat, undefined, { locale: "en" });
    expectPublic(paged);
    assertAuthors(paged);
    const authorized = await publicAiStoredMessages(page.messages, chat, chat.createdByUserId, {
      locale: "en",
      userId: chat.createdByUserId,
    });
    const chatOrigin = authorized.flatMap((message) => (message.meta?.origin?.kind === "chat" ? [message.meta.origin] : []))[0];
    expect(chatOrigin?.href).toBe(`/app/assistant?conversation=${chat.shortId}`);
    expect(initial.activeTurn?.blocks).toMatchObject([{ kind: "thinking", text: "" }, { args: {} }]);
    const meter = await meterSql();
    const interrupted = Promise.withResolvers<void>();
    const stopControl = await subscribeAiTurnInterrupts({ conversationId: chat.id, turnId: turn.id, onInterrupt: interrupted.resolve });
    try {
      const statements = await meter.during(async () => {
        await publishAiTurnInterrupt({ conversationId: chat.id, turnId: turn.id, requestId: crypto.randomUUID() });
        await interrupted.promise;
        await publishAiWireEvent(event(2, { type: "block_delta", blockId: "thought", blockKind: "thinking", delta: thinking }));
        expect(await stream.next()).toMatchObject({ type: "block_delta", delta: "" });
      });
      expect(statements).toEqual([]);
    } finally {
      await stopControl();
      await meter.close();
    }
    // Bypass today's publisher to represent retained events from a worker before either public filter.
    const retained = async (data: AiWireEvent) => {
      await aiStreamTopic().publish({ tenantId: chat.id, orderingKey: turn.id, data });
    };
    await retained(event(3, { type: "turn_started", blocks, modelId: "fixture", providerModel: "fixture" }));
    expectPublic(await stream.next());
    const message = (await aiConversations.listTurnMessages({ conversationId: chat.id, loopId: turn.id }))[1]!;
    await retained(event(4, { type: "message_saved", message }));
    expectPublic(await stream.next());
    const attributed = page.messages.find((message) => message.meta?.writerOrigin?.kind === "automation")!;
    await retained(event(5, { type: "message_saved", message: attributed }));
    const saved = await stream.next();
    expectPublic(saved);
    expect(saved).toMatchObject({ type: "message_saved", message: { meta: { origin: { name: "Automation" } } } });
    // A sequence hole holds the event back until the stored snapshot covers it.
    await save(blocks, 7);
    await retained(event(7, { type: "block_set", block: blocks[0]! }));
    const held = expectState(await stream.next());
    expectPublic(held);
    assertAuthors(held.messages);
    const reconnect = expectState(await follow(chat).next());
    expectPublic(reconnect);
    assertAuthors(reconnect.messages);
    await retained(event(8, { type: "turn_finished", status: "completed", error: null, messages: page.messages }));
    const finished = await stream.next();
    expect(finished.type).toBe("turn_finished");
    expectPublic(finished);
    if (finished.type === "turn_finished") assertAuthors(finished.messages ?? []);
    const canonical = JSON.stringify(await store.load());
    for (const original of [thinking, source, "sync59-signature", "sync59-redacted"]) expect(canonical).toContain(original);
  });

  test("Code source stays out of the initial snapshot, live step and resumed baseline", async () => {
    const chat = await createChat();
    const { save, event } = await startTurn(chat);
    const source = "export default async () => cloud.spaces.task.create({ title: 'Delivery' })";
    const block: AiTurnBlock = { id: "tool-run", kind: "tool", callId: "run", name: "code_run", args: { code: source }, status: "running" };
    await save([block], 1);
    const stream = follow(chat);
    const initial = expectState(await stream.next());
    expect(initial.activeTurn?.blocks[0]).toMatchObject({ args: {} });
    expect(JSON.stringify(initial)).not.toContain(source);
    await publishAiWireEvent(event(2, { type: "block_set", block }));
    expect(JSON.stringify(await stream.next())).not.toContain(source);
    await publishAiWireEvent(event(3, { type: "turn_started", blocks: [block], modelId: "fixture", providerModel: "fixture" }));
    expect(JSON.stringify(await stream.next())).not.toContain(source);
  });

  test("lasting Code source and raw diagnostics stay out of SSE history, live results and resumed baselines", async () => {
    const chat = await createChat();
    const { turn, save, event } = await startTurn(chat);
    const source = "export default () => 'sse-source-fixture'";
    const literal = "sse-diagnostic-source-fixture";
    const diagnostic = {
      code: "TS2322",
      message: `Type '"${literal}"' is not assignable to type '"allowed"'.`,
      file: "code.ts",
      line: 1,
      column: 7,
    };
    const words = {
      notices: [{ severity: "block", text: "The draft needs a correction.", consequence: "This version cannot be submitted." }],
      mayDo: [],
    };
    const blocks: AiTurnBlock[] = [
      {
        id: "tool-write",
        kind: "tool",
        callId: "write",
        name: "code_write",
        args: { path: "code.ts", content: source },
        status: "completed",
      },
      ...["code_read", "code_pull"].map(
        (name): AiTurnBlock => ({
          id: `tool-${name}`,
          kind: "tool",
          callId: name,
          name,
          args: { codeId: "ABCDEF" },
          status: "completed",
          result: { version: 1, files: { "code.ts": source } },
        }),
      ),
      ...["code_check", "code_test", "code_simulate"].map((name): AiTurnBlock => {
        const checked = { ok: false, diagnostics: [diagnostic], warnings: [diagnostic] };
        return {
          id: `tool-${name}`,
          kind: "tool",
          callId: name,
          name,
          args: { codeId: "ABCDEF" },
          status: "completed",
          result: name === "code_check" ? { version: 1, result: checked, words } : { version: 1, ...checked, words },
        };
      }),
    ];
    const store = aiConversations.createSessionStore({ conversationId: chat.id, turnId: turn.id, modelId: "fixture" });
    await store.append({
      role: "assistant",
      content: [
        { type: "tool_call", id: "write", name: "code_write", args: { path: "code.ts", content: source } },
        ...["code_read", "code_pull", "code_check", "code_test", "code_simulate"].map((name) => ({
          type: "tool_call" as const,
          id: name,
          name,
          args: { codeId: "ABCDEF" },
        })),
      ],
    });
    for (const block of blocks) {
      if (block.kind === "tool" && block.result !== undefined)
        await store.append({ role: "tool_result", callId: block.callId, name: block.name, result: block.result });
    }
    await save(blocks, 1);
    const stream = follow(chat);
    const expectPublic = (value: unknown) => {
      const serialized = JSON.stringify(value);
      expect(serialized).not.toContain(source);
      expect(serialized).not.toContain(literal);
    };
    const initial = expectState(await stream.next());
    expectPublic(initial);
    expect(initial.activeTurn?.blocks.find((block) => block.kind === "tool" && block.name === "code_check")).toMatchObject({
      result: { result: { diagnostics: [{ code: "TS2322", file: "code.ts", line: 1, column: 7 }], warnings: [{ code: "TS2322" }] }, words },
    });
    for (const [index, block] of blocks.entries()) {
      await publishAiWireEvent(event(index + 2, { type: "block_set", block }));
      expectPublic(await stream.next());
    }
    await publishAiWireEvent(event(blocks.length + 2, { type: "turn_started", blocks, modelId: "fixture", providerModel: "fixture" }));
    expectPublic(await stream.next());
    const message = (await aiConversations.listTurnMessages({ conversationId: chat.id, loopId: turn.id })).find(
      (message) => message.message.role === "tool_result" && message.message.name === "code_check",
    );
    if (!message) throw new Error("Expected a canonical message");
    await publishAiWireEvent(event(blocks.length + 3, { type: "message_saved", message }));
    expectPublic(await stream.next());
    const canonical = JSON.stringify(await store.load());
    expect(canonical).toContain(source);
    expect(canonical).toContain(literal);
  });

  test("ordinary live deltas and worker interruption delivery execute zero SQL statements (DATA-13)", async () => {
    const chat = await createChat();
    const { turn, event } = await startTurn(chat);
    const stream = follow(chat);
    expectState(await stream.next());
    const delivered = Promise.withResolvers<void>();
    const stop = await subscribeAiTurnInterrupts({ conversationId: chat.id, turnId: turn.id, onInterrupt: delivered.resolve });
    const meter = await meterSql();
    try {
      const statements = await meter.during(async () => {
        await publishAiTurnInterrupt({ conversationId: chat.id, turnId: turn.id, requestId: crypto.randomUUID() });
        await delivered.promise;
        for (let seq = 1; seq <= 3; seq++) {
          await publishAiWireEvent(event(seq, { type: "block_delta", blockId: "text", blockKind: "text", delta: "x" }));
          expect(await stream.next()).toMatchObject({ type: "block_delta", seq });
        }
      });
      expect(statements).toEqual([]);
    } finally {
      await stop();
      await meter.close();
    }
  });

  test("a lost live event: the stream sends the saved state once it holds the next event, then continues without a hole", async () => {
    const chat = await createChat();
    const { turn, event, save } = await startTurn(chat);
    const stream = follow(chat);
    expect(expectState(await stream.next()).activeTurn).toMatchObject({ seq: 0, blocks: [] });

    await publishAiWireEvent(event(1, { type: "block_set", block: text("t1", "Reading") }));
    expect(await stream.next()).toMatchObject({ type: "block_set", seq: 1 });

    // Event 2 never reaches the topic; the worker saves it with event 3 a moment later.
    const tool: AiTurnBlock = { id: "tool-c1", kind: "tool", callId: "c1", name: "read_file", args: { path: "/a.csv" }, status: "running" };
    await publishAiWireEvent(event(3, { type: "block_set", block: tool }));
    await Bun.sleep(1_200);
    await save([text("t1", "Reading the file."), tool], 3);

    const repaired = expectState(await stream.next());
    expect(repaired.activeTurn).toMatchObject({ turnId: turn.shortId, seq: 3, blocks: [text("t1", "Reading the file."), tool] });
    // Event 3 is part of the saved state; the stream continues after it.
    await publishAiWireEvent(event(4, { type: "block_delta", blockId: "t2", blockKind: "text", delta: "Found it." }));
    expect(await stream.next()).toMatchObject({ type: "block_delta", seq: 4, turnId: turn.shortId });
  }, 20_000);

  test("an event too large for the live topic arrives in full through the saved state", async () => {
    const chat = await createChat();
    const { turn, event, save } = await startTurn(chat);
    const stream = follow(chat);
    expectState(await stream.next());

    const page = "x".repeat(400 * 1024);
    const tool: AiTurnBlock = {
      id: "tool-web",
      kind: "tool",
      callId: "web",
      name: "web_extract",
      args: { url: "https://example.test" },
      status: "completed",
      result: page,
    };
    await save([tool], 1);
    const cursor = await latestTopicCursor({ topic: aiStreamTopic(), resourceId: "cloud-ai-stream", tenantId: chat.id });
    await publishAiWireEvent(event(1, { type: "block_set", block: tool }));

    const state = expectState(await stream.next());
    expect(state.activeTurn?.seq).toBe(1);
    expect((state.activeTurn?.blocks[0] as Extract<AiTurnBlock, { kind: "tool" }>).result).toBe(page);

    // The topic carries only the position of the event, never its payload.
    const abort = new AbortController();
    const raw: AiLiveTopicEvent[] = [];
    for await (const received of aiStreamTopic().hub({ tenantId: chat.id }).subscribe({ after: cursor, signal: abort.signal })) {
      raw.push(received.data);
      break;
    }
    abort.abort();
    expect(raw).toEqual([{ v: 1, conversationId: chat.id, turnId: turn.id, attempt: 1, seq: 1, type: "oversized", replaces: "block_set" }]);
  }, 20_000);

  test("a turn end numbered from a saved state that lags the live events still ends the turn, once", async () => {
    const chat = await createChat();
    const { turn, event } = await startTurn(chat);
    const stream = follow(chat);
    expectState(await stream.next());
    for (const seq of [1, 2, 3]) {
      await publishAiWireEvent(event(seq, { type: "block_delta", blockId: "t1", blockKind: "text", delta: `${seq}` }));
      expect(await stream.next()).toMatchObject({ seq });
    }

    // A stop or the sweep numbers the end after the saved state, which still stands at 1.
    await publishAiWireEvent(event(2, { type: "turn_finished", status: "aborted", error: null }));
    expect(await stream.next()).toMatchObject({ type: "turn_finished", status: "aborted", turnId: turn.shortId });
    await publishAiWireEvent(event(4, { type: "turn_finished", status: "aborted", error: null }));
    expect(await stream.quiet(500)).toEqual([]);
  }, 20_000);

  test("a turn whose start went missing appears through the saved state", async () => {
    const chat = await createChat();
    const stream = follow(chat);
    expect(expectState(await stream.next()).activeTurn).toBeNull();

    const { turn, event, save } = await startTurn(chat);
    await save([text("t1", "Starting.")], 2);
    await publishAiWireEvent(event(2, { type: "block_delta", blockId: "t1", blockKind: "text", delta: "." }));

    const state = expectState(await stream.next());
    expect(state.activeTurn).toMatchObject({ turnId: turn.shortId, seq: 2, blocks: [text("t1", "Starting.")] });
    await publishAiWireEvent(event(3, { type: "block_delta", blockId: "t1", blockKind: "text", delta: " Done." }));
    expect(await stream.next()).toMatchObject({ type: "block_delta", seq: 3, turnId: turn.shortId });
  }, 20_000);

  test("the start of a new turn brings the end of the previous turn when that went missing", async () => {
    const chat = await createChat();
    const first = await startTurn(chat, "First");
    const stream = follow(chat);
    expect(expectState(await stream.next()).activeTurn?.turnId).toBe(first.turn.shortId);

    // The first turn ends without its turn_finished reaching the topic.
    await aiConversations.completeTurn({ conversationId: chat.id, turnId: first.turn.id, leaseOwner, status: "completed", error: null });
    const second = await startTurn(chat, "Second");
    await second.save([], 1);
    await publishAiWireEvent(second.event(1, { type: "turn_started", modelId: "test-model", providerModel: "", blocks: [] }));

    const state = expectState(await stream.next());
    expect(state.activeTurn?.turnId).toBe(second.turn.shortId);
    expect(state.messages.some((message) => message.loopId === first.turn.shortId)).toBe(true);
  }, 20_000);

  test("a repaired state carries the conversation as it is now, not as it was when the stream opened", async () => {
    const chat = await createChat();
    const earlier = await startTurn(chat, "Earlier");
    await aiConversations.completeTurn({
      conversationId: chat.id,
      turnId: earlier.turn.id,
      leaseOwner,
      status: "failed",
      error: "old failure",
    });
    const opened = (await aiConversations.getConversation({ conversationId: chat.id }))!;
    expect(opened).toMatchObject({ runStatus: "failed", runError: "old failure" });
    const stream = follow(opened);
    expectState(await stream.next());

    // A new turn runs and the draft moves on in another session.
    const { turn, event, save } = await startTurn(chat, "Again");
    await save([], 1);
    await publishAiWireEvent(event(1, { type: "turn_started", modelId: "test-model", providerModel: "", blocks: [] }));
    expect(await stream.next()).toMatchObject({ type: "turn_started", turnId: turn.shortId });
    const draft = await aiConversations.saveDraft({
      conversationId: chat.id,
      ownerUserId: chat.createdByUserId!,
      expectedRevision: (await aiConversations.getConversation({ conversationId: chat.id }))!.draft.revision,
      content: [{ type: "text", text: "Next question" }],
    });
    if (!draft.ok) throw new Error(`draft not saved: ${draft.reason}`);

    // Event 2 goes missing.
    await save([text("t1", "Hello")], 3);
    await publishAiWireEvent(event(3, { type: "block_delta", blockId: "t1", blockKind: "text", delta: "o" }));
    const repaired = expectState(await stream.next());
    expect(repaired.activeTurn?.turnId).toBe(turn.shortId);
    expect(repaired.conversation).toMatchObject({ id: chat.shortId, runStatus: "running", runError: null });
    expect(repaired.conversation.draft.revision).toBe(draft.draft.revision);
  }, 20_000);

  test("a turn that fails while the stream waits for its saved state still ends for readers", async () => {
    const chat = await createChat();
    const { turn, event } = await startTurn(chat);
    const stream = follow(chat);
    expectState(await stream.next());

    // A large tool result goes out as a marker, and the turn fails before its saved state holds it.
    const tool: AiTurnBlock = {
      id: "tool-web",
      kind: "tool",
      callId: "web",
      name: "web_extract",
      args: {},
      status: "completed",
      result: "x".repeat(400 * 1024),
    };
    await publishAiWireEvent(event(1, { type: "block_set", block: tool }));
    await Bun.sleep(300);
    await aiConversations.completeTurn({ conversationId: chat.id, turnId: turn.id, leaseOwner, status: "failed", error: "boom" });
    await publishAiWireEvent(event(2, { type: "turn_finished", status: "failed", error: "boom" }));

    const state = expectState(await stream.next());
    expect(state.activeTurn).toBeNull();
    // The failed turn goes out under its public ID, as its messages' loopId.
    expect(state.conversation).toMatchObject({ runStatus: "failed", runError: "boom", runTurnId: turn.shortId });
    expect(await stream.next()).toMatchObject({ type: "turn_finished", turnId: turn.shortId, status: "failed", error: "boom" });
    expect(await stream.quiet(500)).toEqual([]);
  }, 20_000);

  test("a turn that ended before the stream reloaded it is not replayed, but its end goes out", async () => {
    const chat = await createChat();
    const first = await startTurn(chat, "First");
    const stream = follow(chat);
    expect(expectState(await stream.next()).activeTurn?.turnId).toBe(first.turn.shortId);

    // The first turn's end goes missing, and the next turn runs and ends before the stream sees its start.
    await aiConversations.completeTurn({ conversationId: chat.id, turnId: first.turn.id, leaseOwner, status: "completed", error: null });
    const second = await startTurn(chat, "Second");
    await aiConversations.completeTurn({ conversationId: chat.id, turnId: second.turn.id, leaseOwner, status: "completed", error: null });
    await publishAiWireEvent(second.event(1, { type: "turn_started", modelId: "test-model", providerModel: "", blocks: [] }));
    await publishAiWireEvent(second.event(2, { type: "block_set", block: text("t1", "Done.") }));
    await publishAiWireEvent(second.event(3, { type: "turn_finished", status: "completed", error: null }));

    const state = expectState(await stream.next());
    expect(state.activeTurn).toBeNull();
    expect(state.messages.some((message) => message.loopId === second.turn.shortId)).toBe(true);
    expect(await stream.next()).toMatchObject({ type: "turn_finished", turnId: second.turn.shortId, status: "completed" });
    expect(await stream.quiet(500)).toEqual([]);
  }, 20_000);
});
