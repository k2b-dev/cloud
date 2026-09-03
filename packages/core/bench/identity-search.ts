import { spyOn } from "bun:test";
import assert from "node:assert/strict";
import { connect, createServer, type Socket } from "node:net";
import { cpus, loadavg } from "node:os";
import { Hono } from "hono";
import { benchmarkConfiguration } from "./configuration";
import { compare, summary } from "./statistics";

// Run through scripts/bench-identity.ts. The default SQL handle connects to a
// real, metered, disposable PostgreSQL database. Authentication is not mocked.
const source = new URL(process.env.DATABASE_URL!);
assert.match(source.pathname, /^\/cloud_identity_bench_[a-z0-9]+$/);
assert(["localhost", "127.0.0.1"].includes(source.hostname));
const configuration = benchmarkConfiguration(process.env);
const samplesPerMode = configuration.samples;
const metered = configuration.mode !== "direct-postgres";
const warmup = 20;
const latencyMs = 5;
const startingLoad = loadavg();
type Counts = Record<string, number>;
let counts: Counts = {};
const increment = (name: string) => {
  counts[name] = (counts[name] ?? 0) + 1;
};

// Observe actual frontend Execute/Query messages, including BEGIN and COMMIT.
// Keep only statement categories, never parameter values, credentials or SQL text.
const category = (query: string): string => {
  const sql = query.trim().toLowerCase();
  if (/^(begin|commit|rollback)\b/.test(sql)) return `pg.${sql.split(/\s/)[0]}`;
  if (sql.includes("set_config('statement_timeout'")) return "pg.timeout";
  if (sql.includes("from auth.session_families")) return "pg.session_actor";
  if (sql.includes("from auth.signing_keys")) return "pg.key";
  if (sql.includes("auth.mandates")) return "pg.mandate";
  if (sql.includes("from auth.users u")) return "pg.user_actor";
  if (sql.includes("settings.entries")) return "pg.settings";
  if (sql.startsWith("insert into logging.entries")) return "pg.logging";
  return "pg.other";
};
const sockets = new Set<Socket>();
const proxy = createServer((client) => {
  const upstream = connect(Number(source.port || 5432), source.hostname);
  sockets.add(client);
  sockets.add(upstream);
  client.setNoDelay(true);
  upstream.setNoDelay(true);
  let pending = Buffer.alloc(0);
  let startup = true;
  const statements = new Map<string, string>();
  const portals = new Map<string, string>();
  client.on("data", (chunk) => {
    assert(Buffer.isBuffer(chunk));
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= (startup ? 4 : 5)) {
      const header = startup ? 0 : 1;
      const length = pending.readInt32BE(header);
      assert(length >= 4 && length <= 16 * 1024 * 1024, "Unexpected benchmark PostgreSQL frame");
      if (pending.length < header + length) break;
      const type = startup ? "startup" : String.fromCharCode(pending[0]!);
      const body = pending.subarray(header + 4, header + length);
      pending = pending.subarray(header + length);
      if (startup) {
        assert.notEqual(body.readInt32BE(0), 80877103, "Benchmark PostgreSQL transport must be plaintext loopback");
        startup = false;
      } else if (type === "P" || type === "B") {
        const firstEnd = body.indexOf(0);
        const first = body.toString("utf8", 0, firstEnd);
        const second = body.toString("utf8", firstEnd + 1, body.indexOf(0, firstEnd + 1));
        if (type === "P") statements.set(first, category(second));
        else portals.set(first, statements.get(second) ?? "pg.unknown");
      } else if (type === "E") {
        increment(portals.get(body.toString("utf8", 0, body.indexOf(0))) ?? "pg.unknown");
      } else if (type === "Q") increment(category(body.toString("utf8", 0, body.length - 1)));
    }
  });
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.on("close", () => {
    sockets.delete(client);
    upstream.destroy();
  });
  upstream.on("close", () => {
    sockets.delete(upstream);
    client.destroy();
  });
  client.pipe(upstream);
  upstream.pipe(client);
});
await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const address = proxy.address();
assert(address && typeof address !== "string");
const meteredUrl = new URL(source);
meteredUrl.hostname = "127.0.0.1";
meteredUrl.port = String(address.port);
process.env.DATABASE_URL = metered ? meteredUrl.href : source.href;
const { sql, SQL, redis, RedisClient } = await import("bun");
const telemetry = new RedisClient(process.env.REDIS_URL!);
const redisSnapshot = async (): Promise<Counts> => {
  const raw = String(await telemetry.send("INFO", ["commandstats"]));
  return Object.fromEntries(
    [...raw.matchAll(/^cmdstat_([^:]+):calls=(\d+)/gm)]
      .filter((match) => match[1] !== "info")
      .map((match) => [match[1]!, Number(match[2])]),
  );
};
await sql`SELECT 1`;
assert.equal(counts["pg.other"] ?? 0, metered ? 1 : 0, "The real default SQL handle must use the selected transport");
// Maintainer-only harness: exercise the actual internal router, not a new public API.
const { createSearchRoutes } = await import("../../cloud/src/api/search");
const { auth } = await import("@valentinkolb/cloud/server");
const { createProviderFixture, ProviderStats, providerResult } = await import("./provider-fixture");
const identity = await import("@valentinkolb/cloud/services/identity");
const { session } = await import("@valentinkolb/cloud/services/session");
const { compileCapabilityManifest } = await import("@valentinkolb/cloud/capabilities/testing");
const { defineCapabilities, UniversalSearchInputSchema, UniversalSearchDataSchema } = await import("@valentinkolb/cloud/contracts");
const { createLocalJWKSet } = await import("jose");
const { getIdentityRuntimeConfig, invalidateIdentityRuntimeConfig } = await import("@valentinkolb/cloud/services/identity/runtime-config");

const rawGet = redis.get.bind(redis);
const getSpy = spyOn(redis, "get").mockImplementation((key) => {
  increment(String(key).startsWith("session:") ? "redis.session_get" : "redis.other_get");
  return rawGet(key);
});
const rawSend = redis.send.bind(redis);
const sendSpy = spyOn(redis, "send").mockImplementation((command, args) => {
  increment(`redis.${command.toLowerCase()}`);
  return rawSend(command, args);
});
const issuer = "https://identity-bench.example";
let jwksReads = 0;
let sessionKeys: Awaited<ReturnType<typeof identity.listIdentityJwks>>;
let invocationKeys: Awaited<ReturnType<typeof identity.listIdentityJwks>>;
const jwks = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => {
    jwksReads += 1;
    return Response.json(new URL(request.url).pathname.includes("session") ? sessionKeys : invocationKeys);
  },
});
process.env.CLOUD_IDENTITY_JWKS_ORIGIN = jwks.url.origin;
const localProvider = configuration.topology === "shared" ? createProviderFixture(false) : undefined;
const providerServer = localProvider ? Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: localProvider.fetch }) : undefined;
let providerOrigin = providerServer?.url.origin;
let providerPid = process.pid;
let providerChild: ReturnType<typeof Bun.spawn> | undefined;
const providerControl = async (path: string, body?: unknown) => {
  assert(providerOrigin);
  const response = await fetch(new URL("/_bench/" + path, providerOrigin), {
    method: path === "stats" ? "GET" : "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 200, "Provider control failed");
  return response.json();
};
let activeRoutes: ReturnType<typeof createSearchRoutes> | undefined;
const coreServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => (activeRoutes ? activeRoutes.fetch(request) : new Response(null, { status: 503 })),
});

const records: { passes: boolean }[] = [];
let failedRequest: Record<string, unknown> | undefined;
let guardFailureProbe: Record<string, unknown> | undefined;
let completeReportWritten = false;
let cacheWarmups = 0;
let lastCacheWarmup = 0;
const warmCaches = async () => {
  // Explicit warm-cache experiment. Refresh before the 60s production TTL, not
  // inside a timed request; no measured sample is discarded or retried.
  if (performance.now() - lastCacheWarmup < 30_000 && cacheWarmups > 0) return;
  invalidateIdentityRuntimeConfig();
  identity.invalidateIdentitySignerCache("invocation");
  await getIdentityRuntimeConfig();
  await identity.prepareIdentitySigner("invocation");
  await providerControl("warm");
  lastCacheWarmup = performance.now();
  cacheWarmups += 1;
};
try {
  if (configuration.topology === "split") {
    const ready = Promise.withResolvers<void>();
    providerChild = Bun.spawn([process.execPath, "bench/provider-process.ts"], {
      env: {
        ...process.env,
        APP_ID: "bench-provider",
        CLOUD_IDENTITY_KEY_ENCRYPTION_KEY: "",
        CLOUD_IDENTITY_PREVIOUS_KEY: "",
        CLOUD_IDENTITY_NEXT_KEY: "",
      },
      stdout: "inherit",
      stderr: "inherit",
      ipc(message: unknown) {
        if (
          message &&
          typeof message === "object" &&
          "url" in message &&
          typeof message.url === "string" &&
          "pid" in message &&
          typeof message.pid === "number"
        ) {
          const url = new URL(message.url);
          assert.equal(url.hostname, "127.0.0.1");
          assert.notEqual(message.pid, process.pid);
          providerOrigin = url.origin;
          providerPid = message.pid;
          ready.resolve();
        }
      },
    });
    const startupTimeout = setTimeout(() => ready.reject(new Error("Provider process did not become ready")), 15_000);
    void providerChild.exited.then((code) => ready.reject(new Error("Provider process exited: " + code)));
    try {
      await ready.promise;
    } finally {
      clearTimeout(startupTimeout);
    }
  }
  for (const name of ["auth", "audit", "settings", "logging"]) await (await import(`../src/migrate/core/${name}.ts`)).migrate();
  // These cache entries belong exclusively to the disposable Redis process.
  await redis.set("settings:app.url", JSON.stringify(issuer));
  await redis.set("settings:freeipa.groups.admin", JSON.stringify(["admins"]));
  await redis.set("settings:user.session.expiry_hours", "24");
  const [user] = await sql<
    { id: string }[]
  >`INSERT INTO auth.users (uid, provider, profile) VALUES ('benchmark-user', 'local', 'user') RETURNING id`;
  assert(user);
  const login = new Hono().get("/", async (c) => c.json({ token: await session.create(c, user.id) }));
  const tokenFor = async (mode: "legacy" | "jwt") => {
    process.env.CLOUD_SESSION_ISSUANCE_MODE = mode;
    const response = await login.request("http://bench.test/");
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(typeof data.token, "string");
    return String(data.token);
  };
  const credentials = { legacy: await tokenFor("legacy"), jwt: await tokenFor("jwt") };
  await identity.prepareIdentitySigner("invocation");
  sessionKeys = await identity.listIdentityJwks("session");
  invocationKeys = await identity.listIdentityJwks("invocation");
  const definitions = defineCapabilities({
    protocolVersion: 1,
    types: { item: { title: "Item", description: "A benchmark item." } },
    queries: {
      search: {
        title: "Search",
        description: "Search benchmark items.",
        input: UniversalSearchInputSchema,
        data: UniversalSearchDataSchema,
        openWorld: false,
        universalSearch: { tags: [{ tag: "item", title: "Items", description: "Benchmark items." }] },
        run: async () => ({ ok: true as const, data: { data: [] } }),
      },
    },
  });

  for (const phase of ["dispatcher", "end-to-end"] as const) {
    for (const providerCount of [1, 8, 30]) {
      const entries = Array.from({ length: providerCount }, (_, index) => {
        const appId = `bench-${index}`;
        return {
          appId,
          appName: appId,
          appIcon: "ti ti-box",
          appDescription: "Benchmark",
          endpoint: `${providerOrigin}/${appId}/api/_internal/capabilities/v1`,
          manifest: compileCapabilityManifest(appId, definitions),
        };
      });
      let active = 0;
      let peak = 0;
      let targetCalls = 0;
      let stages = { authentication: 0, guardedSigning: 0, signingBatch: 0, targetVerification: 0, targetActor: 0 };
      let signerFailure: { name: string; code?: string } | undefined;
      let guardFinished = Promise.resolve();
      const authenticate = auth.requireRole("authenticated");
      await providerControl("configure", {
        userId: user.id,
        latencyMs,
        targets: entries.map((entry) => ({ appId: entry.appId, schemaHash: entry.manifest.queries[0]!.schemaHash })),
      });
      activeRoutes = createSearchRoutes({
        authenticate: async (c, next) => {
          const start = performance.now();
          await authenticate(c, async () => {
            stages.authentication = performance.now() - start;
            await next();
          });
        },
        withActiveSigner: async (purpose, callback, options) => {
          const start = performance.now();
          const finished = Promise.withResolvers<void>();
          guardFinished = finished.promise;
          try {
            return await identity.withActiveIdentitySigner(
              purpose,
              async (signer, db) => {
                const signingStart = performance.now();
                try {
                  return await callback(signer, db);
                } finally {
                  stages.signingBatch = performance.now() - signingStart;
                }
              },
              options,
            );
          } catch (error) {
            // Keep error classification, not messages/SQL that could contain credentials.
            const code = error instanceof Error && "code" in error ? error.code : undefined;
            signerFailure = {
              name: error instanceof Error ? error.name : "UnknownError",
              ...(typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? { code } : {}),
            };
            throw error;
          } finally {
            stages.guardedSigning = performance.now() - start;
            finished.resolve();
          }
        },
        listCapabilities: async () => entries,
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          targetCalls += 1;
          active += 1;
          peak = Math.max(peak, active);
          try {
            if (phase === "dispatcher") return Response.json(providerResult(new URL(request.url).pathname.split("/")[1]!));
            const response = await fetch(request);
            assert.equal(response.status, 200);
            return response;
          } finally {
            active -= 1;
          }
        },
      });
      const once = async (mode: "legacy" | "jwt", measured: boolean) => {
        await warmCaches();
        process.env.CLOUD_INVOCATION_ISSUANCE_MODE = mode;
        stages = { authentication: 0, guardedSigning: 0, signingBatch: 0, targetVerification: 0, targetActor: 0 };
        signerFailure = undefined;
        await providerControl("reset");
        counts = {};
        targetCalls = 0;
        peak = 0;
        const oldJwks = jwksReads;
        const oldRedis = measured ? await redisSnapshot() : {};
        const start = performance.now();
        const response = await fetch(new URL("/search?q=needle", coreServer.url), {
          headers: { cookie: `session_token=${credentials[mode]}` },
        });
        const body = await response.json();
        const elapsed = performance.now() - start;
        const providerStats = ProviderStats.parse(await providerControl("stats"));
        stages.targetVerification = providerStats.targetVerification;
        stages.targetActor = providerStats.targetActor;
        for (const [key, value] of Object.entries(providerStats.redis)) counts[key] = (counts[key] ?? 0) + value;
        if (response.status !== 200) {
          failedRequest = {
            phase,
            providers: providerCount,
            mode,
            measured,
            status: response.status,
            elapsedMs: elapsed,
            stages,
            counts,
            signerFailure,
          };
        }
        assert.equal(response.status, 200);
        assert.equal(providerStats.requests, phase === "end-to-end" ? providerCount : 0);
        assert.equal(body.apps.length, providerCount);
        assert.equal(body.count, providerCount, "Every provider must produce a validated, merged result");
        assert.equal(new Set(body.items.map((item: { appId: string }) => item.appId)).size, providerCount);
        assert.equal(targetCalls, providerCount);
        assert(peak <= 8);
        if (measured) {
          const targetCount = phase === "end-to-end" ? providerCount : 0;
          const expected =
            mode === "jwt"
              ? {
                  "pg.session_actor": 1,
                  "pg.begin": 1,
                  "pg.timeout": 1,
                  "pg.key": 1,
                  "pg.commit": 1,
                  ...(targetCount ? { "pg.user_actor": targetCount } : {}),
                }
              : { "pg.user_actor": 1 + targetCount, "redis.session_get": (1 + targetCount) * 2 };
          const { "pg.logging": _logging, ...identityIo } = counts;
          const observed = metered ? expected : Object.fromEntries(Object.entries(expected).filter(([key]) => !key.startsWith("pg.")));
          assert.deepEqual(identityIo, observed, `Unexpected ${mode}/${phase}/${providerCount} hot-path I/O`);
          assert.equal(jwksReads - oldJwks, 0, "Warm verification must not fetch JWKS");
          const newRedis = await redisSnapshot();
          const delta = Object.fromEntries(
            Object.entries(newRedis)
              .map(([key, value]) => [key, value - (oldRedis[key] ?? 0)])
              .filter(([, value]) => value !== 0),
          );
          assert.deepEqual(
            delta,
            mode === "jwt" ? {} : { get: (1 + targetCount) * 2 },
            "Redis server command counters must agree, including commands not observed by client spies",
          );
        }
        const { "pg.logging": loggingWrites = 0, ...identityIo } = counts;
        return { elapsed, io: identityIo, stages, loggingWrites };
      };
      for (let i = 0; i < warmup; i += 1) {
        await once("legacy", false);
        await once("jwt", false);
      }
      const values = { legacy: [] as number[], jwt: [] as number[] };
      const stageValues = {
        legacy: {
          authentication: [] as number[],
          guardedSigning: [] as number[],
          signingBatch: [] as number[],
          targetVerification: [] as number[],
          targetActor: [] as number[],
        },
        jwt: {
          authentication: [] as number[],
          guardedSigning: [] as number[],
          signingBatch: [] as number[],
          targetVerification: [] as number[],
          targetActor: [] as number[],
        },
      };
      let legacyIo: Counts = {};
      let jwtIo: Counts = {};
      const loggingWrites = { legacy: 0, jwt: 0 };
      for (let i = 0; i < samplesPerMode; i += 1) {
        const order = i % 2 === 0 ? (["legacy", "jwt"] as const) : (["jwt", "legacy"] as const);
        for (const mode of order) {
          const result = await once(mode, true);
          values[mode].push(result.elapsed);
          loggingWrites[mode] += result.loggingWrites;
          for (const key of ["authentication", "guardedSigning", "signingBatch", "targetVerification", "targetActor"] as const)
            stageValues[mode][key].push(result.stages[key]);
          if (mode === "jwt") jwtIo = result.io;
          else legacyIo = result.io;
        }
      }
      const record = {
        phase,
        providers: providerCount,
        controlledProviderLatencyMs: phase === "dispatcher" ? 0 : latencyMs,
        ...compare(values.legacy, values.jwt),
        ioPerRequest: { legacy: legacyIo, jwt: jwtIo },
        asynchronousLogWritesDuringMeasurements: loggingWrites,
        rawMs: values,
        stages: Object.fromEntries(
          Object.entries(stageValues).map(([mode, values]) => [
            mode,
            Object.fromEntries(Object.entries(values).map(([name, samples]) => [name, summary(samples)])),
          ]),
        ),
      };
      records.push(record);
      await Bun.write(process.env.IDENTITY_BENCH_REPORT!, JSON.stringify({ completed: false, records }, null, 2));
      const { rawMs: _raw, ...display } = record;
      console.log(JSON.stringify(display));
      if (phase === "end-to-end" && providerCount === 30) {
        // Correctness probe, not a latency sample: a real conflicting key lock
        // must fail closed at the unchanged signing deadline and then recover.
        await warmCaches();
        const signer = await identity.prepareIdentitySigner("invocation");
        const locker = new SQL(source, { max: 1 });
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const held = locker.begin(async (db) => {
          await db`SELECT kid FROM auth.signing_keys WHERE kid = ${signer.kid} FOR UPDATE`;
          entered.resolve();
          await release.promise;
        });
        void held.catch(entered.reject);
        try {
          await entered.promise;
          process.env.CLOUD_INVOCATION_ISSUANCE_MODE = "jwt";
          targetCalls = 0;
          signerFailure = undefined;
          const start = performance.now();
          const response = await fetch(new URL("/search?q=needle", coreServer.url), {
            headers: { cookie: `session_token=${credentials.jwt}` },
            signal: AbortSignal.timeout(8_000),
          });
          await response.arrayBuffer();
          guardFailureProbe = { status: response.status, elapsedMs: performance.now() - start, targetCalls, signerFailure };
          assert.equal(response.status, 503);
          assert.equal(targetCalls, 0, "A blocked signing key must never dispatch providers");
        } finally {
          release.resolve();
          await held;
          await locker.close();
        }
        // The HTTP deadline may win before SQL rollback completes.
        await guardFinished;
        guardFailureProbe.signerFailure = signerFailure;
        // Includes the normal exact I/O and provider-completeness assertions.
        await once("jwt", true);
        guardFailureProbe.recovered = true;
        console.log("Signing guard fault/recovery probe passed");
      }
    }
  }
  const signer = await identity.prepareIdentitySigner("invocation");
  const micro = { sign: [] as number[], verify: [] as number[] };
  const key = createLocalJWKSet(invocationKeys);
  const runtime = await getIdentityRuntimeConfig();
  for (let i = 0; i < 220; i += 1) {
    const start = performance.now();
    const signed = await identity.signInvocationToken({
      targetAppId: "bench-0",
      callingAppId: "core",
      operation: "search.query",
      schemaHash: "a".repeat(64),
      authority: {
        sub: user.id,
        principal_type: "user",
        access_subject_type: "user",
        access_subject_id: user.id,
        credential_kind: "session",
        scopes: [],
      },
      signer,
      issuer: runtime.issuer,
    });
    const signedAt = performance.now();
    assert(
      await identity.verifyInvocationToken(
        signed.token,
        { targetAppId: "bench-0", operation: "search.query", schemaHash: "a".repeat(64) },
        { issuer, key },
      ),
    );
    if (i >= 20) {
      micro.sign.push(signedAt - start);
      micro.verify.push(performance.now() - signedAt);
    }
  }
  const report = {
    completed: true,
    passes: configuration.acceptanceEligible && records.every((record) => record.passes),
    configuration,
    postgresMetered: metered,
    processes: { core: process.pid, provider: providerPid },
    guardFailureProbe,
    measuredAt: new Date().toISOString(),
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    loadAverage: { start: startingLoad, end: loadavg() },
    postgres: (await sql`SELECT version()`)[0].version,
    warmup,
    samplesPerMode,
    cacheWarmups,
    cachePolicy:
      "Refresh real config/signer caches every 30s outside timings; cache refresh and cold-start latency are not part of this warm-cache gate",
    pool: "Bun default SQL pool",
    baseline: "Current dual-read legacy session and credential-forwarding branch, same router/fixtures; not an archived binary",
    transport: `Real loopback HTTP to Core and providers (${configuration.topology} processes), real PostgreSQL ${metered ? "through protocol meter" : "direct (diagnostic only)"}, isolated Redis, warmed HTTP JWKS; dispatcher phase stubs provider work only; fixed in-memory discovery`,
    acceptance: "Each phase/provider combination: JWT p95 - legacy p95 <= max(legacy p95 * 0.1, 10ms)",
    redisInstrumentation:
      "Client GET/send observers cross-checked against isolated Redis INFO commandstats outside every timed request; only telemetry INFO commands excluded",
    micro: { signing: summary(micro.sign), verification: summary(micro.verify) },
    records,
  };
  await Bun.write(process.env.IDENTITY_BENCH_REPORT!, JSON.stringify(report, null, 2));
  completeReportWritten = true;
  assert(
    !configuration.acceptanceEligible || records.every((record) => record.passes),
    "p95 acceptance failed; retain the report and investigate without loosening the gate",
  );
} catch (error) {
  if (!completeReportWritten)
    await Bun.write(
      process.env.IDENTITY_BENCH_REPORT!,
      JSON.stringify(
        { completed: false, passes: false, error: error instanceof Error ? error.message : String(error), failedRequest, records },
        null,
        2,
      ),
    );
  throw error;
} finally {
  getSpy.mockRestore();
  sendSpy.mockRestore();
  await coreServer.stop(true);
  await providerServer?.stop(true);
  localProvider?.dispose();
  if (providerChild) {
    providerChild.kill();
    await providerChild.exited;
  }
  await sql.close({ timeout: 5 });
  redis.close();
  telemetry.close();
  await jwks.stop(true);
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
}
