import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { Hono } from "hono";
import { upgradeWebSocket, websocket } from "hono/bun";
import { z } from "zod";
import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
import "../../../../../scripts/fixtures/authorization-preload";
import { getProcessSync } from "../../_internal/process-sync";
import { subscribeIdentityAccessChanged } from "../../events/app-access";
import { liveOutbox, liveTopic } from "../../events/live-delivery";
import { sql } from "../../runtime/clients";
import { createSharedTextRoom, createSharedTextRoomContext, sharedText } from "../../shared-text";
import type { SharedTextRoomMessages } from "../../shared-text/room";
import { verifySessionToken } from "../identity";
import * as settings from "../settings";
import { session } from "./index";
import { sharedWorkstationCookieName } from "./shared-workstation";

const messages: SharedTextRoomMessages = {
  notFound: "missing",
  sessionExpired: "expired",
  accessDenied: "denied",
  writeAccessRequired: "write",
  accessRefreshFailed: "refresh",
  liveSyncStorageExhausted: "storage",
  liveSyncStreamFailed: "sync",
  liveAwarenessStreamFailed: "awareness",
  replayRequired: "replay",
  reopenRequired: "reopen",
  loginRequired: "login",
  invalidSyncUpdate: "invalid",
  invalidBase64: "base64",
  invalidMessage: "message",
  invalidJson: "json",
  jsonTextOnly: "text",
  messageTooLarge: "large",
  tooManyMessages: "many",
  busy: "busy",
  handlingFailed: "handling",
  messageNotAllowed: () => "phase",
};

// Bun accepts request headers in addition to the browser WebSocket signature.
const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;

suiteFor(
  "database",
  "nats",
  "valkey",
)("session changes reach an open shared-text socket", () => {
  const topic = () => liveTopic("core");
  const outbox = liveOutbox("core", (row) => topic().publish({ data: row.payload, orderingKey: row.ordering_key, idempotencyKey: row.id }));
  let server: ReturnType<typeof Bun.serve>;
  let room: ReturnType<typeof makeRoom>;
  const sockets = new Set<WebSocket>();
  const users = new Set<string>();

  const makeRoom = () => {
    const log = sharedText.define({
      id: "session-live-text",
      retention: { maxBytes: 1024 * 1024 },
      maxPayloadBytes: 8192,
    });
    return createSharedTextRoom({
      log,
      snapshots: { queue: async () => {} },
      awarenessTopic: () =>
        getProcessSync().topic({
          id: "session-live-awareness",
          retention: { maxAgeMs: 60_000, maxBytes: 65536 },
          dedupeWindowMs: 60_000,
          maxPayloadBytes: 8192,
        }),
      protocol: {
        wsType: {
          replayRequest: "replay",
          replayReady: "ready",
          syncPublish: "edit",
          syncPush: "push",
          awarenessPublish: "cursor",
          awarenessPush: "awareness",
          error: "error",
        },
        documentId: z.string(),
        maxSyncPayloadLength: 8192,
        streamCursorPattern: /^s6t\./,
        decode: (packet) => packet,
        encode: (type, payload) => ({ type, payload }),
      },
      adapter: {
        authenticate: async (credential) => (credential ? session.authenticate(credential) : null),
        authorize: async () => ({ ok: true, resolvedDocId: "document", canWrite: false }),
        load: async () => ({ state: new Uint8Array([0, 0]), text: "", cursor: log.topic().cursorAt(0), restoreRevision: "0" }),
        actor: (identity) => ({ kind: "user", id: identity.user.id }),
        awarenessUser: (identity) => ({ userId: identity.user.id, name: "Reader", color: "blue" }),
        revalidate: async (context) =>
          context.sessionToken && (await session.authenticate(context.sessionToken))
            ? { ok: true, canWrite: false }
            : { ok: false, code: "SESSION_EXPIRED", message: "Session ended" },
        recover: async () => {
          throw new Error("Unexpected history gap");
        },
      },
    });
  };

  beforeAll(async () => {
    const [clock] = await sql<{ now: Date }[]>`SELECT now() AS now`;
    setSystemTime(clock!.now);
    room = makeRoom();
    const app = new Hono().get(
      "/socket",
      upgradeWebSocket(async (c) => {
        const token = c.req.header("authorization")?.slice("Bearer ".length) ?? null;
        const claims = token ? await verifySessionToken(token) : null;
        const context = createSharedTextRoomContext<NonNullable<Awaited<ReturnType<typeof session.authenticate>>>, SharedTextRoomMessages>(
          { send: (raw) => socket?.send(raw), close: (code, reason) => socket?.close(code, reason) },
          token,
          messages,
        );
        let socket: { send(raw: string): unknown; close(code?: number, reason?: string): void } | undefined;
        let peer: ReturnType<typeof room.connect> | undefined;
        let stop = () => {};
        return {
          onOpen: (_event, ws) => {
            socket = ws;
            peer = room.connect(context);
            stop = subscribeIdentityAccessChanged(() => void room.revalidate(context), { userId: claims?.sub, sid: claims?.sid });
          },
          onMessage: (event) => peer?.receive(event.data),
          onClose: async () => {
            stop();
            await peer?.close();
          },
          onError: async () => {
            stop();
            await peer?.close();
          },
        };
      }),
    );
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, websocket });
  });

  afterAll(async () => {
    for (const socket of sockets) socket.close();
    await room?.drain();
    await server?.stop(true);
    await outbox.stop();
    for (const userId of users) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    setSystemTime();
  });

  const create = async (shared = false) => {
    const userId = crypto.randomUUID();
    users.add(userId);
    await sql`INSERT INTO auth.users(id, uid, provider, profile) VALUES (${userId}::uuid, ${userId}, 'local', 'user')`;
    const app = new Hono().post("/login", async (c) => c.text(await session.create(c, userId, { method: "password", notify: null })));
    const response = await app.request("/login", {
      method: "POST",
      headers: {
        Cookie: shared ? `${sharedWorkstationCookieName()}=1` : "",
      },
    });
    expect(response.status).toBe(200);
    const token = await response.text();
    const claims = await verifySessionToken(token);
    if (!claims) throw new Error("Missing session claims");
    // Complete first-use consent before joining an application room.
    await sql`INSERT INTO auth.legal_acceptances(user_id, session_id, document_version, documents)
      VALUES (${userId}::uuid, ${claims.sid}::uuid, 'fixture', '[]'::jsonb)`;
    return { token, claims, userId };
  };

  const connect = async (token: string) => {
    const ready = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<{ code: number; reason: string }>();
    const socket = new BunWebSocket(`ws://127.0.0.1:${server.port}/socket`, { headers: { Authorization: `Bearer ${token}` } });
    sockets.add(socket);
    socket.addEventListener("message", (event) => {
      if (JSON.parse(String(event.data)).type === "ready") ready.resolve();
    });
    socket.addEventListener("close", (event) => {
      closed.resolve({ code: event.code, reason: event.reason });
      ready.reject(new Error(`Socket ended before ready: ${event.reason}`));
    });
    socket.addEventListener("error", () => ready.reject(new Error("Socket did not upgrade")));
    socket.addEventListener("open", () =>
      socket.send(JSON.stringify({ type: "replay", payload: { docId: "document", restoreRevision: "0" } })),
    );
    await ready.promise;
    return { socket, closed: closed.promise };
  };

  const dispatch = async () => {
    await outbox.reconcile();
    // A scoped barrier on the real follower ensures earlier events have arrived.
    const sid = crypto.randomUUID();
    const seen = Promise.withResolvers<void>();
    const stop = subscribeIdentityAccessChanged(() => seen.resolve(), { sid });
    try {
      await topic().publish({ data: { v: 1, k: sid, d: { type: "identity.access.changed", sid } } });
      await seen.promise;
    } finally {
      stop();
    }
  };

  const expectEnded = async (client: Awaited<ReturnType<typeof connect>>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ended = await Promise.race([
        client.closed,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Session event did not close the socket")), 1000);
        }),
      ]);
      expect(ended).toEqual({ code: 1008, reason: "SESSION_EXPIRED" });
    } finally {
      clearTimeout(timer);
      client.socket.close();
    }
  };

  for (const reason of ["sign_out_others", "password_change", "password_reset"] as const)
    test(`${reason} keeps the inherited idle deadline on the replacement socket`, async () => {
      const previous = await settings.get<number>("user.session.shared_workstation_idle_minutes");
      try {
        await settings.set("user.session.shared_workstation_idle_minutes", 2);
        const f = await create(true);
        const old = await connect(f.token);
        await dispatch();
        // real clock: PostgreSQL owns idle deadlines. Leave eight seconds of the
        // configured two minutes, so rotation and the replacement connect finish
        // first even on a loaded runner, then let the inherited deadline pass without input.
        await sql`UPDATE auth.session_families SET last_input_at = clock_timestamp() - interval '112 seconds' WHERE sid = ${f.claims.sid}::uuid`;
        const rotated = await session.endOtherSignIns(f.userId, { keep: { sid: f.claims.sid, authEpoch: f.claims.auth_epoch }, reason });
        expect(rotated.kept).not.toBeNull();
        await dispatch();
        await expectEnded(old);
        const token = rotated.kept!.token;
        const replacement = await verifySessionToken(token);
        const client = await connect(token);
        await dispatch();
        expect(client.socket.readyState).toBe(WebSocket.OPEN);
        const deadlines = await sql<{ ordering_key: string; anchored: boolean }[]>`SELECT o.ordering_key,
          o.next_attempt_at = CASE WHEN o.ordering_key LIKE 'identity.deadline.idle:%'
            THEN sf.last_input_at + interval '120 seconds' ELSE sf.expires_at END AS anchored
          FROM events.outbox o JOIN auth.session_families sf ON sf.sid = ${replacement!.sid}::uuid
          WHERE o.ordering_key IN (${"identity.deadline.idle:" + replacement!.sid}, ${"identity.deadline.session:" + replacement!.sid})`;
        expect(deadlines).toHaveLength(2);
        expect(deadlines.every((row) => row.anchored)).toBe(true);
        const [deadline] = await sql<{ remaining: number }[]>`SELECT
          extract(epoch FROM last_input_at + interval '120 seconds' - clock_timestamp())::float8 AS remaining
          FROM auth.session_families WHERE sid = ${replacement!.sid}::uuid`;
        await Bun.sleep(Math.max(0, deadline!.remaining * 1000 + 10));
        await dispatch();
        await expectEnded(client);
        expect(
          await sql`SELECT sid FROM auth.session_families WHERE sid = ${replacement!.sid}::uuid AND revocation_reason = 'idle'`,
        ).toHaveLength(1);
      } finally {
        await settings.set("user.session.shared_workstation_idle_minutes", previous);
      }
    });

  for (const path of ["pending flag", "acceptance removal"] as const)
    test(`${path} reaches the open socket`, async () => {
      const f = await create();
      if (path === "pending flag") await sql`UPDATE auth.session_families SET legal_pending = false WHERE sid = ${f.claims.sid}::uuid`;
      const client = await connect(f.token);
      await dispatch();
      if (path === "pending flag") {
        await sql`DELETE FROM auth.legal_acceptances WHERE user_id = ${f.userId}::uuid`;
        await dispatch();
        expect(client.socket.readyState).toBe(WebSocket.OPEN);
        await sql`UPDATE auth.session_families SET legal_pending = true WHERE sid = ${f.claims.sid}::uuid`;
      } else await sql`DELETE FROM auth.legal_acceptances WHERE user_id = ${f.userId}::uuid`;
      await dispatch();
      await expectEnded(client);
    });

  test("browser sign-out followed by another account closes only the former socket", async () => {
    const previous = await create();
    const old = await connect(previous.token);
    await dispatch();
    const logout = new Hono().post("/logout", async (c) => c.json(await session.delete(c, previous.userId)));
    const response = await logout.request("/logout", { method: "POST", headers: { Cookie: `session_token=${previous.token}` } });
    expect(await response.json()).toBe(true);
    const next = await create();
    const current = await connect(next.token);
    await dispatch();
    await expectEnded(old);
    expect(current.socket.readyState).toBe(WebSocket.OPEN);
    current.socket.close();
  });

  test("same-account sign-in and a failed account change keep the original family", async () => {
    const previous = await create();
    const client = await connect(previous.token);
    await dispatch();
    let userId = previous.userId;
    const login = new Hono()
      .onError((_error, c) => c.text("Sign-in failed", 400))
      .post("/login", async (c) => c.text(await session.create(c, userId, { method: "password", notify: null })));
    const request = () => login.request("/login", { method: "POST", headers: { Cookie: `session_token=${previous.token}` } });
    expect((await request()).status).toBe(200);
    userId = crypto.randomUUID();
    expect((await request()).status).toBe(400);
    await dispatch();
    expect((await session.authenticate(previous.token))?.user.id).toBe(previous.userId);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    client.socket.close();
  });
});
