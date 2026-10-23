import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { LIVE_LIMITS, startLiveOutbox } from "@k2b/cloud/events/testing";
import { type AuthContext, createAccess } from "@k2b/cloud/server";
import { get as getSetting } from "@k2b/cloud/services";
import { useRegisteredTestApp } from "@k2b/cloud/services/identity/application.test-fixture";
import { publicCloudOrigin } from "@k2b/cloud/shared";
import { sql } from "bun";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { z } from "zod";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { ChatLiveEventSchema, MemberPageSchema, MessageViewSchema } from "../service/contracts";
import { chatLive } from "../service/live";
import { chatLiveChannels } from "../service/live-channels";
import chatApi from ".";
import { messageFixtures, type Person } from "./messages.test-fixture";

setDefaultTimeout(30_000);
const suite = suiteFor("database", "nats", "valkey");
const FrameSchema = z.object({
  t: z.string(),
  id: z.string().optional(),
  code: z.string().optional(),
  data: ChatLiveEventSchema.optional(),
});
type Frame = z.infer<typeof FrameSchema>;
const until = async (condition: () => boolean, timeout = 5_000) => {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Chat live condition timed out");
    await Bun.sleep(10);
  }
};

suite("Chat live delivery on two replicas", () => {
  const pods: ReturnType<typeof Bun.serve>[] = [];
  const sockets: WebSocket[] = [];
  const groups: string[] = [],
    grants: string[] = [];
  let origin = "",
    stopOutbox: (() => Promise<void>) | null = null;
  afterAll(async () => {
    for (const socket of sockets) socket.close();
    await stopOutbox?.();
    for (const pod of pods) await pod.stop(true);
    for (const id of grants) await sql`DELETE FROM auth.access WHERE id = ${id}::uuid`;
    for (const id of groups) {
      await sql`DELETE FROM auth.user_groups_v2 WHERE group_id = ${id}::uuid`;
      await sql`DELETE FROM auth.groups WHERE id = ${id}::uuid`;
    }
  });
  const f = messageFixtures();
  beforeAll(async () => {
    origin = publicCloudOrigin(await getSetting<string>("app.url"));
    // Pod A serves the production router's own live route; pod B mounts a second engine, like another replica.
    const replica = new Hono<AuthContext>().route("/api/chat/live", chatLive.routes(chatLiveChannels)).route("/api/chat", chatApi);
    for (const routes of [new Hono<AuthContext>().route("/api/chat", chatApi), replica])
      pods.push(Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: routes.fetch, websocket }));
    stopOutbox = await startLiveOutbox("chat");
  });
  const open = async (pod: number, person: Person) => {
    // DOM typings omit Bun's request headers; narrow the constructed client at runtime.
    const candidate: unknown = Reflect.construct(WebSocket, [
      `ws://127.0.0.1:${pods[pod]!.port}/api/chat/live`,
      { headers: { ...person.headers, origin, "x-forwarded-for": uniqueCallerAddress() } },
    ]);
    if (!(candidate instanceof WebSocket)) throw new Error("Missing Bun WebSocket");
    const socket = candidate;
    sockets.push(socket);
    const frames: { frame: Frame; at: number }[] = [];
    socket.onmessage = (event) => frames.push({ frame: FrameSchema.parse(JSON.parse(String(event.data))), at: Date.now() });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("Chat socket did not open"));
      }, 3_000);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        socket.close();
        reject(new Error("Chat socket failed"));
      };
    });
    return {
      socket,
      sub: (id: string, channel: string, scope: unknown) => socket.send(JSON.stringify({ t: "sub", id, channel, scope })),
      frames: (id: string) => frames.filter(({ frame }) => frame.id === id),
      events: (id: string) =>
        frames.filter(({ frame }) => frame.id === id && frame.t === "event").flatMap(({ frame }) => (frame.data ? [frame.data] : [])),
    };
  };
  const send = async (person: Person, chat: string, body: string, refs: z.infer<typeof MessageViewSchema>["refs"] = []) => {
    // The timed cache test deliberately exceeds the normal send budget.
    await f.resetSendLimits([person], chat);
    const response = await f.request(person.headers, `/${chat}/messages`, "POST", { clientId: crypto.randomUUID(), body, refs });
    expect(response.status).toBe(201);
    return MessageViewSchema.parse(await response.json());
  };
  const ready = async (socket: Awaited<ReturnType<typeof open>>, ids: string[]) =>
    until(() => ids.every((id) => socket.frames(id).some(({ frame }) => frame.t === "ready")));

  test("conversation and sidebar events reach readers across pods; strangers learn no chat", async () => {
    const ben = await f.person("Ben"),
      ana = await f.person("Ana"),
      stranger = await f.person("Stranger");
    const chat = await f.create(ben, [ana]);
    const reader = await open(0, ana),
      nonmember = await open(1, stranger);
    reader.sub("chat", "conversation", { conversation: chat.shortId });
    reader.sub("list", "list", {});
    nonmember.sub("chat", "conversation", { conversation: chat.shortId });
    nonmember.sub("list", "list", {});
    await ready(reader, ["chat", "list"]);
    await ready(nonmember, ["list"]);
    await until(() => nonmember.frames("chat").length > 0);
    expect(nonmember.frames("chat")[0]!.frame).toEqual({ t: "revoked", id: "chat", code: "not_found" });
    const refs = [{ type: "spaces.task", id: "task-shared-live" }];
    const message = await send(ben, chat.shortId, "readers only", refs);
    await until(
      () =>
        reader.events("chat").some((event) => event.type === "message" && event.message.id === message.id) &&
        reader.events("list").some((event) => event.type === "summary" && event.id === message.id),
    );
    const delivered = reader.events("chat").find((event) => event.type === "message" && event.message.id === message.id);
    expect(delivered?.type === "message" && delivered.message.refs).toEqual(refs);
    await Bun.sleep(100);
    expect(nonmember.events("chat")).toEqual([]);
    expect(nonmember.events("list").filter((event) => event.type === "summary" && event.conversationId === chat.shortId)).toEqual([]);
    reader.socket.close();
    nonmember.socket.close();
  });

  test("a removal revokes Ana on pod A immediately, hints her personal channel, and keeps Ben on pod B live", async () => {
    const ben = await f.person("Ben"),
      ana = await f.person("Ana");
    const chat = await f.create(ben, [ana]);
    const control = await f.fixture(ben, [{ person: ana, permission: "read" }]);
    const a = await open(0, ana),
      b = await open(1, ben);
    a.sub("chat", "conversation", { conversation: chat.shortId });
    a.sub("list", "list", {});
    a.sub("me", "me", {});
    b.sub("chat", "conversation", { conversation: chat.shortId });
    await ready(a, ["chat", "list", "me"]);
    await ready(b, ["chat"]);
    const members = MemberPageSchema.parse(await (await f.request(ben.headers, `/${chat.shortId}/members`)).json());
    const accessId = members.items.find((member) => member.principal.type === "user" && member.principal.userId === ana.id)!.accessId;
    const response = await fetch(`${pods[1]!.url}api/chat/conversations/${chat.shortId}/members/${accessId}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(5_000),
      headers: { ...ben.headers, "x-forwarded-for": uniqueCallerAddress() },
    });
    expect(response.status).toBe(200);
    const answered = Date.now();
    const sent = await send(ben, chat.shortId, "after removal");
    await until(() => a.frames("chat").some(({ frame }) => frame.t === "revoked"), 1_000);
    const revoked = a.frames("chat").find(({ frame }) => frame.t === "revoked")!;
    expect(revoked.frame).toEqual({ t: "revoked", id: "chat", code: "access_denied" });
    expect(revoked.at - answered).toBeLessThanOrEqual(1_000);
    await until(() => a.events("me").some((event) => event.type === "membership" && event.conversationId === chat.shortId));
    await until(
      () =>
        b.events("chat").some((event) => event.type === "message" && event.message.system?.code === "member_removed") &&
        b.events("chat").some((event) => event.type === "message" && event.message.id === sent.id),
    );
    expect(a.events("chat").filter((event) => event.type === "message" && event.message.id === sent.id)).toEqual([]);
    const after = await send(ben, control.shortId, "barrier");
    await until(() => a.events("list").some((event) => event.type === "summary" && event.id === after.id));
    expect(a.events("list").filter((event) => event.type === "summary" && event.id === sent.id)).toEqual([]);
    expect(a.frames("list").some(({ frame }) => frame.t === "resync")).toBe(true);
    a.socket.close();
    b.socket.close();
  });

  test("a directory removal without an access update revokes delivery within the default two-second cache", async () => {
    expect(LIVE_LIMITS.cacheMs).toBe(2_000);
    const ben = await f.person("Ben"),
      ana = await f.person("Ana");
    const chat = await f.fixture(ben);
    const name = `chat-live-${crypto.randomUUID()}`;
    const [group] = await sql<
      { id: string }[]
    >`INSERT INTO auth.groups (cn, provider, name) VALUES (${name}, 'local', ${name}) RETURNING id`;
    if (!group) throw new Error("Missing group");
    groups.push(group.id);
    const access = await createAccess({ principal: { type: "group", groupId: group.id }, permission: "read" });
    if (!access.ok) throw new Error(access.error.message);
    grants.push(access.data.id);
    await sql`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id) VALUES (${chat.id}::uuid, ${access.data.id}::uuid, 'discoverable', 'user', ${ben.id}::uuid)`;
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${ana.id}::uuid, ${group.id}::uuid)`;
    const a = await open(0, ana),
      b = await open(1, ben);
    a.sub("chat", "conversation", { conversation: chat.shortId });
    b.sub("chat", "conversation", { conversation: chat.shortId });
    await ready(a, ["chat"]);
    await ready(b, ["chat"]);
    const first = await send(ben, chat.shortId, "warm cache");
    await until(() => a.events("chat").some((event) => event.type === "message" && event.message.id === first.id));
    await sql`DELETE FROM auth.user_groups_v2 WHERE user_id = ${ana.id}::uuid AND group_id = ${group.id}::uuid`;
    const removedAt = Date.now();
    let sends = 0,
      expired = first;
    do {
      expired = await send(ben, chat.shortId, `directory message ${sends++}`);
      await Bun.sleep(100);
    } while (Date.parse(expired.createdAt) <= removedAt + LIVE_LIMITS.cacheMs);
    await until(() => a.frames("chat").some(({ frame }) => frame.t === "revoked"));
    const revoked = a.frames("chat").find(({ frame }) => frame.t === "revoked")!;
    expect(revoked.frame.code).toBe("access_denied");
    expect(
      a.events("chat").filter((event) => event.type === "message" && Date.parse(event.message.createdAt) > removedAt + LIVE_LIMITS.cacheMs),
    ).toEqual([]);
    expect(a.events("chat").filter((event) => event.type === "message" && event.message.id === expired.id)).toEqual([]);
    await until(() => b.events("chat").filter((event) => event.type === "message").length === sends + 1);
    expect(a.frames("chat").at(-1)?.frame).toEqual(revoked.frame);
    a.socket.close();
    b.socket.close();
  }, 15_000);
  useRegisteredTestApp("chat");
});
