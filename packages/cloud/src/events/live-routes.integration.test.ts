import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { SignJWT } from "jose";
import { z } from "zod";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { sql } from "../runtime/clients";
import { sessionOriginGuard } from "../server/middleware/session-origin";
import { useRegisteredTestApp } from "../services/identity/application.test-fixture";
import "../../../../scripts/fixtures/authorization-preload";
import { prepareIdentitySigner } from "../services/identity/key-ring";
import { getIdentityRuntimeConfig } from "../services/identity/runtime-config";
import { session } from "../services/session";
import { createTestSession } from "../services/session/session.test-fixture";
import * as settings from "../services/settings";
import { publicCloudOrigin } from "../shared/app-url";
import { wakeAppAccessChanged } from "./app-access";
import { defineLive, startLiveOutbox } from "./live";
import { liveTopic, startLiveDelivery } from "./live-delivery";
import { LIVE_LIMITS, type LiveChannel, type LiveViewer } from "./live-engine";

// Two replicas of one application ("pods") in this process, each with its own
// follower, ring, and socket server, over the real outbox, topic, sessions, and
// OAuth verification. Domain access changes publish through the owning live topic.
const suite = suiteFor("database", "nats", "valkey");
const APP = "livetest";
const readers = new Map<string, Set<string>>();
const failing = new Set<string>();
const serverCloses: { code: number; reason: string }[] = [];
const recordedWebsocket = {
  ...websocket,
  close(ws: Parameters<typeof websocket.close>[0], code: number, reason: string) {
    serverCloses.push({ code, reason });
    websocket.close(ws, code, reason);
  },
};

/** Access here belongs to the person, whatever credential the socket uses. */
const principal = ({ accessSubject }: LiveViewer) =>
  accessSubject.type === "user" ? `user:${accessSubject.userId}` : `service_account:${accessSubject.serviceAccountId}`;
const capturedViewers: LiveViewer[] = [];
const authorize = async (key: string, viewers: readonly LiveViewer[]) => {
  if (key === "viewer-contract") capturedViewers.push(...viewers);
  if (failing.has(key)) throw new Error("reader unavailable");
  return new Set(
    viewers
      .filter((viewer) =>
        key.startsWith("group:")
          ? viewer.actor.kind === "user" && viewer.actor.user.memberofGroupIds.includes(key.slice(6))
          : readers.get(key)?.has(principal(viewer)),
      )
      .map((viewer) => viewer.id),
  );
};
const channels = {
  item: { eventOnly: true, scope: z.object({ key: z.string() }).strict(), keys: async ({ key }: { key: string }) => [key], authorize },
  list: {
    eventOnly: true,
    scope: z.object({}).strict(),
    collection: true,
    keys: async (_scope: unknown, viewer: LiveViewer) => [...readers].filter(([, ids]) => ids.has(principal(viewer))).map(([key]) => key),
    authorize,
  },
} satisfies Record<string, LiveChannel>;

const live = defineLive({ appId: APP, event: z.object({ n: z.number().int(), pad: z.string().optional() }) });
// Each mount serves its own sockets with its own follower and ring, like a replica.
const pods = Array.from({ length: 2 }, () => ({ routes: live.routes(channels), server: null as ReturnType<typeof Bun.serve> | null }));
const url = (pod: number) => `ws://127.0.0.1:${pods[pod]?.server?.port}/live`;

let origin = "";
let stopCore: (() => Promise<void>) | null = null;
let stopOutbox: (() => Promise<void>) | null = null;
const users: string[] = [];

const person = async (name: string) => {
  const id = crypto.randomUUID();
  await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name) VALUES (${id}::uuid, ${`live-${id}`}, 'local', 'user', ${name})`;
  users.push(id);
  const token = await createTestSession(id);
  return { id, viewer: `user:${id}`, headers: { cookie: `session_token=${token}`, origin, "x-forwarded-for": uniqueCallerAddress() } };
};
type Person = Awaited<ReturnType<typeof person>>;

/** Bun's client accepts headers; the DOM typing of `WebSocket` does not know them. */
const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;

type Frame = { t: string; id?: string; cursor?: string; data?: { n: number }; code?: string };
const open = async (pod: number, headers: Record<string, string>) => {
  const socket = new BunWebSocket(url(pod), { headers });
  const frames: Frame[] = [];
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
    sub: (id: string, channel: string, scope: unknown, after?: string) =>
      socket.send(JSON.stringify({ t: "sub", id, channel, scope, after })),
    of: (id: string) => frames.filter((frame) => frame.id === id),
    progress: () => frames.filter((frame) => frame.t === "progress"),
  };
};

const until = async (condition: () => boolean, timeoutMs = 5_000, message: string | (() => string) = "Condition not reached in time") => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(typeof message === "function" ? message() : message);
    await Bun.sleep(20);
  }
};

const publish = async (key: string, n: number, options: { access?: true; pad?: string } = {}) => {
  await sql.begin((tx) => live.publish(tx, { key, data: { n, ...(options.pad ? { pad: options.pad } : {}) }, ...options }));
  live.wake();
};

const allow = (key: string, ...people: Person[]) => readers.set(key, new Set(people.map((who) => who.viewer)));

suite("live routes", () => {
  beforeAll(async () => {
    // Shorter progress for the cursor test.
    LIVE_LIMITS.progressMs = 300;
    origin = publicCloudOrigin(await settings.get<string>("app.url"));
    for (const pod of pods) {
      pod.server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: new Hono().use(sessionOriginGuard()).route("/live", pod.routes).fetch,
        websocket: recordedWebsocket,
      });
    }
    stopOutbox = await startLiveOutbox(APP);
    stopCore = await startLiveDelivery("core");
  });

  // Inside the suite, so Bun runs it before the authorization preload's file-level
  // teardown stops Sync: engines and the outbox stop while Sync still runs, as in `app.start()`.
  afterAll(async () => {
    await stopOutbox?.();
    await stopCore?.();
    for (const pod of pods) await pod.server?.stop(true);
    if (users.length > 0) await sql`DELETE FROM auth.users WHERE id IN ${sql(users)}`;
  });

  for (const holdPublication of [false, true]) {
    test(`a reconnect to the other replica replays from its ring; old, foreign, and future cursors resync (held publication: ${holdPublication})`, async () => {
      const topic = liveTopic(APP);
      const originalPublish = topic.publish.bind(topic);
      const published = new Map<number, string>();
      let releasePublication = () => {};
      const publicationAllowed = new Promise<void>((resolve) => {
        releasePublication = resolve;
      });
      const publishing = spyOn(topic, "publish").mockImplementation(async (input) => {
        const parsed = z.object({ n: z.number() }).safeParse(input.data.d);
        const n = parsed.success ? parsed.data.n : undefined;
        if (holdPublication && input.data.k === "ring" && n === 3) await publicationAllowed;
        const receipt = await originalPublish(input);
        if (n !== undefined) published.set(n, receipt.cursor);
        return receipt;
      });
      const sockets: Awaited<ReturnType<typeof open>>[] = [];
      const ringEvents = LIVE_LIMITS.ringEvents;
      try {
        const ada = await person("Ada Example");
        allow("ring", ada);
        const first = await open(0, ada.headers);
        sockets.push(first);
        first.sub("s", "item", { key: "ring" });
        await until(() => first.of("s").length === 1);
        await publish("ring", 1);
        await publish("ring", 2);
        await until(() => first.of("s").length === 3);
        const applied = first.of("s")[2]!.cursor!;
        first.socket.close();
        await publish("ring", 3);

        const second = await open(1, ada.headers);
        sockets.push(second);
        if (holdPublication) {
          // The replica starts and reports its old head while event 3 still waits before NATS.
          await until(() => second.progress().some((frame) => frame.cursor === applied));
        }
        releasePublication();
        // An outbox commit does not mean publication, nor does publication mean applied.
        // A progress frame proves this replica has applied event 3 to its ring.
        await until(
          () => published.has(3) && second.progress().some((frame) => frame.cursor === published.get(3)),
          5_000,
          () =>
            `Replica did not apply event 3: ${JSON.stringify({ published: published.get(3), progress: second.progress(), closed: second.state.closed })}`,
        );
        second.sub("s", "item", { key: "ring" }, applied);
        await until(
          () => second.of("s").at(-1)?.t === "ready",
          5_000,
          () => `Replay did not become ready: ${JSON.stringify({ frames: second.of("s"), closed: second.state.closed })}`,
        );
        expect(second.of("s").map((frame) => [frame.t, frame.data?.n])).toEqual([
          ["event", 3],
          ["ready", undefined],
        ]);

        const head = second.of("s")[1]!.cursor!;
        const prefix = head.slice(0, head.lastIndexOf("."));
        second.sub("foreign", "item", { key: "ring" }, "s6t.elsewhere.1");
        second.sub("future", "item", { key: "ring" }, `${prefix}.999999`);
        LIVE_LIMITS.ringEvents = 2;
        for (let n = 4; n <= 6; n++) await publish("ring-other", n);
        await until(
          () => published.has(6) && second.progress().some((frame) => frame.cursor === published.get(6)),
          5_000,
          () =>
            `Replica did not apply event 6: ${JSON.stringify({ published: published.get(6), progress: second.progress(), closed: second.state.closed })}`,
        );
        second.sub("old", "item", { key: "ring" }, applied);
        await until(() => ["foreign", "future", "old"].every((id) => second.of(id).length > 0));
        for (const id of ["foreign", "future", "old"]) expect(second.of(id).map((frame) => frame.t)).toEqual(["resync"]);
      } finally {
        releasePublication();
        publishing.mockRestore();
        LIVE_LIMITS.ringEvents = ringEvents;
        for (const socket of sockets) socket.socket.close();
      }
    });
  }

  test("an access event revokes a reader before later content on either replica", async () => {
    const ada = await person("Ada Example");
    const bob = await person("Bob Example");
    allow("revoke", ada, bob);
    const sockets = [await open(0, ada.headers), await open(0, bob.headers), await open(1, bob.headers)];
    try {
      for (const socket of sockets) socket.sub("s", "item", { key: "revoke" });
      await until(() => sockets.every((socket) => socket.of("s").length === 1));
      allow("revoke", ada);
      await publish("revoke", 1, { access: true });
      await publish("revoke", 2);
      await until(() => sockets.slice(1).every((socket) => socket.of("s").at(-1)?.t === "revoked"));
      for (const socket of sockets.slice(1)) {
        expect(socket.of("s")).toHaveLength(2);
        expect(socket.of("s")[1]).toEqual({ t: "revoked", id: "s", code: "access_denied" });
      }
      await until(() => sockets[0]!.of("s").filter((frame) => frame.t === "event").length === 2);
    } finally {
      for (const socket of sockets) socket.socket.close();
    }
  });

  test("events revoke a quiet reader, end a session, and refresh collection keys", async () => {
    const carol = await person("Carol Example");
    const dave = await person("Dave Example");
    allow("quiet", carol);
    allow("dave", dave);
    const quiet = await open(1, carol.headers);
    const expiring = await open(0, dave.headers);
    quiet.sub("one", "item", { key: "quiet" });
    quiet.sub("all", "list", {});
    expiring.sub("s", "item", { key: "dave" });
    await until(() => quiet.of("all").length === 1 && expiring.of("s").length === 1);

    const changedAt = Date.now();
    readers.delete("quiet");
    allow("gained", carol);
    await publish("quiet", 1, { access: true });
    await session.revokeAllForUser(dave.id);
    await until(() => quiet.of("one").length === 2 && expiring.state.closed !== null && quiet.of("all").length >= 2, 12_000);
    expect(Date.now() - changedAt).toBeLessThanOrEqual(5_000);
    expect(quiet.of("one")[1]).toEqual({ t: "revoked", id: "one", code: "access_denied" });
    expect(expiring.state.closed).toEqual({ code: 1008, reason: "session_expired" });

    await until(() => quiet.of("all").some((frame) => frame.t === "resync"));
    await publish("gained", 1);
    await until(() => quiet.of("all").some((frame) => frame.t === "event"));
    quiet.socket.close();
  });

  test("removing group membership revokes subscriptions on both replicas without a domain event", async () => {
    const member = await person("Group reader");
    const groupId = crypto.randomUUID();
    await sql`INSERT INTO auth.groups(id, cn, name, provider) VALUES(${groupId}::uuid, ${groupId}, ${groupId}, 'local')`;
    await sql`INSERT INTO auth.user_groups_v2(user_id, group_id) VALUES(${member.id}::uuid, ${groupId}::uuid)`;
    const sockets = [await open(0, member.headers), await open(1, member.headers)];
    try {
      for (const socket of sockets) socket.sub("s", "item", { key: `group:${groupId}` });
      await until(() => sockets.every((socket) => socket.of("s")[0]?.t === "ready"));
      await sql`DELETE FROM auth.user_groups_v2 WHERE user_id = ${member.id}::uuid AND group_id = ${groupId}::uuid`;
      wakeAppAccessChanged();
      await until(() => sockets.every((socket) => socket.of("s")[1]?.t === "revoked"));
      await publish(`group:${groupId}`, 1);
      await Bun.sleep(100);
      for (const socket of sockets) expect(socket.of("s").map((frame) => frame.t)).toEqual(["ready", "revoked"]);
    } finally {
      for (const socket of sockets) socket.socket.close();
      await sql`DELETE FROM auth.groups WHERE id = ${groupId}::uuid`;
    }
  });

  test("locking an account closes quiet sockets on both replicas without a delivery", async () => {
    const member = await person("Locked reader");
    allow("locked", member);
    const sockets = [await open(0, member.headers), await open(1, member.headers)];
    try {
      for (const socket of sockets) socket.sub("s", "item", { key: "locked" });
      await until(() => sockets.every((socket) => socket.of("s")[0]?.t === "ready"));
      await sql`INSERT INTO auth.user_ipa_data(user_id, locked_at) VALUES(${member.id}::uuid, now())`;
      wakeAppAccessChanged();
      await until(() => sockets.every((socket) => socket.state.closed !== null));
      for (const socket of sockets) expect(socket.state.closed).toEqual({ code: 1008, reason: "session_expired" });
    } finally {
      for (const socket of sockets) socket.socket.close();
    }
  });

  test("an access update reaches collections at once; progress keeps a quiet subscription inside the ring", async () => {
    const erin = await person("Erin Example");
    allow("seen", erin);
    const socket = await open(0, erin.headers);
    socket.sub("all", "list", {});
    socket.sub("quiet", "item", { key: "seen" });
    await until(() => socket.of("all").length === 1 && socket.of("quiet").length === 1);
    const subscribedAt = socket.of("quiet")[0]?.cursor as string;

    allow("new-book", erin);
    const accessAt = Date.now();
    await publish("new-book", 1, { access: true });
    await until(() => socket.of("all").some((frame) => frame.t === "resync"));
    expect(Date.now() - accessAt).toBeLessThan(5_000);
    // The collection reloads, which covers the update published with the access change; later ones arrive.
    await publish("new-book", 2);
    await until(() => socket.of("all").some((frame) => frame.data?.n === 2));

    const ringEvents = LIVE_LIMITS.ringEvents;
    LIVE_LIMITS.ringEvents = 3;
    try {
      for (let n = 2; n <= 6; n++) await publish("elsewhere", n);
      await Bun.sleep(LIVE_LIMITS.progressMs * 3);
      const progressed = socket.progress().at(-1)?.cursor as string;
      socket.socket.close();
      const again = await open(1, erin.headers);
      again.sub("stale", "item", { key: "seen" }, subscribedAt);
      again.sub("kept", "item", { key: "seen" }, progressed);
      await until(() => again.of("stale").length === 1 && again.of("kept").length === 1);
      expect(again.of("stale")[0]?.t).toBe("resync");
      expect(again.of("kept")[0]).toEqual({ t: "ready", id: "kept", cursor: progressed });
      again.socket.close();
    } finally {
      LIVE_LIMITS.ringEvents = ringEvents;
    }
  });

  test("oversized data arrives as a resync; a failing check closes with 1011 and the reconnect loses nothing", async () => {
    const fay = await person("Fay Example");
    allow("big", fay);
    allow("flaky", fay);
    const first = await open(0, fay.headers);
    first.sub("big", "item", { key: "big" });
    first.sub("flaky", "item", { key: "flaky" });
    await until(() => first.of("big").length === 1 && first.of("flaky").length === 1);
    await publish("big", 1, { pad: "x".repeat(40_000) });
    await until(() => first.of("big").length === 2);
    expect(first.of("big")[1]?.t).toBe("resync");

    const resumeAfter = first.of("flaky")[0]?.cursor as string;
    failing.add("flaky");
    await publish("flaky", 7, { access: true });
    await until(() => first.state.closed !== null);
    expect(first.state.closed).toEqual({ code: 1011, reason: "unavailable" });
    failing.delete("flaky");
    const second = await open(1, fay.headers);
    second.sub("flaky", "item", { key: "flaky" }, resumeAfter);
    await until(() => second.of("flaky").length === 2);
    expect(second.of("flaky")[0]).toMatchObject({ t: "event", data: { n: 7 } });
    second.socket.close();
  });

  test("a client whose buffers are full is closed with 1013", async () => {
    const gus = await person("Gus Example");
    allow("flood", gus);
    // A separate process, stopped with SIGSTOP, fills the kernel buffers before the 256-KiB send buffer.
    const client = Bun.spawn(
      [
        "bun",
        "-e",
        `const ws = new WebSocket(${JSON.stringify(url(0))}, { headers: ${JSON.stringify(gus.headers)} });
         ws.onopen = () => ws.send(JSON.stringify({ t: "sub", id: "s", channel: "item", scope: { key: "flood" } }));
         ws.onmessage = (m) => { if (String(m.data).includes('"ready"')) console.log("ready"); };
         ws.onclose = (c) => { console.log("closed " + c.code); process.exit(0); };`,
      ],
      { stdout: "pipe" },
    );
    const output: string[] = [];
    const lines = (async () => {
      for await (const chunk of client.stdout) output.push(new TextDecoder().decode(chunk));
    })();
    try {
      await until(() => output.join("").includes("ready"), 10_000);
      client.kill("SIGSTOP");
      const pad = "x".repeat(30_000);
      await sql.begin(async (tx) => {
        for (let n = 0; n < 600; n++) await live.publish(tx, { key: "flood", data: { n, pad } });
      });
      live.wake();
      await until(
        () => serverCloses.some(({ code, reason }) => code === 1013 && reason === "backpressure"),
        30_000,
        "The server did not close the slow client with 1013 backpressure",
      );
      // Resume at once: the close frame waits behind buffered frames. Bun drops a peer
      // that has not read its close after about 12 seconds; a later resume reads 1006.
      client.kill("SIGCONT");
      await until(() => output.join("").includes("closed "), 10_000, "The slow client did not report its close");
      expect(output.join("")).toContain("closed 1013");
    } finally {
      client.kill("SIGKILL");
      await client.exited;
      await lines;
    }
  }, 60_000);

  test("a missing or ended session, another origin, missing Origin and an OAuth token without read are refused on the socket with 1008", async () => {
    const hal = await person("Hal Example");
    // Behind the gateway the browser never sees a refused handshake, only a retryable close.
    const refusal = async (headers: Record<string, string>) => {
      const socket = new BunWebSocket(url(0), { headers });
      return await new Promise<{ frame: unknown; close: { code: number; reason: string } }>((resolve, reject) => {
        let frame: unknown = null;
        socket.onmessage = (message) => (frame = JSON.parse(String(message.data)));
        socket.onclose = (close) => resolve({ frame, close: { code: close.code, reason: close.reason } });
        socket.onerror = () => reject(new Error("The live socket did not open"));
      });
    };
    const refused = (code: string) => ({ frame: { t: "error", code, message: expect.any(String) }, close: { code: 1008, reason: code } });
    const address = () => ({ "x-forwarded-for": uniqueCallerAddress() });

    expect(await refusal({ origin, ...address() })).toEqual(refused("login_required"));
    expect(await refusal({ ...hal.headers, origin: "https://elsewhere.example" })).toEqual(refused("forbidden_origin"));
    for (const rejected of [undefined, "null", "https://sibling.example"]) {
      const headers: Record<string, string> = { cookie: hal.headers.cookie, ...address() };
      if (rejected) headers.origin = rejected;
      expect(await refusal(headers)).toEqual(refused("forbidden_origin"));
    }
    expect(await refusal({ ...hal.headers, "sec-fetch-site": "same-site" })).toEqual(refused("forbidden_origin"));

    const clientId = `live-${crypto.randomUUID()}`;
    await sql`INSERT INTO oauth.clients (name, client_id, redirect_uris) VALUES ('Live test', ${clientId}, ARRAY['https://client.example/callback'])`;
    try {
      const signer = await prepareIdentitySigner("oauth");
      const { issuer } = await getIdentityRuntimeConfig();
      const [account] = await sql<{ auth_epoch: string | number }[]>`SELECT auth_epoch FROM auth.users WHERE id = ${hal.id}::uuid`;
      const token = (scope: string) =>
        new SignJWT({ token_use: "access", client_id: clientId, id: hal.id, auth_epoch: Number(account!.auth_epoch), scope })
          .setProtectedHeader({ alg: "RS256", kid: signer.kid })
          .setIssuer(issuer)
          .setAudience("cloud")
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(signer.key);
      const bearer = async (scope: string) => ({ authorization: `Bearer ${await token(scope)}`, ...address() });
      expect(await refusal(await bearer("openid profile"))).toEqual(refused("missing_scope"));
      allow("oauth", hal);
      const reader = await open(0, await bearer("openid read"));
      reader.sub("s", "item", { key: "oauth" });
      await until(() => reader.of("s").length === 1);
      expect(reader.of("s")[0]?.t).toBe("ready");
      reader.socket.close();
    } finally {
      await sql`DELETE FROM oauth.clients WHERE client_id = ${clientId}`;
    }

    // A tab whose session ended while its socket was closed stops instead of retrying.
    await session.revokeAllForUser(hal.id);
    expect(await refusal(hal.headers)).toEqual(refused("login_required"));
  });

  // Last: it stops delivery and starts it again.
  test("a stopping replica closes its sockets with 1012, also those that open while it stops, until delivery starts again", async () => {
    const ivy = await person("Ivy Example");
    allow("stop", ivy);
    // A mount that served no socket before the stop, like a quiet replica.
    const quiet = { routes: live.routes(channels), server: null as ReturnType<typeof Bun.serve> | null };
    quiet.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: new Hono().route("/live", quiet.routes).fetch,
      websocket: recordedWebsocket,
    });
    pods.push(quiet);
    const closed = async (socket: Awaited<ReturnType<typeof open>>) => {
      await until(() => socket.state.closed !== null);
      return socket.state.closed;
    };
    const restart = { code: 1012, reason: "restart" };

    const before = await open(0, ivy.headers);
    before.sub("s", "item", { key: "stop" });
    await until(() => before.of("s").length === 1);
    await stopOutbox?.();
    expect(await closed(before)).toEqual(restart);
    for (const pod of [0, pods.length - 1]) expect(await closed(await open(pod, ivy.headers))).toEqual(restart);

    stopOutbox = await startLiveOutbox(APP);
    for (const pod of [0, pods.length - 1]) {
      const again = await open(pod, ivy.headers);
      again.sub("s", "item", { key: "stop" });
      await until(() => again.of("s").length === 1);
      expect(again.of("s")[0]?.t).toBe("ready");
      again.socket.close();
    }
  });
  useRegisteredTestApp("livetest");
  test("the public live viewer carries no caller credential or transport", async () => {
    const who = await person("Viewer contract");
    readers.set("viewer-contract", new Set([who.viewer]));
    const client = await open(0, who.headers);
    try {
      client.sub("viewer", "item", { key: "viewer-contract" });
      await until(() => client.of("viewer").some((frame) => frame.t === "ready"));
      const viewer = capturedViewers.find((viewer) => viewer.id === who.viewer);
      expect(viewer).toBeDefined();
      expect(JSON.stringify(viewer)).not.toContain(who.headers.cookie);
      expect(JSON.stringify(viewer)).not.toContain("session_token");
      expect(viewer).not.toHaveProperty("caller");
      expect(viewer).not.toHaveProperty("capabilityTransport");
    } finally {
      client.socket.close();
    }
  });
});
