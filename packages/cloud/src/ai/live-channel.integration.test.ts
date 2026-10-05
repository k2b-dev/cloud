import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { startLiveOutbox } from "../events/live";
import { LIVE_LIMITS } from "../events/live-engine";
import { session } from "../services/session";
import { createTestSession } from "../services/session/session.test-fixture";
import * as settings from "../services/settings";
import { publicCloudOrigin } from "../shared/app-url";
import { aiLive, aiLiveChannels } from "./live";
import { AiInvalidationSchema } from "./live-events";
import { aiConversations } from "./store";

// Core's AI channel over the real socket, outbox, topic, and sessions. The
// AI's triggers write the updates; two mounts stand for two Core replicas.
const suite = suiteFor("database", "nats", "valkey");
const pods = Array.from({ length: 2 }, () => ({
  routes: aiLive.routes(aiLiveChannels),
  server: null as ReturnType<typeof Bun.serve> | null,
}));
const url = (pod: number) => `ws://127.0.0.1:${pods[pod]?.server?.port}/api/ai/live`;

let origin = "";
let stopOutbox: (() => Promise<void>) | null = null;
const users: string[] = [];

const person = async (name: string) => {
  const id = crypto.randomUUID();
  await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name) VALUES (${id}::uuid, ${`ai-live-${id}`}, 'local', 'user', ${name})`;
  users.push(id);
  const token = await createTestSession(id);
  return { id, headers: { cookie: `session_token=${token}`, origin, "x-forwarded-for": uniqueCallerAddress() } };
};
type Person = Awaited<ReturnType<typeof person>>;

/** Bun's client accepts headers; the DOM typing of `WebSocket` does not know them. */
const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;

type Frame = { t: string; id?: string; cursor?: string; data?: unknown; code?: string };
const open = async (pod: number, who: Person) => {
  const socket = new BunWebSocket(url(pod), { headers: who.headers });
  const frames: Frame[] = [];
  received.push(frames);
  const state = { closed: null as { code: number; reason: string } | null };
  socket.onmessage = (message) => frames.push(JSON.parse(String(message.data)) as Frame);
  socket.onclose = (close) => {
    state.closed = { code: close.code, reason: close.reason };
  };
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("The live socket did not open"));
  });
  return {
    socket,
    state,
    sub: (id: string, scope: unknown = {}, after?: string) => socket.send(JSON.stringify({ t: "sub", id, channel: "user", scope, after })),
    of: (id: string) => frames.filter((frame) => frame.id === id),
    events: (id: string) =>
      frames.filter((frame) => frame.id === id && frame.t === "event").map((frame) => AiInvalidationSchema.parse(frame.data)),
  };
};

/** Every frame each socket received, for a failure message. */
const received: Frame[][] = [];

const until = async (condition: () => boolean, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Condition not reached in time; frames: ${JSON.stringify(received)}`);
    await Bun.sleep(20);
  }
};

/** A change of the user's AI data, written by the AI's triggers. */
const newChat = async (who: Person) => {
  const chat = await aiConversations.createConversation({ ownerUserId: who.id });
  aiLive.wake();
  return chat.shortId;
};

suite("AI live channel", () => {
  beforeAll(async () => {
    LIVE_LIMITS.progressMs = 300;
    origin = publicCloudOrigin(await settings.get<string>("app.url"));
    for (const pod of pods) {
      pod.server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: new Hono().route("/api/ai/live", pod.routes).fetch, websocket });
    }
    // Earlier test files write AI data without a Core that publishes its updates. This dispatcher
    // stands for Core and would publish all of them before the updates of this file.
    await sql`DELETE FROM events.outbox WHERE kind = 'live' AND app_id = 'core'`;
    stopOutbox = await startLiveOutbox("core");
  });

  afterAll(async () => {
    await stopOutbox?.();
    for (const pod of pods) await pod.server?.stop(true);
    if (users.length > 0) await sql`DELETE FROM auth.users WHERE id IN ${sql(users)}`;
  });

  test("a user receives the updates of their own AI data and never another user's", async () => {
    const ada = await person("Ada Example");
    const ben = await person("Ben Example");
    const adaSocket = await open(0, ada);
    const benSocket = await open(1, ben);
    adaSocket.sub("s");
    benSocket.sub("s");
    await until(() => adaSocket.of("s").length === 1 && benSocket.of("s").length === 1);
    expect(adaSocket.of("s")[0]?.t).toBe("ready");

    const adaChat = await newChat(ada);
    const benChat = await newChat(ben);
    await until(() => adaSocket.events("s").length >= 1 && benSocket.events("s").length >= 1);
    await Bun.sleep(500);
    expect(adaSocket.events("s").map((event) => event.conversationId)).toEqual([adaChat]);
    expect(benSocket.events("s").map((event) => event.conversationId)).toEqual([benChat]);
    expect(adaSocket.events("s")[0]?.domains).toEqual(["conversation-detail", "conversation-list"]);

    // The channel has no scope to name a user: asking for another user's updates ends the socket.
    adaSocket.sub("other", { userId: ben.id });
    await until(() => adaSocket.state.closed !== null);
    expect(adaSocket.state.closed).toEqual({ code: 1008, reason: "invalid_scope" });
    benSocket.socket.close();
  });

  test("an ended session closes the socket with 1008 within one sweep", async () => {
    const cleo = await person("Cleo Example");
    const socket = await open(0, cleo);
    socket.sub("s");
    await until(() => socket.of("s").length === 1);
    const endedAt = Date.now();
    await session.revokeAllForUser(cleo.id);
    await until(() => socket.state.closed !== null, LIVE_LIMITS.sweepMs + 2_000);
    expect(Date.now() - endedAt).toBeLessThanOrEqual(LIVE_LIMITS.sweepMs + 1_000);
    expect(socket.state.closed).toEqual({ code: 1008, reason: "session_expired" });
  });

  test("a reconnect inside the ring replays what was missed; a cursor before it resyncs", async () => {
    const dana = await person("Dana Example");
    const first = await open(0, dana);
    first.sub("s");
    await until(() => first.of("s").length === 1);
    await newChat(dana);
    await until(() => first.events("s").length === 1);
    const applied = first.of("s").at(-1)?.cursor as string;
    first.socket.close();
    const missed = await newChat(dana);

    // The other replica follows the same topic and replays from its ring.
    await Bun.sleep(500);
    const second = await open(1, dana);
    second.sub("s", {}, applied);
    await until(() => second.of("s").some((frame) => frame.t === "ready"));
    expect(second.events("s").map((event) => event.conversationId)).toEqual([missed]);

    const ringEvents = LIVE_LIMITS.ringEvents;
    LIVE_LIMITS.ringEvents = 1;
    try {
      const other = await person("Eli Example");
      await newChat(other);
      await newChat(other);
      await Bun.sleep(500);
      second.sub("old", {}, applied);
      await until(() => second.of("old").length === 1);
      expect(second.of("old")[0]?.t).toBe("resync");
    } finally {
      LIVE_LIMITS.ringEvents = ringEvents;
    }
    second.socket.close();
  });
});
