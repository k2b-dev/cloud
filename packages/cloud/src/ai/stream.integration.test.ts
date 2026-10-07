import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@k2b/nessi";
import { createSync, type Sync } from "@k2b/sync";
import { sql } from "bun";
import { connectTestNats, suiteFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { bindProcessSync, unbindProcessSync } from "../_internal/process-sync";
import { latestTopicCursor } from "../services/topic-cursor";
import { migrateCloudAi } from "./migrate";
import type { AiStreamEvent, AiTurnBlock, AiWireEvent } from "./protocol";
import { aiConversations } from "./store";
import { type AiLiveTopicEvent, aiStreamTopic, publishAiWireEvent, streamAiConversationEvents } from "./stream";
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
    modelProfileId: "test-model",
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
const follow = (chat: AiConversation) => {
  const abort = new AbortController();
  const events: AiStreamEvent[] = [];
  let wake: (() => void) | undefined;
  void (async () => {
    for await (const event of streamAiConversationEvents({ conversation: chat, signal: abort.signal })) {
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
    await publishAiWireEvent(second.event(1, { type: "turn_started", modelProfileId: "test-model", providerModel: "", blocks: [] }));

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
    await publishAiWireEvent(event(1, { type: "turn_started", modelProfileId: "test-model", providerModel: "", blocks: [] }));
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
    await publishAiWireEvent(second.event(1, { type: "turn_started", modelProfileId: "test-model", providerModel: "", blocks: [] }));
    await publishAiWireEvent(second.event(2, { type: "block_set", block: text("t1", "Done.") }));
    await publishAiWireEvent(second.event(3, { type: "turn_finished", status: "completed", error: null }));

    const state = expectState(await stream.next());
    expect(state.activeTurn).toBeNull();
    expect(state.messages.some((message) => message.loopId === second.turn.shortId)).toBe(true);
    expect(await stream.next()).toMatchObject({ type: "turn_finished", turnId: second.turn.shortId, status: "completed" });
    expect(await stream.quiet(500)).toEqual([]);
  }, 20_000);
});
