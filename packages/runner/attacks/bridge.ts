// Dedicated CI entry: intentionally outside the ordinary *.test.ts discovery.
// Run: bun --no-env-file test ./packages/runner/attacks/bridge.ts
import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { chmod, mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { APP_KEY_FIXTURES } from "../../../scripts/fixtures/app-key-fixtures";
import { suiteFor, useFreshDatabase } from "../../../scripts/fixtures/test-infra";
import { createCodeRunnerCallRoutes } from "../../cloud/src/api/capabilities";
import { type AppKey, formatAppKey } from "../../cloud/src/app-key";
import { compileCapabilityManifest } from "../../cloud/src/capabilities/testing";
import { type CodeRunTokenInput, signCodeRunToken } from "../../cloud/src/code/run-token";
import { RUNNER_PATHS, RunnerCompleteRequestSchema, type RunnerLease } from "../../cloud/src/code/runner-protocol";
import type { CodeCheckedVersionManifest } from "../../cloud/src/contracts";
import type { CapabilityRegistryEntry } from "../../cloud/src/contracts/registry";
import { sql } from "../../cloud/src/runtime/clients";
import { appKeys } from "../../cloud/src/services/app-keys";
import { createCodeBridgeHost } from "../../core/src/code/bridge";
import { CODE_SETTINGS, codeSettings } from "../../core/src/code/settings";
import { codeBundleHash, codeSourceHash } from "../../core/src/code/store";
import { migrateAppKeys } from "../../core/src/migrate/core/app-keys";
import { migrate as migrateAudit } from "../../core/src/migrate/core/audit";
import { migrate as migrateAuth } from "../../core/src/migrate/core/auth";
import { migrate as migrateCode } from "../../core/src/migrate/core/code";
import { migrate as migratePolicy } from "../../core/src/migrate/core/code-policy";
import { migrate as migrateScheduling } from "../../core/src/migrate/core/code-scheduling";
import { migrate as migrateSettings } from "../../core/src/migrate/core/settings";
import { config } from "../test/fixtures";

const NOW = Date.UTC(2030, 0, 2);
const now = new Date(NOW);
const issuer = "https://cloud.example";
const userId = "11111111-1111-4111-8111-111111111111";
const kid = "22222222-2222-4222-8222-222222222222";
const operation = {
  title: "Attack fixture",
  description: "Must never execute.",
  input: z.object({}).strict(),
  data: z.object({}).strict(),
  openWorld: false,
  run: () => {
    throw new Error("attack_reached_provider");
  },
};
const entry: CapabilityRegistryEntry = {
  appId: "example",
  appName: "Example",
  appDescription: "Public attack fixture",
  appIcon: "ti ti-folder",
  endpoint: "http://127.0.0.1:1/must-never-execute",
  manifest: compileCapabilityManifest("example", {
    protocolVersion: 2,
    types: {},
    queries: { stream: { ...operation, stream: { direction: "read", maxBytes: 1024, read: async () => new Response(null) } } },
    actions: {
      person: {
        ...operation,
        destructive: false,
        idempotency: "none",
        policy: { silent: "shared" },
        review: () => ({ ok: true, data: { message: "Fixture" } }),
        code: false,
      },
      access: {
        ...operation,
        destructive: false,
        idempotency: "none",
        policy: { silent: "shared" },
        review: () => ({ ok: true, data: { message: "Fixture" } }),
      },
    },
  }),
};
// Model live generated Code-access metadata, which applications cannot declare themselves.
entry.manifest.actions.find((action) => action.localId === "access")!.localId = "code.access.set";

async function docker(...args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (exit !== 0) throw new Error(`docker ${args[0]} failed: ${stderr}`);
    return stdout.trim();
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

suiteFor("database", "valkey")("hostile bundles through the real image and Core bridge", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  let runner: AppKey;
  let signer: { kid: string; key: CryptoKey; signUntil: Date };
  let key: JWTVerifyGetKey;
  let directory: string;
  let settings: ReturnType<typeof spyOn<typeof codeSettings, "get">>;
  let rate = 1000;
  beforeAll(async () => {
    setSystemTime(now);
    await docker("image", "inspect", "cloud-runner:attacks");
    database = await useFreshDatabase("runner_attacks_c14");
    await migrateAuth();
    await migrateAudit();
    await migrateSettings();
    await migrateAppKeys();
    await migrateCode();
    await migrateScheduling();
    await migratePolicy();
    await sql`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES(${userId}::uuid,'attack-admin','local','user',true)`;
    const enrolled = await appKeys.register({
      actor: { id: userId, uid: "attack-admin", provider: "local", roles: ["admin"] },
      appId: "runner",
      publicKey: APP_KEY_FIXTURES[0].publicKey,
    });
    if (!enrolled.ok) throw new Error(enrolled.error.message);
    runner = { appId: "runner", seed: APP_KEY_FIXTURES[0].seed, ...enrolled.data };
    directory = await mkdtemp(join(tmpdir(), "code-c14-"));
    await Bun.write(join(directory, "key"), formatAppKey(runner));
    await chmod(join(directory, "key"), 0o600);
    const pair = await generateKeyPair("RS256", { extractable: true });
    signer = { kid, key: pair.privateKey, signUntil: new Date(NOW + 600_000) };
    key = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: "RS256", use: "sig", kid }] });
    settings = spyOn(codeSettings, "get").mockImplementation(async (name) =>
      name === "core.code.calls_per_second" ? rate : CODE_SETTINGS[name].default,
    );
  }, 30_000);
  afterAll(async () => {
    settings?.mockRestore();
    await database?.drop();
    if (directory) {
      await unlink(join(directory, "key"));
      await rmdir(directory);
    }
    setSystemTime();
  });

  async function execute(source: string, options: { stale?: boolean; forged?: boolean; drain?: boolean } = {}) {
    const codeId = `c_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const hash = codeBundleHash(source);
    const files = { "code.ts": source };
    const manifest: CodeCheckedVersionManifest = {
      version: 1,
      entry: "code.ts",
      entrypoints: [{ kind: "manual", entrypoint: "main", file: "code.ts", line: 1, cron: null }],
      hashes: { source: codeSourceHash(files, "code.ts"), bundle: hash, sdk: "a".repeat(64) },
      permissions: [],
      policyRows: [],
      ai: false,
    };
    await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title,state) VALUES(${codeId},'person',${userId}::uuid,'Attack fixture','active')`;
    const [version] = await sql<{ id: string }[]>`
      INSERT INTO code.versions(code_id,number,source_files,bundle,source_hash,bundle_hash,manifest,source_bytes,bundle_bytes,created_by)
      VALUES(${codeId},1,${JSON.stringify(files)}::jsonb,${source},${manifest.hashes.source},${hash},${JSON.stringify(manifest)}::jsonb,
      ${Buffer.byteLength(source)},${Buffer.byteLength(source)},${userId}::uuid) RETURNING id`;
    const [run] = await sql<{ id: string }[]>`
      INSERT INTO code.runs(code_id,version_id,trigger,entrypoint,state,started_at,lease_expires_at,generation,payload_bytes,calls_limit)
      VALUES(${codeId},${version!.id}::uuid,'manual','main','running',clock_timestamp(),clock_timestamp()+interval '1 minute',${options.stale ? 2 : 1},32768,200)
      RETURNING id`;
    const claims: CodeRunTokenInput = {
      codeId,
      versionId: version!.id,
      runId: run!.id,
      generation: 1,
      entrypoint: "main",
      bundleHash: hash,
      mandateId: "33333333-3333-4333-8333-333333333333",
      mandateRevision: 1,
    };
    const token = await signCodeRunToken(claims, { issuer, signer, now, deadlineAt: NOW + 10_000 });
    const lease: RunnerLease = {
      runId: claims.runId,
      codeId,
      versionId: claims.versionId,
      entrypoint: "main",
      generation: 1,
      mandateRevision: 1,
      bundleHash: hash,
      organizationId: codeId,
      trustTier: "approved",
      token: options.forged ? `${token.slice(0, -8)}forged00` : token,
      input: null,
      deadlineAt: NOW + (options.drain ? 1500 : 10_000),
      leaseExpiresAt: NOW + 15_000,
      heartbeatMs: 100,
    };
    // Lease cannot outlive its original deadline.
    lease.leaseExpiresAt = lease.deadlineAt;
    const complete = Promise.withResolvers<z.infer<typeof RunnerCompleteRequestSchema>>();
    const called = Promise.withResolvers<void>();
    let fetches = 0;
    let providerCalls = 0;
    const responses: { status: number; body: unknown }[] = [];
    const routes = createCodeRunnerCallRoutes({
      host: createCodeBridgeHost(), // Real Postgres fencing/observations and real Valkey limiter.
      token: { issuer, key, now },
      ownOrigins: async () => [issuer, "http://app-core:3000"],
      dispatch: {
        getCapability: async (appId) => (appId === "example" ? entry : null),
        fetch: async () => {
          providerCalls++;
          return new Response(null, { status: 500 });
        },
      },
    });
    const core = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (path === RUNNER_PATHS.call) {
          const result = await routes.fetch(request);
          responses.push({ status: result.status, body: await result.clone().json() });
          called.resolve();
          return result;
        }
        // Acquisition is a deterministic fixture. Calls use unmodified C4 auth,
        // signatures, run-token verification, C13 SQL fences and Valkey budgets.
        if (path === RUNNER_PATHS.config) return Response.json({ ...config, slots: 1 });
        if (path === RUNNER_PATHS.fetch) {
          if (++fetches === 1) return Response.json({ runs: [lease] });
          await new Promise<void>((done) => {
            if (request.signal.aborted) done();
            else request.signal.addEventListener("abort", () => done(), { once: true });
          });
          return Response.json({ runs: [] });
        }
        if (path === RUNNER_PATHS.bundle) return new Response(source);
        if (path === RUNNER_PATHS.heartbeat) return Response.json({ leaseExpiresAt: lease.deadlineAt });
        if (path === RUNNER_PATHS.complete) {
          complete.resolve(RunnerCompleteRequestSchema.parse(await request.json()));
          return Response.json({});
        }
        return new Response(null, { status: 404 });
      },
    });
    const name = `code-c14-${run!.id}`;
    const timeout = AbortSignal.timeout(15_000);
    const bounded = <T>(pending: Promise<T>) =>
      Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          if (timeout.aborted) reject(new Error("attack_timeout"));
          else timeout.addEventListener("abort", () => reject(new Error("attack_timeout")), { once: true });
        }),
      ]);
    try {
      // Host networking deliberately leaves Core reachable to the supervisor.
      // Native/JS workerd denial must hold even without a network-none crutch.
      await docker(
        "run",
        "--detach",
        "--name",
        name,
        "--network",
        "host",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "SETUID",
        "--cap-add",
        "SETGID",
        "--cap-add",
        "KILL",
        "--cap-add",
        "CHOWN",
        "--cap-add",
        "DAC_OVERRIDE",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        "1g",
        "--pids-limit",
        "256",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777",
        "--env",
        "CLOUD_APP_KEY_FILE=/run/runner-key/source",
        "--env",
        `CLOUD_CORE_INTERNAL_ORIGIN=${core.url.origin}`,
        "--volume",
        `${join(directory, "key")}:/run/runner-key/source:ro`,
        "--volume",
        `${resolve(import.meta.dir, "../test/fixed-clock.ts")}:/clock.ts:ro`,
        "cloud-runner:attacks",
        "bun",
        "--no-env-file",
        "--preload",
        "/clock.ts",
        "/app/runner.js",
      );
      if (options.drain) {
        await bounded(called.promise);
        await docker("kill", "--signal", "TERM", name);
      }
      const result = await bounded(complete.promise);
      const atStop = fetches;
      if (!options.drain) await docker("kill", "--signal", "TERM", name);
      expect(await bounded(docker("wait", name))).toBe("0");
      expect(fetches).toBe(atStop);
      expect(providerCalls).toBe(0);
      const rows = await sql<{ result: unknown }[]>`SELECT result FROM code.calls WHERE run_id=${run!.id}::uuid ORDER BY ordinal`;
      return { outcome: result.outcome, responses, observations: rows.map((row) => row.result) };
    } finally {
      await docker("rm", "--force", name);
      await core.stop(true);
    }
  }

  const deniedBundle = (operations: [string, string][]) => `export async function main(input, cloud) {
    for (const [operation, expected] of ${JSON.stringify(operations)}) {
      try {
        await cloud.call(operation, {call: {capability: operation, target: null, refs: {}, input: {}}, metadata: {}});
        throw new Error('ESCAPE');
      } catch (error) { if (error.message !== expected) throw error; }
    }
  }`;
  const refusal = (code: string) => ({ ok: false, error: { code } });

  test("Code access, streams and code:false are refused to hostile bundles", async () => {
    const result = await execute(
      deniedBundle([
        ["example.code.access.set", "code_access_forbidden"],
        ["example.stream", "code_stream_forbidden"],
        ["example.person", "code_disabled"],
      ]),
    );
    expect(result.outcome).toBe("succeeded");
    const expected = ["code_access_forbidden", "code_stream_forbidden", "code_disabled"].map(refusal);
    expect(result.responses).toEqual(expected.map((body) => ({ status: 200, body })));
    expect(result.observations).toEqual(expected);
  }, 30_000);

  test("a real Valkey call flood is refused and bounded in the run observations", async () => {
    rate = 1;
    try {
      const result = await execute(
        deniedBundle([
          ["example.person", "code_disabled"],
          ...Array.from({ length: 32 }, (): [string, string] => ["example.person", "code_rate_limited"]),
        ]),
      );
      expect(result.outcome).toBe("succeeded");
      const expected = [refusal("code_disabled"), ...Array.from({ length: 32 }, () => refusal("code_rate_limited"))];
      expect(result.observations).toEqual(expected);
      expect(result.responses).toEqual(expected.map((body) => ({ status: 200, body })));
    } finally {
      rate = 1000;
    }
  }, 30_000);

  test("a stale C13 generation is fenced before any observation or provider call", async () => {
    const result = await execute(deniedBundle([["example.person", "runner_lease_lost"]]), { stale: true });
    expect(result.outcome).toBe("lease_lost");
    expect(result.responses).toEqual([{ status: 409, body: refusal("runner_lease_lost") }]);
    expect(result.observations).toEqual([]);
  }, 30_000);

  test("a forged run token is refused despite the real runner signature", async () => {
    const result = await execute(deniedBundle([["example.person", "runner_bridge_unavailable"]]), { forged: true });
    expect(result.outcome).toBe("succeeded");
    expect(result.responses).toEqual([{ status: 403, body: refusal("code_invalid_token") }]);
    expect(result.observations).toEqual([]);
  }, 30_000);

  test("SIGTERM drain cannot extend a timer-stalled bundle beyond its original deadline", async () => {
    const source = `${deniedBundle([["example.person", "code_disabled"]]).replace("export async function main", "async function probe")}
      export async function main(input, cloud) { await probe(input, cloud); await new Promise(() => {}); }`;
    const result = await execute(source, { drain: true });
    expect(result.outcome).toBe("wall_clock_limit");
    expect(result.responses).toEqual([{ status: 200, body: refusal("code_disabled") }]);
  }, 30_000);
});
