import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { suiteFor, useMigratedDatabase } from "../../../../scripts/fixtures/test-infra";
import { redis, sql } from "../runtime/clients";
import type { AuthContext } from "../server/middleware/auth";
import { session as browserSession } from "../services/session";
import { buildProjectedUser } from "../services/session/user";
import * as credentials from "./credentials";
import { createLiveDictationLimits, liveDictationDay } from "./live-dictation-limits";
import { getLiveDictationStatus, resolveLiveDictationModel } from "./live-dictation-model";
import { aiDictationRoutes, createLiveDictationRevalidator, liveDictationOriginAllowed } from "./live-dictation-routes";
import {
  createLiveDictationSession,
  LIVE_DICTATION_PROVIDER_BUFFER_BYTES,
  type LiveDictationAccounting,
  type LiveDictationClock,
  type LiveDictationOptions,
} from "./live-dictation-runtime";
import { aiModelAccess } from "./model-access";
import { aiModelCatalog } from "./model-catalog";
import { migrateAiQuotas } from "./quotas-migrate";
import * as aiSettings from "./settings";
import type { AiModelProfile } from "./types";
import { aiUsage } from "./usage";

const suite = suiteFor("database", "valkey");
const flush = () => Bun.sleep(2);
class Clock implements LiveDictationClock {
  time = Date.parse("2026-11-01T12:00:00Z");
  tasks = new Set<{ at: number; run(): void | Promise<void> }>();
  now = () => this.time;
  schedule(ms: number, run: () => void | Promise<void>) {
    const task = { at: this.time + ms, run };
    this.tasks.add(task);
    return () => {
      this.tasks.delete(task);
    };
  }
  async advance(ms: number) {
    const until = this.time + ms;
    while (true) {
      const next = [...this.tasks].filter((task) => task.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.time = next.at;
      this.tasks.delete(next);
      await next.run();
      await flush();
    }
    this.time = until;
    await flush();
  }
}
const profile: AiModelProfile = {
  id: "live-test",
  modelId: "live-test",
  providerId: "live-test",
  label: "Live test",
  variantLabel: "Standard",
  description: "",
  icon: { kind: "provider" },
  showInPicker: false,
  provider: "vllm-realtime",
  model: "fake-realtime",
  enabled: true,
  capabilities: ["live-transcription"],
  dataBoundary: "private",
  baseURL: "http://127.0.0.1",
};
const until = async (check: () => boolean) => {
  for (let tries = 0; tries < 500; tries++) {
    if (check()) return;
    await flush();
  }
  throw new Error("Live dictation condition timed out");
};

suite("live dictation server", () => {
  let database: Awaited<ReturnType<typeof useMigratedDatabase>>;
  let server: ReturnType<typeof Bun.serve>;
  let credentialRead: ReturnType<typeof spyOn<typeof credentials, "getAiCredential">>;
  const providerFrames: Record<string, unknown>[] = [];
  let providerClosed = 0;
  let finishProvider = true;
  let providerGreets = true;
  let finalText = "hello world";
  let earlyDone = false;
  let starts = 0;
  const active: ReturnType<typeof createLiveDictationSession>[] = [];
  const namespaces = new Set<string>();

  beforeAll(async () => {
    database = await useMigratedDatabase("live_dictation");
    credentialRead = spyOn(credentials, "getAiCredential").mockResolvedValue(null);
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req, { data: undefined })) return;
        return new Response(null, { status: 400 });
      },
      websocket: {
        open(ws) {
          if (providerGreets) ws.send(JSON.stringify({ type: "session.created" }));
        },
        message(ws, data) {
          const event = JSON.parse(String(data));
          providerFrames.push(event);
          if (event.type === "input_audio_buffer.append") {
            ws.send(JSON.stringify({ type: "transcription.delta", delta: "hello " }));
            if (earlyDone) ws.send(JSON.stringify({ type: "transcription.done", text: finalText }));
          }
          if (event.type === "input_audio_buffer.commit" && event.final && finishProvider)
            ws.send(JSON.stringify({ type: "transcription.done", text: finalText }));
        },
        close() {
          providerClosed++;
        },
      },
    });
  }, 300_000);
  afterAll(async () => {
    for (const session of active) session.abort();
    await Promise.all(active.map((session) => session.settled()));
    server?.stop(true);
    credentialRead?.mockRestore();
    for (const namespace of namespaces) {
      const keys: unknown = await redis.send("KEYS", [`${namespace}:*`]);
      if (Array.isArray(keys)) for (const key of keys) if (typeof key === "string") await redis.del(key);
    }
    await database?.drop();
  });

  const setup = (patch: Partial<LiveDictationOptions> = {}) => {
    const namespace = `test:live-dictation:${crypto.randomUUID()}`;
    namespaces.add(namespace);
    const clock = new Clock();
    const messages: Record<string, unknown>[] = [];
    const closes: { code: number; reason?: string }[] = [];
    const booked: Parameters<LiveDictationAccounting["finish"]>[0][] = [];
    const options: LiveDictationOptions = {
      userId: crypto.randomUUID(),
      profile: { ...profile, baseURL: `http://127.0.0.1:${server.port}/v1` },
      clock,
      concurrency: 4,
      minutesPerDay: 60,
      timeZone: "Europe/Berlin",
      limits: createLiveDictationLimits(namespace),
      send: (message) => messages.push(message),
      close: (code, reason) => closes.push({ code, reason }),
      revalidate: async () => true,
      accounting: {
        async begin() {
          starts++;
          return crypto.randomUUID();
        },
        async finish(input) {
          booked.push(input);
        },
      },
      ...patch,
    };
    const session = createLiveDictationSession(options);
    active.push(session);
    return {
      session,
      options,
      messages,
      closes,
      clock,
      booked,
      namespace,
      async start() {
        session.receive(JSON.stringify({ type: "start", app: "notebooks" }));
        await until(() => messages.some((event) => event.type === "ready" || event.type === "error"));
      },
    };
  };
  const voiced = () => {
    const data = new Uint8Array(3200);
    const view = new DataView(data.buffer);
    for (let i = 0; i < data.length; i += 2) view.setInt16(i, 1000, true);
    return data;
  };

  test("live slot eligibility, status and owning-model grants use the catalog contract", async () => {
    const userId = crypto.randomUUID();
    await sql`INSERT INTO auth.users(id,uid,provider,profile,display_name) VALUES(${userId}::uuid,${userId},'local','user','Live status test')`;
    const providerId = `live-${crypto.randomUUID()}`;
    const modelId = `${providerId}-model`;
    const provider = await aiModelCatalog.createProvider(
      { id: providerId, type: "vllm-realtime", label: "Realtime", baseUrl: `http://127.0.0.1:${server.port}/v1`, dataBoundary: "private" },
      userId,
    );
    expect(provider.credentialSet).toBe(false);
    const [model] = await aiModelCatalog.createModels(
      providerId,
      [{ id: modelId, providerModel: "fake", label: "Realtime model", kind: "live-transcription" }],
      userId,
    );
    expect(model?.capabilities).toEqual(["live-transcription"]);
    const assignment = (await aiModelCatalog.assignments()).find((row) => row.slot === "liveAudio")!;
    await aiModelCatalog.assign("liveAudio", modelId, assignment.revision, userId);
    await expect(
      aiModelCatalog.assign(
        "balanced",
        modelId,
        (await aiModelCatalog.assignments()).find((row) => row.slot === "balanced")!.revision,
        userId,
      ),
    ).rejects.toThrow();
    const state = await aiSettings.readAiSettingsState();
    state.enabled = true;
    const read = spyOn(aiSettings, "readAiSettingsState").mockImplementation(async () => state);
    try {
      expect(await getLiveDictationStatus({ type: "user", userId })).toEqual({ available: true });
      expect((await resolveLiveDictationModel({ type: "user", userId })).modelId).toBe(modelId);
      expect(await getLiveDictationStatus(null)).toEqual({ available: false, reason: "no_access" });
      state.enabled = false;
      expect(await getLiveDictationStatus({ type: "user", userId })).toEqual({ available: false, reason: "disabled" });
      state.enabled = true;
      const access = (await aiModelAccess.listForAdmin())[modelId]!;
      await sql.begin((db) => aiModelAccess.syncModels([modelId], [{ modelId, expectedRevision: access.revision, entries: [] }], db));
      expect(await getLiveDictationStatus({ type: "user", userId })).toEqual({ available: false, reason: "no_access" });
      state.assignments = state.assignments.map((row) => (row.slot === "liveAudio" ? { ...row, variantId: null } : row));
      expect(await getLiveDictationStatus({ type: "user", userId })).toEqual({ available: false, reason: "not_configured" });
    } finally {
      read.mockRestore();
      await sql`UPDATE ai.model_assignments SET variant_id=NULL WHERE variant_id=${modelId}`;
      await sql`DELETE FROM ai.providers WHERE id=${providerId}`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });
  test("requires the exact Cloud origin, including an Origin header", () => {
    expect(liveDictationOriginAllowed("https://cloud.example", "https://cloud.example/")).toBe(true);
    expect(liveDictationOriginAllowed(undefined, "https://cloud.example/")).toBe(false);
    expect(liveDictationOriginAllowed("https://other.example", "https://cloud.example/")).toBe(false);
  });
  test("unauthenticated socket rejection is a terminal 1008 frame through the public route", async () => {
    const route = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: new Hono().route("/api/ai/dictation", aiDictationRoutes).fetch,
      websocket,
    });
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${route.port}/api/ai/dictation/live`);
      const frames: unknown[] = [];
      const closed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
        socket.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
        socket.onclose = (event) => resolve({ code: event.code, reason: event.reason });
        socket.onerror = () => reject(new Error("Dictation route handshake failed"));
      });
      expect(await closed).toEqual({ code: 1008, reason: "no_access" });
      expect(frames).toEqual([{ type: "error", code: "no_access", retryable: false }]);
    } finally {
      route.stop(true);
    }
  });
  test("person lease and semaphore reserve atomically across independent sessions", async () => {
    const one = setup({ concurrency: 1 });
    await one.start();
    const two = setup({ userId: one.options.userId, limits: one.options.limits, concurrency: 1 });
    await two.start();
    expect(two.messages.at(-1)?.code).toBe("busy_elsewhere");
    const code = `import { initializeTestPlatform } from "./scripts/fixtures/test-infra";
      await initializeTestPlatform();
      const { createLiveDictationLimits } = await import("./packages/cloud/src/ai/live-dictation-limits");
      const { closePlatformClients } = await import("./packages/cloud/src/runtime/clients");
      console.log(JSON.stringify(await createLiveDictationLimits(${JSON.stringify(one.namespace)}).reserve(${JSON.stringify({ userId: one.options.userId, token: "other-process", now: one.clock.now(), concurrency: 1, minutesPerDay: 60, timeZone: "Europe/Berlin" })})));
      await closePlatformClients();`;
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e", code], { env: process.env, stdout: "pipe", stderr: "pipe" });
    const [output, childError, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(childError).toBe("");
    expect(exit).toBe(0);
    expect(JSON.parse(output).result).toBe("busy_elsewhere");
    const three = setup({ limits: one.options.limits, concurrency: 1 });
    await three.start();
    expect(three.messages.at(-1)?.code).toBe("overloaded");
    expect(three.closes.at(-1)?.code).toBe(1008);
    one.session.abort();
    await one.session.settled();
  });
  test("a delayed release and renewal cannot delete or extend a newer person's lease", async () => {
    const namespace = `test:live-dictation:${crypto.randomUUID()}`;
    namespaces.add(namespace);
    const limits = createLiveDictationLimits(namespace);
    const userId = crypto.randomUUID();
    const now = Date.parse("2026-11-01T12:00:00Z");
    const input = { userId, token: "old", now, concurrency: 4, minutesPerDay: 60, timeZone: "UTC" };
    expect((await limits.reserve(input)).result).toBe("ok");
    await redis.del(`${namespace}:person:${userId}`);
    expect((await limits.reserve({ ...input, token: "new", now: now + 16000 })).result).toBe("ok");
    await limits.release(userId, "old");
    expect(await redis.get(`${namespace}:person:${userId}`)).toBe("new");
    expect(await limits.renew(userId, "old")).toBe(false);
    await limits.release(userId, "new");
  });
  test("replica clock skew cannot evict an active semaphore slot or prevent renewal", async () => {
    const current = setup({ concurrency: 1 });
    await current.start();
    const limits = current.options.limits!;
    expect(await limits.renew(current.options.userId, (await redis.get(`${current.namespace}:person:${current.options.userId}`))!)).toBe(
      true,
    );
    const blocked = await limits.reserve({
      userId: crypto.randomUUID(),
      token: "skewed",
      now: current.clock.now() + 86_400_000,
      concurrency: 1,
      minutesPerDay: 60,
      timeZone: "UTC",
    });
    expect(blocked.result).toBe("overloaded");
    const token = (await redis.get(`${current.namespace}:person:${current.options.userId}`))!;
    await redis.send("ZADD", [`${current.namespace}:slots`, "0", token]);
    expect(await limits.renew(current.options.userId, token)).toBe(false);
    current.session.abort();
    await current.session.settled();
  });
  test("stop drains Nessi's final commit and delivers the last words before close", async () => {
    const current = setup();
    const framesBefore = providerFrames.length;
    await current.start();
    current.session.receive(voiced());
    await until(() => current.messages.some((event) => event.type === "delta"));
    current.session.receive('{"type":"stop"}');
    await current.session.settled();
    expect(current.messages.slice(-2)).toEqual([{ type: "finishing" }, { type: "done", text: "hello world", audioMs: 100 }]);
    expect(providerFrames.slice(framesBefore).some((event) => event.type === "input_audio_buffer.commit" && event.final === true)).toBe(
      true,
    );
    expect(current.closes.at(-1)?.code).toBe(1000);
    expect(current.booked[0]?.audioMs).toBe(100);
  });
  test("abort closes the model immediately without waiting for final text", async () => {
    const current = setup();
    await current.start();
    const before = providerClosed;
    current.session.abort();
    expect(current.session.signal.aborted).toBe(true);
    await current.session.settled();
    await until(() => providerClosed > before);
    expect(current.messages.some((event) => event.type === "done")).toBe(false);
    expect(current.booked[0]?.status).toBe("aborted");
  });
  for (const early of [false, true]) {
    test(`a normalized final transcript preserves streamed text and succeeds${early ? " before stop" : ""}`, async () => {
      finalText = "hello";
      earlyDone = early;
      const current = setup();
      try {
        await current.start();
        current.session.receive(voiced());
        await until(() => current.messages.some((event) => event.type === "delta"));
        if (!early) current.session.receive('{"type":"stop"}');
        await current.session.settled();
        expect(current.messages.at(-1)).toEqual({ type: "done", text: "hello ", audioMs: 100 });
        expect(current.messages.filter((event) => event.type === "delta")).toEqual([{ type: "delta", text: "hello " }]);
        expect(current.booked).toHaveLength(1);
        expect(current.booked[0]?.status).toBe("ok");
        expect(current.closes.at(-1)?.code).toBe(1000);
      } finally {
        finalText = "hello world";
        earlyDone = false;
        current.session.abort();
        await current.session.settled();
      }
    });
  }
  test("provider completion before stop can append its final suffix", async () => {
    earlyDone = true;
    const current = setup();
    try {
      await current.start();
      current.session.receive(voiced());
      await current.session.settled();
      expect(current.messages.slice(-2)).toEqual([{ type: "finishing" }, { type: "done", text: "hello world", audioMs: 100 }]);
      expect(current.booked[0]?.status).toBe("ok");
    } finally {
      earlyDone = false;
      current.session.abort();
      await current.session.settled();
    }
  });
  test("abort during accounting begin claims finish once even while lease release is pending", async () => {
    const begin = Promise.withResolvers<string>();
    const release = Promise.withResolvers<void>();
    let beginning = false;
    let releasing = false;
    const booked: Parameters<LiveDictationAccounting["finish"]>[0][] = [];
    const current = setup({
      accounting: {
        async begin() {
          beginning = true;
          return begin.promise;
        },
        async finish(input) {
          booked.push(input);
        },
      },
    });
    const limits = current.options.limits!;
    const realRelease = limits.release.bind(limits);
    const releasingLease = spyOn(limits, "release").mockImplementation(async (userId, token) => {
      releasing = true;
      await release.promise;
      await realRelease(userId, token);
    });
    try {
      current.session.receive('{"type":"start","app":"notebooks"}');
      await until(() => beginning);
      current.session.abort();
      await until(() => releasing);
      begin.resolve(crypto.randomUUID());
      await until(() => booked.length === 1);
      release.resolve();
      await current.session.settled();
      expect(booked).toHaveLength(1);
      expect(booked[0]).toMatchObject({ status: "aborted", durationMs: 0, audioMs: 0 });
    } finally {
      begin.resolve(crypto.randomUUID());
      release.resolve();
      current.session.abort();
      await current.session.settled();
      releasingLease.mockRestore();
    }
  });
  test("a failed client send releases the lease and leaves no session timers", async () => {
    const current = setup({
      send() {
        throw new Error("Transport closed");
      },
    });
    current.session.receive('{"type":"start","app":"notebooks"}');
    await until(() => current.session.signal.aborted);
    await current.session.settled();
    expect(current.clock.tasks.size).toBe(0);
    expect(await redis.get(`${current.namespace}:person:${current.options.userId}`)).toBeNull();
    expect(current.booked.at(-1)?.status).toBe("aborted");
  });
  test("invalid controls, duplicate starts, frames before start and excessive inbound bytes close terminally", async () => {
    for (const data of ['{"type":"stop"}', '{"type":"unknown"}', '{"type":"start","app":"notebooks","extra":true}', new Uint8Array(2)]) {
      const current = setup();
      current.session.receive(data);
      expect(current.closes.at(-1)?.code).toBe(1008);
    }
    const duplicate = setup();
    await duplicate.start();
    duplicate.session.receive('{"type":"start","app":"mail"}');
    expect(duplicate.closes.at(-1)?.code).toBe(1008);
    await duplicate.session.settled();
    const rate = setup();
    await rate.start();
    for (let i = 0; i < 21; i++) {
      rate.session.receive(voiced());
      await flush();
    }
    expect(rate.closes.at(-1)?.code).toBe(1008);
    expect(rate.messages.at(-1)?.code).toBe("connection_lost");
    await rate.session.settled();
  });
  test("start and model connection each have a five-second deadline", async () => {
    const waiting = setup();
    const before = starts;
    await waiting.clock.advance(5000);
    expect(waiting.messages.at(-1)?.code).toBe("connection_lost");
    expect(starts).toBe(before);
    providerGreets = false;
    try {
      const connecting = setup();
      connecting.session.receive('{"type":"start","app":"chat"}');
      await until(() => starts > before);
      await flush();
      await connecting.clock.advance(5000);
      await connecting.session.settled();
      expect(connecting.messages.at(-1)?.code).toBe("provider_failed");
    } finally {
      providerGreets = true;
    }
  });
  test("audio after start but before provider readiness closes with 1008", async () => {
    providerGreets = false;
    const current = setup();
    const before = starts;
    try {
      current.session.receive('{"type":"start","app":"chat"}');
      await until(() => starts > before);
      current.session.receive(voiced());
      await current.session.settled();
      expect(current.closes.at(-1)).toEqual({ code: 1008, reason: "connection_lost" });
      expect(current.messages.some((event) => event.type === "ready")).toBe(false);
    } finally {
      providerGreets = true;
      current.session.abort();
      await current.session.settled();
    }
  });
  test("provider backpressure aborts instead of growing the model socket queue", async () => {
    const current = setup({
      webSocket(url) {
        const socket = new WebSocket(url);
        Object.defineProperty(socket, "bufferedAmount", { get: () => LIVE_DICTATION_PROVIDER_BUFFER_BYTES + 1 });
        return socket;
      },
    });
    await current.start();
    await current.session.settled();
    expect(current.messages.at(-1)?.code).toBe("overloaded");
    expect(current.session.signal.aborted).toBe(true);
  });
  test("model connection gets five seconds after slow reservation, accounting and credential reads", async () => {
    const current = setup();
    const reserve = current.options.limits!.reserve.bind(current.options.limits!);
    const begin = current.options.accounting!.begin.bind(current.options.accounting!);
    const reserved = spyOn(current.options.limits!, "reserve").mockImplementation(async (input) => {
      await current.clock.advance(6000);
      return reserve(input);
    });
    const begun = spyOn(current.options.accounting!, "begin").mockImplementation(async (...args) => {
      await current.clock.advance(6000);
      return begin(...args);
    });
    credentialRead.mockImplementation(async () => {
      await current.clock.advance(6000);
      return null;
    });
    try {
      await current.start();
      expect(current.clock.now()).toBe(Date.parse("2026-11-01T12:00:18Z"));
      expect(current.messages.some((event) => event.type === "error")).toBe(false);
    } finally {
      current.session.abort();
      await current.session.settled();
      reserved.mockRestore();
      begun.mockRestore();
      credentialRead.mockResolvedValue(null);
    }
  });
  test("failed access revalidation and a lost lease abort the stream", async () => {
    const denied = setup({ revalidate: async () => false });
    await denied.start();
    await denied.clock.advance(30_000);
    await denied.session.settled();
    expect(denied.messages.at(-1)?.code).toBe("no_access");
    expect(denied.session.signal.aborted).toBe(true);
    const lost = setup();
    await lost.start();
    await redis.del(`${lost.namespace}:person:${lost.options.userId}`);
    await lost.clock.advance(5000);
    await lost.session.settled();
    expect(lost.messages.at(-1)?.code).toBe("connection_lost");
  });
  for (const failure of ["authentication", "settings", "model access"] as const) {
    test(`a transient ${failure} error in the real revalidation probe is retryable`, async () => {
      const current = setup();
      const user = buildProjectedUser({ id: current.options.userId, uid: "dictation-test", provider: "local", profile: "user" });
      const authenticated = spyOn(browserSession, "authenticateRequest").mockResolvedValue({
        user,
        data: { userId: user.id, sid: "test", authEpoch: 0, expiresAt: "2099-01-01T00:00:00Z", kind: "web" },
      });
      const read = spyOn(aiSettings, "readAiSettingsState");
      const access = spyOn(aiModelAccess, "assertAllowed");
      const probe = new Hono<AuthContext>().get("*", (c) => {
        current.options.revalidate = createLiveDictationRevalidator(c, profile.id, user.id);
        return c.body(null, 204);
      });
      try {
        await probe.request("/api/ai/dictation/live", { headers: { cookie: "session_token=test" } });
        if (failure === "authentication") authenticated.mockRejectedValue(new Error("Temporary authentication failure"));
        else if (failure === "settings") read.mockRejectedValue(new Error("Temporary settings failure"));
        else {
          const state = await aiSettings.readAiSettingsState();
          read.mockResolvedValue({
            ...state,
            enabled: true,
            profiles: [profile],
            assignments: state.assignments.map((row) => (row.slot === "liveAudio" ? { ...row, variantId: profile.id } : row)),
          });
          access.mockRejectedValue(new Error("Temporary model access failure"));
        }
        await current.start();
        await current.clock.advance(30_000);
        await current.session.settled();
        expect(current.messages.at(-1)).toEqual({ type: "error", code: "connection_lost", retryable: true });
      } finally {
        current.session.abort();
        await current.session.settled();
        authenticated.mockRestore();
        read.mockRestore();
        access.mockRestore();
      }
    });
  }
  test("two silent minutes stop; finalization is bounded to five seconds", async () => {
    finishProvider = false;
    try {
      const current = setup();
      await current.start();
      await current.clock.advance(120_000);
      expect(current.messages.at(-1)?.type).toBe("finishing");
      current.session.receive(voiced());
      current.session.receive('{"type":"stop"}');
      expect(current.messages.at(-1)?.type).toBe("finishing");
      await current.clock.advance(5000);
      await current.session.settled();
      expect(current.messages.at(-1)).toEqual({ type: "done", text: "", audioMs: 0, reason: "silence" });
    } finally {
      finishProvider = true;
    }
  });
  test("max duration warns from minute nine and stops after ten minutes", async () => {
    finishProvider = false;
    try {
      const current = setup();
      await current.start();
      for (let minute = 0; minute < 10; minute++) {
        current.session.receive(voiced());
        await current.clock.advance(60_000);
      }
      expect(current.messages.filter((event) => event.type === "warning")).toEqual([{ type: "warning", code: "time_left", ms: 60000 }]);
      expect(current.messages.at(-1)?.type).toBe("finishing");
      await current.clock.advance(5000);
      await current.session.settled();
      expect(current.messages.at(-1)?.reason).toBe("max_duration");
    } finally {
      finishProvider = true;
    }
  });
  test("the daily allowance is checked on the first five-second charge", async () => {
    const current = setup({ minutesPerDay: 1 });
    const day = liveDictationDay(current.clock.now(), current.options.timeZone).day;
    await redis.set(`${current.namespace}:day:${current.options.userId}:${day}`, "55");
    await current.start();
    await current.clock.advance(5000);
    await current.session.settled();
    expect(current.messages.at(-1)).toMatchObject({ type: "done", reason: "daily_limit" });
  });
  test("quota migration upgrades the old kind constraint once and preserves the current one", async () => {
    await sql`ALTER TABLE ai.inference_calls DROP CONSTRAINT inference_calls_kind_check`;
    await sql`ALTER TABLE ai.inference_calls ADD CONSTRAINT inference_calls_kind_check CHECK(kind IN ('chat','background'))`;
    await migrateAiQuotas();
    const read = () => sql<{ oid: number; definition: string }[]>`SELECT oid::int,pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='ai.inference_calls'::regclass AND conname='inference_calls_kind_check'`;
    const before = await read();
    expect(before[0]?.definition).toContain("live-transcription");
    await migrateAiQuotas();
    expect(await read()).toEqual(before);
  });
  test("daily allowance stops a live session, blocks another start, and resets at local midnight", async () => {
    finishProvider = false;
    try {
      const current = setup({ minutesPerDay: 1 });
      await current.start();
      current.session.receive(voiced());
      await current.clock.advance(60_000);
      expect(current.messages.at(-1)?.type).toBe("finishing");
      await current.clock.advance(5000);
      await current.session.settled();
      expect(current.messages.at(-1)?.reason).toBe("daily_limit");
      const next = setup({ userId: current.options.userId, limits: current.options.limits, minutesPerDay: 1 });
      await next.start();
      expect(next.messages.at(-1)?.code).toBe("daily_limit");
      expect(next.messages.at(-1)?.resetsAt).toBe("2026-11-01T23:00:00.000Z");
      const newDay = setup({ userId: current.options.userId, limits: current.options.limits, minutesPerDay: 1 });
      newDay.clock.time = Date.parse("2026-11-01T23:00:00Z");
      await newDay.start();
      expect(newDay.messages.at(-1)?.type).toBe("ready");
      newDay.session.abort();
      await newDay.session.settled();
      expect(liveDictationDay(Date.parse("2026-03-29T00:00:00Z"), "Europe/Berlin").resetsAt).toBe(Date.parse("2026-03-29T22:00:00Z"));
    } finally {
      finishProvider = true;
    }
  });
  test("real accounting persists metadata, excludes chat quotas, and groups minutes by person and app", async () => {
    const userId = crypto.randomUUID();
    await sql`INSERT INTO auth.users(id,uid,provider,profile,display_name) VALUES(${userId}::uuid,${userId},'local','user','Live test')`;
    const before = await sql<
      { files: number; conversations: number; messages: number }[]
    >`SELECT (SELECT count(*)::int FROM ai.files) AS files,(SELECT count(*)::int FROM ai.conversations) AS conversations,(SELECT count(*)::int FROM ai.messages) AS messages`;
    const current = setup({ userId, accounting: undefined });
    try {
      await current.start();
      const [running] = await sql<{ leaseSeconds: number }[]>`
        SELECT extract(epoch FROM (lease_expires_at-started_at))::float8 AS "leaseSeconds"
        FROM ai.inference_calls WHERE user_id=${userId}::uuid`;
      // Ten minutes of audio, plus five seconds each for connection and finalization.
      expect(running!.leaseSeconds).toBeGreaterThan(609);
      current.session.receive(voiced());
      await until(() => current.messages.some((event) => event.type === "delta"));
      current.session.receive('{"type":"stop"}');
      await current.session.settled();
      const [call] = await sql<
        { kind: string; audio_ms: number; cost: string | null }[]
      >`SELECT kind,audio_ms,cost::text FROM ai.inference_calls WHERE user_id=${userId}::uuid`;
      expect(call).toMatchObject({ kind: "live-transcription", audio_ms: 100, cost: null });
      const [run] = await sql<
        { mode: string; audio_ms: number; error: string | null }[]
      >`SELECT mode,audio_ms,error FROM ai.structured_runs WHERE user_id=${userId}::uuid`;
      expect(run).toEqual({ mode: "live-transcription", audio_ms: 100, error: null });
      const after =
        await sql`SELECT (SELECT count(*)::int FROM ai.files) AS files,(SELECT count(*)::int FROM ai.conversations) AS conversations,(SELECT count(*)::int FROM ai.messages) AS messages`;
      expect(after).toEqual(before);
      const report = await aiUsage.report("24h", { userId });
      expect(report.chat.runs).toBe(0);
      expect(report.background.runs).toBe(0);
      expect(report.timeline.every((point) => point.turns === 0)).toBe(true);
      expect(report.users.items[0]?.dictationMinutes).toBeCloseTo(100 / 60000);
      expect(report.apps.items.find((row) => row.id === "notebooks")?.dictationMinutes).toBeCloseTo(100 / 60000);
      const discarded = setup({ userId, accounting: undefined });
      await discarded.start();
      discarded.session.abort();
      await discarded.session.settled();
      const calls = await sql`SELECT status,cancelled,error_code FROM ai.inference_calls WHERE user_id=${userId}::uuid ORDER BY started_at`;
      expect(calls).toEqual([
        { status: "ok", cancelled: false, error_code: null },
        { status: "ok", cancelled: true, error_code: null },
      ]);
      const runs = await sql`SELECT status,error_code FROM ai.structured_runs WHERE user_id=${userId}::uuid`;
      expect(runs).toEqual([
        { status: "ok", error_code: null },
        { status: "ok", error_code: null },
      ]);
    } finally {
      await sql`DELETE FROM ai.inference_calls WHERE user_id=${userId}::uuid`;
      await sql`DELETE FROM ai.structured_runs WHERE user_id=${userId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });
});
