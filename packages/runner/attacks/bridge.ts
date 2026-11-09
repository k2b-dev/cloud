// Dedicated CI entry: intentionally outside the ordinary *.test.ts discovery.
// Run: bun --no-env-file test ./packages/runner/attacks/bridge.ts
import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { chmod, mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { err } from "@k2b/stdlib";
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { APP_KEY_FIXTURES } from "../../../scripts/fixtures/app-key-fixtures";
import { suiteFor, useFreshDatabase } from "../../../scripts/fixtures/test-infra";
import { compileCapabilities, invokeCompiledCapability, serializeCapabilityProviderResult } from "../../cloud/src/_internal/capabilities";
import { invokeCapabilityStream } from "../../cloud/src/_internal/capability-streams";
import * as registry from "../../cloud/src/_internal/registry";
import { type CapabilityDispatchDependencies, createCodeRunnerCallRoutes } from "../../cloud/src/api/capabilities";
import { type AppKey, formatAppKey } from "../../cloud/src/app-key";
import { migrateCloudCapabilities } from "../../cloud/src/capabilities/migrate";
import { compileCapabilityManifest } from "../../cloud/src/capabilities/testing";
import { type CodeRunTokenInput, signCodeRunToken } from "../../cloud/src/code/run-token";
import { RUNNER_PATHS, RunnerCompleteRequestSchema, type RunnerLease } from "../../cloud/src/code/runner-protocol";
import type { CodeCheckedVersionManifest } from "../../cloud/src/contracts";
import { type CapabilityExecutionContext, CapabilityFileMetadataSchema } from "../../cloud/src/contracts/capabilities";
import type { CapabilityRegistryEntry } from "../../cloud/src/contracts/registry";
import { sql } from "../../cloud/src/runtime/clients";
import { appKeys } from "../../cloud/src/services/app-keys";
import { approvalArgsDigest } from "../../cloud/src/services/approvals";
import { resolveInvocationAuthority } from "../../cloud/src/services/identity/invocation-actor";
import { verifyInvocationToken } from "../../cloud/src/services/identity/invocation-token";
import { issueInvocationToken } from "../../cloud/src/services/identity/issue-invocation";
import { mandates } from "../../cloud/src/services/mandates";
import { createCodeBridgeHost } from "../../core/src/code/bridge";
import { CODE_SETTINGS, codeSettings } from "../../core/src/code/settings";
import { codeBundleHash, codeSourceHash } from "../../core/src/code/store";
import { migrate as migrateAppApproval } from "../../core/src/migrate/core/app-approval";
import { migrateAppKeys } from "../../core/src/migrate/core/app-keys";
import { migrate as migrateAudit } from "../../core/src/migrate/core/audit";
import { migrate as migrateAuth } from "../../core/src/migrate/core/auth";
import { migrate as migrateCode } from "../../core/src/migrate/core/code";
import { migrate as migratePolicy } from "../../core/src/migrate/core/code-policy";
import { migrate as migrateScheduling } from "../../core/src/migrate/core/code-scheduling";
import { migrate as migrateVersions } from "../../core/src/migrate/core/code-versions";
import { migrate as migrateLogging } from "../../core/src/migrate/core/logging";
import { migrate as migrateRailPreferences } from "../../core/src/migrate/core/rail-preferences";
import { migrate as migrateRailShortcuts } from "../../core/src/migrate/core/rail-shortcuts";
import { migrate as migrateSettings } from "../../core/src/migrate/core/settings";
import { config } from "../test/fixtures";

const NOW = Date.UTC(2030, 0, 2);
const now = new Date(NOW);
const issuer = "https://cloud.example";
const userId = "11111111-1111-4111-8111-111111111111";
const foreignUserId = "44444444-4444-4444-8444-444444444444";
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
    actions: {
      // Raw write streams without the generic FileRef input remain unavailable to Code.
      stream: {
        ...operation,
        destructive: false,
        idempotency: "required",
        policy: { silent: "shared" },
        review: () => ({ ok: true, data: { message: "Fixture" } }),
        stream: {
          direction: "write",
          maxBytes: 1024,
          write: async () => {
            throw new Error("attack_reached_provider");
          },
          status: async () => ({ state: "open" }),
          abort: async () => {},
        },
      },
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
  let registrySpy: ReturnType<typeof spyOn<typeof registry, "getApp">>;
  beforeAll(async () => {
    setSystemTime(now);
    await docker("image", "inspect", "cloud-runner:attacks");
    database = await useFreshDatabase("runner_attacks_c14");
    await migrateAuth();
    await migrateRailPreferences();
    await migrateRailShortcuts();
    await migrateAudit();
    await migrateSettings();
    await migrateAppKeys();
    await migrateCode();
    await migrateScheduling();
    await migratePolicy();
    await migrateVersions();
    await migrateAppApproval();
    await migrateLogging();
    await migrateCloudCapabilities();
    await sql`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES(${userId}::uuid,'attack-admin','local','user',true)`;
    await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${foreignUserId}::uuid,'attack-foreign','local','user')`;
    registrySpy = spyOn(registry, "getApp").mockImplementation(async (id) => ({
      id,
      name: id,
      icon: "ti ti-folder",
      description: "Attack fixture",
      baseUrl: "http://example.test",
      routes: [],
      access: { kind: "signedIn" },
    }));
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
    registrySpy?.mockRestore();
    await database?.drop();
    if (directory) {
      await unlink(join(directory, "key"));
      await rmdir(directory);
    }
    setSystemTime();
  });

  async function execute(
    source: string,
    options: {
      stale?: boolean;
      forged?: boolean;
      drain?: boolean;
      ended?: boolean;
      replay?: boolean;
      callsLimit?: number;
      flood?: boolean;
      files?: boolean;
      foreignAccount?: boolean;
      expireFile?: boolean;
      input?: RunnerLease["input"];
      permissions?: CodeCheckedVersionManifest["permissions"];
    } = {},
  ) {
    const ownerId = options.foreignAccount ? foreignUserId : userId;
    const codeId = `c_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const hash = codeBundleHash(source);
    const files = { "code.ts": source };
    const manifest: CodeCheckedVersionManifest = {
      version: 1,
      entry: "code.ts",
      entrypoints: [{ kind: "manual", entrypoint: "main", file: "code.ts", line: 1, cron: null }],
      hashes: { source: codeSourceHash(files, "code.ts"), bundle: hash, sdk: "a".repeat(64) },
      // Declare the probe before testing the independent access/stream/file guard.
      // Explicit overrides below exercise undeclared calls separately.
      permissions:
        options.permissions ??
        (options.files
          ? ["example.file.read", "example.file.read.read", "example.import"]
          : ["example.code.access.set", "example.stream", "example.person"]
        ).map((operation) => ({ operation, target: null, file: "code.ts", line: 1 })),
      policyRows: options.files ? ["read", "silent_shared"] : [],
      ai: false,
    };
    await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title,state) VALUES(${codeId},'person',${ownerId}::uuid,'Attack fixture','active')`;
    const [version] = await sql<{ id: string }[]>`
      INSERT INTO code.versions(code_id,number,source_files,bundle,source_hash,bundle_hash,manifest,source_bytes,bundle_bytes,created_by)
      VALUES(${codeId},1,${JSON.stringify(files)}::text::jsonb,${source},${manifest.hashes.source},${hash},${JSON.stringify(manifest)}::text::jsonb,
      ${Buffer.byteLength(source)},${Buffer.byteLength(source)},${userId}::uuid) RETURNING id`;
    let mandateId = "33333333-3333-4333-8333-333333333333";
    if (options.files) {
      await sql`UPDATE code.policy_rules SET value='automatic' WHERE group_id IS NULL`;
      await sql`UPDATE code.codes SET active_version_id=${version!.id}::uuid WHERE id=${codeId}`;
      const binding = {
        codeId,
        versionId: version!.id,
        sourceHash: manifest.hashes.source,
        bundleHash: hash,
        manifestHash: approvalArgsDigest(manifest),
        comparisonVersionId: null,
        comparisonSourceHash: null,
        comparisonBundleHash: null,
      };
      await sql`INSERT INTO code.version_submissions(code_id,version_id,binding) VALUES(${codeId},${version!.id}::uuid,${JSON.stringify(binding)}::text::jsonb)`;
      const created = await mandates.create({
        authority: { kind: "admin", userId },
        subject: { type: "user", id: ownerId },
        ownerAppId: "runner",
        workloadType: "code.version",
        workloadId: version!.id,
        policy: null,
      });
      if (!created.ok) throw new Error(created.error.message);
      mandateId = created.data.id;
    }
    const [run] = await sql<{ id: string }[]>`
      INSERT INTO code.runs(code_id,version_id,trigger,entrypoint,state,started_at,lease_expires_at,generation,payload_bytes,calls_limit)
      VALUES(${codeId},${version!.id}::uuid,'manual','main','running',clock_timestamp(),clock_timestamp()+interval '1 minute',${options.stale ? 2 : 1},32768,${options.callsLimit ?? 200})
      RETURNING id`;
    if (options.ended) await sql`UPDATE code.runs SET state='succeeded',ended_at=clock_timestamp() WHERE id=${run!.id}::uuid`;
    const claims: CodeRunTokenInput = {
      codeId,
      versionId: version!.id,
      runId: run!.id,
      generation: 1,
      entrypoint: "main",
      bundleHash: hash,
      mandateId,
      mandateRevision: 1,
    };
    const token = await signCodeRunToken(claims, { issuer, signer, now, deadlineAt: NOW + 10_000 });
    // Reuse an otherwise valid token against another run identity. The sandbox
    // never receives this token; this attacks the signed transport boundary.
    if (options.replay) claims.runId = crypto.randomUUID();
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
      input: options.input ?? null,
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
    // Monotonic host time; both clocks seen by the runner are frozen at NOW.
    let leasedAt = 0;
    let completedAt = 0;
    const responses: { status: number; body: unknown }[] = [];
    // More than the bridge budget: a successful transfer must bypass the sandbox.
    const payload = "FILE_REF_BODY_CANARY".repeat(32768);
    let readBytes = 0;
    let writes = 0;
    const requireAccess = (context: CapabilityExecutionContext) => {
      if (context.accessSubject.type !== "user" || context.accessSubject.userId !== userId) throw err.forbidden("No fixture file access");
    };
    const compiled = compileCapabilities("example", {
      protocolVersion: 2,
      queries: {
        "file.read": {
          ...operation,
          async run(_input, context) {
            requireAccess(context);
            return {
              ok: true,
              data: {
                data: {},
                stream: {
                  id: "private-provider-file",
                  direction: "read",
                  name: "invoice.pdf",
                  mediaType: "application/pdf",
                  size: Buffer.byteLength(payload),
                  expiresAt: new Date(NOW + (options.expireFile ? 500 : 10000)).toISOString(),
                },
              },
            };
          },
          stream: {
            direction: "read",
            maxBytes: Buffer.byteLength(payload),
            async read(_stream, context) {
              requireAccess(context);
              readBytes += Buffer.byteLength(payload);
              return new Response(payload);
            },
          },
        },
      },
      actions: {
        import: {
          ...operation,
          input: z.object({ file: CapabilityFileMetadataSchema }).strict(),
          data: z.object({ imported: z.boolean() }).strict(),
          destructive: false,
          idempotency: "required",
          policy: { silent: "shared" },
          review: () => ({
            ok: true,
            data: {
              locale: "en",
              sentence: { action: "Import file", running: "Importing file", done: "Imported file", confirm: "Import", decline: "Cancel" },
              slots: {},
              scope: "fixture:file",
            },
          }),
          async run(input, context) {
            requireAccess(context);
            return {
              ok: true,
              data: {
                data: { imported: false },
                stream: {
                  ...input.file,
                  id: context.idempotencyKey!,
                  direction: "write",
                  expiresAt: new Date(NOW + 10000).toISOString(),
                },
              },
            };
          },
          stream: {
            direction: "write",
            maxBytes: Buffer.byteLength(payload),
            async write(_stream, body, context) {
              requireAccess(context);
              expect(await new Response(body).text()).toBe(payload);
              writes++;
              return { data: { imported: true } };
            },
            status: async () => ({ state: "open" }),
            abort: async () => {},
          },
        },
      },
    });
    const fileEntry = { ...entry, manifest: compiled.manifest, endpoint: "http://example.test/api/_internal/capabilities/v1" };
    const fileDispatch: CapabilityDispatchDependencies = {
      getCapability: async (appId) => (appId === "example" ? fileEntry : null),
      withActiveSigner: async (_, use) => sql.begin((db) => use({ ...signer, issuer, groupsAdmin: [] }, db)),
      signInvocation: (params, opts) => issueInvocationToken(params, { ...opts, groupsAdmin: [] }),
      fetch: async (url, init) => {
        providerCalls++;
        const request = new Request(url, init);
        const parts = new URL(request.url).pathname.split("/");
        const verb = request.headers.has("x-cloud-stream-offer") ? parts.at(-1)! : null;
        const localId = verb ? parts.at(-2)! : parts.at(-1)!;
        const kind = compiled.queries.has(localId) ? "query" : "action";
        const op = (kind === "query" ? compiled.queries : compiled.actions).get(localId)!;
        const verified = await verifyInvocationToken(
          request.headers.get("authorization")!.slice(7),
          {
            targetAppId: "example",
            operation: `${kind === "query" ? "capability.query" : "capability.action.run"}:${localId}`,
            schemaHash: op.manifest.schemaHash,
          },
          { issuer, key, now },
        );
        const authority = verified ? await resolveInvocationAuthority(verified, sql, []) : null;
        if (!authority) throw new Error("Missing file fixture invocation authority");
        const context: CapabilityExecutionContext = {
          authority,
          actor: authority.actor,
          accessSubject: authority.accessSubject,
          user: null,
          locale: "en",
          requestId: "runner-file-ref",
          origin: "app",
          signal: request.signal,
          ...(request.headers.has("idempotency-key") ? { idempotencyKey: request.headers.get("idempotency-key")! } : {}),
        };
        if (verb)
          return invokeCapabilityStream({ compiled, kind: kind === "query" ? "queries" : "actions", localId, verb, request, context });
        const body = z.object({ input: z.unknown() }).parse(await request.json());
        const result = await invokeCompiledCapability({
          compiled,
          kind,
          localId,
          input: body.input,
          expectedSchemaHash: op.manifest.schemaHash,
          context,
        });
        const wire = serializeCapabilityProviderResult(result);
        return new Response(wire.body, { status: wire.status, headers: { "content-type": "application/json" } });
      },
    };
    const routes = createCodeRunnerCallRoutes({
      host: createCodeBridgeHost(), // Real Postgres fencing/observations and real Valkey limiter.
      token: { issuer, key, now },
      ownOrigins: async () => [issuer, "http://app-core:3000"],
      dispatch: options.files
        ? fileDispatch
        : {
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
          if (options.expireFile && responses.length === 1) setSystemTime(new Date(NOW + 1000));
          called.resolve();
          return result;
        }
        // Acquisition is a deterministic fixture. Calls use unmodified C4 auth,
        // signatures, run-token verification, C13 SQL fences and Valkey budgets.
        if (path === RUNNER_PATHS.config)
          return Response.json({ ...config, slots: 1, bridgeConcurrency: options.flood ? 33 : config.bridgeConcurrency });
        if (path === RUNNER_PATHS.fetch) {
          if (++fetches === 1) {
            leasedAt = performance.now();
            return Response.json({ runs: [lease] });
          }
          await new Promise<void>((done) => {
            if (request.signal.aborted) done();
            else request.signal.addEventListener("abort", () => done(), { once: true });
          });
          return Response.json({ runs: [] });
        }
        if (path === RUNNER_PATHS.bundle) return new Response(source);
        if (path === RUNNER_PATHS.heartbeat) return Response.json({ leaseExpiresAt: lease.deadlineAt });
        if (path === RUNNER_PATHS.complete) {
          completedAt = performance.now();
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
        "--init",
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
        "--security-opt",
        `seccomp=${resolve(import.meta.dir, "../seccomp.json")}`,
        "--security-opt",
        "apparmor=cloud-code-runner",
        "--security-opt",
        "systempaths=unconfined",
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
      if (!options.drain) await docker("kill", "--signal", "TERM", name);
      expect(await bounded(docker("wait", name))).toBe("0");
      // Ordinary runs may free a slot and begin another poll before Docker
      // delivers TERM. Drain is signalled while the accepted attempt is active.
      if (options.drain) expect(fetches).toBe(1);
      if (!options.files) expect(providerCalls).toBe(0);
      const rows = await sql<
        { result: unknown; refusal_kind: string | null }[]
      >`SELECT result,refusal_kind FROM code.calls WHERE run_id=${run!.id}::uuid ORDER BY ordinal`;
      return {
        outcome: result.outcome,
        readBytes,
        writes,
        responses,
        observations: rows.map((row) => row.result),
        refusalKinds: rows.map((row) => row.refusal_kind),
        providerCalls,
        attemptMs: completedAt - leasedAt,
      };
    } finally {
      try {
        await docker("rm", "--force", name);
      } finally {
        await core.stop(true);
        setSystemTime(now);
      }
    }
  }

  const deniedBundle = (operations: [string, string][]) => `export async function main(input, cloud) {
    for (const [operation, expected] of ${JSON.stringify(operations)}) {
      try {
        await cloud.call(operation, {call: {capability: operation, target: null, refs: {}, input: {}}, metadata: {}});
        throw new Error('ESCAPE');
      } catch (error) { if (error.code !== expected) throw error; }
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

  test("an undeclared hostile call is refused before access checks and durably recorded", async () => {
    const result = await execute(deniedBundle([["example.person", "code_capability_undeclared"]]), { permissions: [] });
    expect(result.outcome).toBe("succeeded");
    expect(result.responses).toEqual([{ status: 403, body: refusal("code_capability_undeclared") }]);
    expect(result.observations).toEqual([refusal("code_capability_undeclared")]);
    expect(result.refusalKinds).toEqual(["policy"]);
    expect(result.providerCalls).toBe(0);
  }, 30_000);

  const fileBundle = (body: string) => `export async function main(input, cloud) {
    let serial = 0;
    const call = (operation, input = {}) => cloud.call(operation, {
      call: {capability: operation, target: null, refs: {}, input},
      metadata: operation === 'example.import' ? {idempotencyKey: 'file-' + (++serial)} : {},
    });
    const denied = async (operation, input, expected) => {
      try { await call(operation, input); throw new Error('ESCAPE'); }
      catch (error) { if (error.code !== expected) throw error; }
    };
    ${body}
  }`;

  test.each(["example.file.read", "example.import"])(
    "an undeclared file operation %s cannot move bytes",
    async (missing) => {
      const result = await execute(
        fileBundle(
          missing === "example.file.read"
            ? `await denied('example.file.read', {}, 'code_capability_undeclared');`
            : `const file = await call('example.file.read'); await denied('example.import', {file}, 'code_capability_undeclared');`,
        ),
        {
          files: true,
          permissions: ["example.file.read", "example.import"]
            .filter((operation) => operation !== missing)
            .map((operation) => ({ operation, target: null, file: "code.ts", line: 1 })),
        },
      );
      expect(result.outcome).toBe("succeeded");
      expect(result.responses.at(-1)).toEqual({ status: 403, body: refusal("code_capability_undeclared") });
      expect(result.observations.at(-1)).toEqual(refusal("code_capability_undeclared"));
      expect(result.refusalKinds.at(-1)).toBe("policy");
      expect(result.providerCalls).toBe(missing === "example.file.read" ? 0 : 1);
      expect(result.readBytes).toBe(0);
      expect(result.writes).toBe(0);
    },
    30_000,
  );

  test("FileRefs expose metadata only; byte injection and replay are refused by the real bridge", async () => {
    const result = await execute(
      fileBundle(`
      const file = await call('example.file.read');
      if (Object.keys(file).sort().join(',') !== 'id,mediaType,name,size' ||
          file.name !== 'invoice.pdf' || file.mediaType !== 'application/pdf' || file.size <= 262144 ||
          file.id.includes('private-provider-file') || file.id.includes('://') || JSON.stringify(file).includes('FILE_REF_BODY_CANARY'))
        throw new Error('ESCAPE');
      await denied('example.file.read.read', {file}, 'code_operation_not_found');
      await denied('example.import', {file: {...file, bytes: 'injected'}}, 'code_file_invalid');
      await denied('example.import', {file: {...file, url: 'http://example.test/private'}}, 'code_file_invalid');
      await denied('example.import', {file: 'FILE_REF_BODY_CANARY'}, 'code_file_invalid');
      const result = await call('example.import', {file});
      if (JSON.stringify(result) !== '{"imported":true}') throw new Error('ESCAPE');
      await denied('example.import', {file}, 'code_file_spent');
      await denied('example.import', {file: {...file, id: file.id.toUpperCase()}}, 'code_file_spent');
    `),
      { files: true },
    );
    expect(result.outcome).toBe("succeeded");
    expect(result.writes).toBe(1);
    expect(result.readBytes).toBe(Buffer.byteLength("FILE_REF_BODY_CANARY".repeat(32768)));
    expect(JSON.stringify(result.responses)).not.toContain("FILE_REF_BODY_CANARY");
    expect(result.responses.filter(({ body }) => JSON.stringify(body).includes("code_file_spent"))).toHaveLength(2);
  }, 30_000);

  test("a foreign Code account cannot obtain a file or redeem another run's FileRef", async () => {
    const issued = await execute(fileBundle(`await call('example.file.read');`), { files: true });
    expect(issued.outcome).toBe("succeeded");
    const file = z.object({ data: z.json() }).parse(issued.responses[0]!.body).data;
    const otherCode = await execute(fileBundle(`await denied('example.import', {file: input}, 'code_file_invalid');`), {
      files: true,
      input: file,
    });
    expect(otherCode.outcome).toBe("succeeded");
    expect(otherCode.readBytes).toBe(0);
    expect(otherCode.writes).toBe(0);
    const result = await execute(
      fileBundle(`
      await denied('example.file.read', {}, 'forbidden');
      await denied('example.import', {file: input}, 'code_file_invalid');
    `),
      { files: true, foreignAccount: true, input: file },
    );
    expect(result.outcome).toBe("succeeded");
    expect(result.readBytes).toBe(0);
    expect(result.writes).toBe(0);
    expect(issued.readBytes).toBe(0);
  }, 30_000);

  test("an expired FileRef is refused while its real runner lease remains valid", async () => {
    const result = await execute(
      fileBundle(`
      const file = await call('example.file.read');
      await denied('example.import', {file}, 'code_file_invalid');
    `),
      { files: true, expireFile: true },
    );
    expect(result.outcome).toBe("succeeded");
    expect(result.responses).toHaveLength(2);
    expect(result.readBytes).toBe(0);
    expect(result.writes).toBe(0);
  }, 30_000);

  test("a real Valkey call flood receives rate refusals", async () => {
    rate = 1;
    try {
      const result = await execute(
        `export async function main(input, cloud) {
        const errors = await Promise.all(Array.from({length: 33}, async () => {
          try {
            await cloud.call('example.person', {call: {capability: 'example.person', target: null, refs: {}, input: {}}, metadata: {}});
            return 'ESCAPE';
          } catch (error) { return error.code; }
        }));
        if (!errors.includes('code_rate_limited') || errors.some(error => !['code_disabled', 'code_rate_limited'].includes(error)))
          throw new Error('unexpected rate flood result');
      }`,
        { flood: true },
      );
      expect(result.outcome).toBe("succeeded");
      expect(result.observations).toHaveLength(33);
      expect(result.responses).toHaveLength(33);
      expect(result.responses.some((response) => JSON.stringify(response.body) === JSON.stringify(refusal("code_rate_limited")))).toBe(
        true,
      );
      for (const response of result.responses) {
        expect(response.status).toBe(200);
        expect([refusal("code_disabled"), refusal("code_rate_limited")].map((body) => JSON.stringify(body))).toContain(
          JSON.stringify(response.body),
        );
      }
    } finally {
      rate = 1000;
    }
  }, 30_000);

  test("call observations stop at the saved budget even when Code keeps calling", async () => {
    const result = await execute(
      deniedBundle([
        ...Array.from({ length: 10 }, (): [string, string] => ["example.person", "code_disabled"]),
        ...Array.from({ length: 3 }, (): [string, string] => ["example.person", "code_call_limit"]),
      ]),
      { callsLimit: 10 },
    );
    expect(result.outcome).toBe("succeeded");
    expect(result.observations).toEqual(Array.from({ length: 10 }, () => refusal("code_disabled")));
    expect(result.responses.map((response) => response.body)).toEqual([
      ...Array.from({ length: 10 }, () => refusal("code_disabled")),
      ...Array.from({ length: 3 }, () => refusal("code_call_limit")),
    ]);
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

  for (const attack of ["ended", "replay"] as const) {
    test(`a valid token cannot be reused against an ${attack === "ended" ? "ended" : "unrelated"} run`, async () => {
      const result = await execute(deniedBundle([["example.person", "runner_lease_lost"]]), { [attack]: true });
      expect(result.outcome).toBe("lease_lost");
      expect(result.responses).toEqual([{ status: 409, body: refusal("runner_lease_lost") }]);
      expect(result.observations).toEqual([]);
    }, 30_000);
  }

  test("SIGTERM drain cannot extend a timer-stalled bundle beyond its original deadline", async () => {
    const source = `${deniedBundle([["example.person", "code_disabled"]]).replace("export async function main", "async function probe")}
      export async function main(input, cloud) { await probe(input, cloud); await new Promise(resolve => setTimeout(resolve, 60_000)); }`;
    const result = await execute(source, { drain: true });
    expect(result.outcome).toBe("wall_clock_limit");
    // The 1.5 s deadline timer starts once the lease arrives. Two seconds cover
    // terminating workerd and reporting; a drain that waits for the bundle does not fit.
    expect(result.attemptMs).toBeGreaterThanOrEqual(1400);
    expect(result.attemptMs).toBeLessThan(3500);
    expect(result.responses).toEqual([{ status: 200, body: refusal("code_disabled") }]);
  }, 30_000);
});
