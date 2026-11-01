import { afterAll, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { APP_KEY_FIXTURES } from "../../../../scripts/fixtures/app-key-fixtures";
import { suiteFor, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { createCodeBridgeHost, readCodeOwnOrigins } from "../../../core/src/code/bridge";
import { createCodeRunnerRoutes } from "../../../core/src/code/runner-routes";
import { CODE_SETTINGS, codeSettings } from "../../../core/src/code/settings";
import { codeBundleHash, codeSourceHash } from "../../../core/src/code/store";
import { migrate as migrateAppApproval } from "../../../core/src/migrate/core/app-approval";
import { migrateAppBootstrap } from "../../../core/src/migrate/core/app-bootstrap";
import { migrate as migrateAppDomains } from "../../../core/src/migrate/core/app-domains";
import { migrateAppKeys } from "../../../core/src/migrate/core/app-keys";
import { migrate as migrateAudit } from "../../../core/src/migrate/core/audit";
import { migrate as migrateAuth } from "../../../core/src/migrate/core/auth";
import { migrate as migrateCode } from "../../../core/src/migrate/core/code";
import { migrate as migratePolicy } from "../../../core/src/migrate/core/code-policy";
import { migrate as migrateScheduling } from "../../../core/src/migrate/core/code-scheduling";
import { migrate as migrateVersions } from "../../../core/src/migrate/core/code-versions";
import { migrate as migrateRailPreferences } from "../../../core/src/migrate/core/rail-preferences";
import { migrate as migrateRailShortcuts } from "../../../core/src/migrate/core/rail-shortcuts";
import { migrate as migrateSettings } from "../../../core/src/migrate/core/settings";
import * as registry from "../_internal/registry";
import {
  type CapabilityDispatchDependencies,
  codeHttpOriginAllowed,
  createCodeRunnerCallRoutes,
  dispatchCapability,
} from "../api/capabilities";
import type { AppKey } from "../app-key";
import { signAppProof } from "../app-proof";
import { migrateCloudCapabilities } from "../capabilities/migrate";
import { compileCapabilityManifest } from "../capabilities/testing";
import type { CodeCheckedVersionManifest } from "../contracts";
import type { CapabilityRegistryEntry } from "../contracts/registry";
import { sql } from "../runtime/clients";
import { getEffectivePermission, hasPermission } from "../server";
import * as rateLimits from "../server/ratelimit";
import { coreSettings } from "../services";
import { appKeys } from "../services/app-keys";
import { approvalArgsDigest } from "../services/approvals";
import { resolveInvocationAuthority } from "../services/identity/invocation-actor";
import { verifyInvocationToken } from "../services/identity/invocation-token";
import { issueInvocationToken } from "../services/identity/issue-invocation";
import { mandates } from "../services/mandates";
import { type CodeRunTokenInput, signCodeRunToken, verifyCodeRunToken } from "./run-token";
import { RUNNER_PATHS, type RunnerCallRequest } from "./runner-protocol";

// Postgres keeps real time in these checks, so the frozen app clock starts at the real present.
const now = new Date();
const issuer = "https://cloud.example";
const userId = "11111111-1111-4111-8111-111111111111";
const kid = "22222222-2222-4222-8222-222222222222";
const item = { type: "example.folder", id: "a" };
const op = {
  title: "Fixture",
  description: "Bridge fixture.",
  input: z.object({}).strict(),
  data: z.object({ value: z.string() }).strict(),
  openWorld: false,
  run: () => ({ ok: true as const, data: { data: { value: "done" } } }),
};
const actionOp = {
  ...op,
  review: () => ({
    ok: true as const,
    data: {
      locale: "en",
      sentence: { action: "Write folder", running: "Writing folder", done: "Wrote folder", confirm: "Write", decline: "Cancel" },
      slots: {},
      scope: "folder:a",
    },
  }),
};
const manifest = compileCapabilityManifest("example", {
  protocolVersion: 2,
  types: { folder: { title: "Folder", description: "Fixture folder." } },
  queries: { read: { ...op, target: "folder" } },
  actions: {
    write: { ...actionOp, target: "folder", destructive: false, idempotency: "none", policy: { silent: "shared" } },
    other: { ...actionOp, target: "folder", destructive: false, idempotency: "none", policy: { silent: "shared" } },
    person: { ...actionOp, target: "folder", destructive: false, idempotency: "none", policy: { silent: "shared" }, code: false },
    asks: { ...actionOp, target: "folder", destructive: false, idempotency: "none", policy: { ask: "app_asks" } },
  },
});
const baseEntry: CapabilityRegistryEntry = {
  appId: "example",
  appName: "Example",
  appIcon: "ti ti-folder",
  appDescription: "Fixture",
  endpoint: "http://example.test/api/_internal/capabilities/v1",
  manifest,
};

suiteFor("database", "valkey")("C4 signed runner bridge and independent per-call authorization", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  let runner: AppKey, other: AppKey;
  let signer: { kid: string; key: CryptoKey; signUntil: Date };
  let key: JWTVerifyGetKey;
  let settingsSpy: ReturnType<typeof spyOn<typeof codeSettings, "get">>;
  let registrySpy: ReturnType<typeof spyOn<typeof registry, "getApp">>;
  let capabilitySpy: ReturnType<typeof spyOn<typeof registry, "getCapability">>;
  let claims: CodeRunTokenInput;
  let targetAccess: string;
  let fetched = 0;
  let currentEntry = baseEntry;
  let callLimit = 200;
  let rateLimited = false;
  let realRate = false;
  let realAdmission = false;
  let beforeIssue: (() => Promise<void>) | undefined;
  const withSigner: NonNullable<CapabilityDispatchDependencies["withActiveSigner"]> = async (_, use) => {
    await beforeIssue?.();
    return sql.begin((db) => use({ ...signer, issuer, groupsAdmin: [] }, db));
  };
  const dependencies = () => ({
    host: realRate ? createCodeBridgeHost() : createCodeBridgeHost({ checkRate: async () => ({ limited: rateLimited }) }),
    ownOrigins: async () => [issuer, "http://app-core:3000"],
    token: { issuer, key, now },
    appProof: {
      ingress: async () => ({ limited: false, remaining: 1000, resetIn: 1000 }),
      ...(realAdmission ? {} : { admit: async () => ({ limited: false, remaining: 1000, resetIn: 1000 }) }),
    },
    dispatch: {
      getCapability: async (id: string) => (id === "example" ? currentEntry : null),
      withActiveSigner: withSigner,
      signInvocation: async (params, options) => issueInvocationToken(params, { ...options, groupsAdmin: [] }),
      fetch: async (_url, init) => {
        fetched++;
        const headers = new Headers(init?.headers);
        const body = z.object({ target: z.object({ id: z.string() }) }).parse(JSON.parse(String(init?.body)));
        const operation =
          currentEntry.manifest.actions.find(
            (candidate) => !String(_url).includes("/review") && String(_url).endsWith(`/${candidate.localId}`),
          ) ?? currentEntry.manifest.queries[0]!;
        const verified = await verifyInvocationToken(
          headers.get("authorization")!.slice(7),
          {
            targetAppId: "example",
            operation: `${"destructive" in operation ? "capability.action.run" : "capability.query"}:${operation.localId}`,
            schemaHash: operation.schemaHash,
          },
          { issuer, key, now },
        );
        const authority = verified ? await resolveInvocationAuthority(verified, sql, []) : null;
        const permission = authority
          ? await getEffectivePermission({ accessIds: [targetAccess], subject: authority.accessSubject })
          : "none";
        if (!hasPermission(permission, "write")) return Response.json({ code: "FORBIDDEN", message: "No Code access" }, { status: 403 });
        return Response.json({ data: { value: body.target.id } });
      },
    } satisfies CapabilityDispatchDependencies,
  });
  async function send(
    options: {
      app?: AppKey | null;
      change?: Partial<CodeRunTokenInput>;
      operation?: string;
      target?: typeof item;
      token?: string;
      generation?: number;
      entry?: CapabilityRegistryEntry;
      input?: RunnerCallRequest["input"];
    } = {},
  ) {
    if (options.entry) currentEntry = options.entry;
    const operation = options.operation ?? "example.write";
    const call = { capability: operation, target: options.target ?? item, refs: {}, input: {} };
    const token =
      options.token ??
      (await signCodeRunToken({ ...claims, ...options.change }, { issuer, signer, now, deadlineAt: now.getTime() + 300_000 }));
    const request: RunnerCallRequest = {
      runId: claims.runId,
      generation: options.generation ?? claims.generation,
      token,
      operation,
      input: options.input ?? { call, metadata: {} },
    };
    const body = JSON.stringify(request);
    const app = options.app === undefined ? runner : options.app;
    const proof = app
      ? await signAppProof(app, { method: "POST", path: RUNNER_PATHS.call, body: new TextEncoder().encode(body) })
      : undefined;
    return createCodeRunnerCallRoutes(dependencies()).request(RUNNER_PATHS.call, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json", ...(proof ? { Authorization: `Bearer ${proof}` } : {}) },
    });
  }
  const error = async (options: Parameters<typeof send>[0], code: string, status?: number) => {
    const before = fetched;
    const response = await send(options);
    expect(response.status).toBe(status ?? 200);
    expect(await response.json()).toEqual({ ok: false, error: { code } });
    expect(fetched).toBe(before);
  };
  beforeAll(async () => {
    setSystemTime(now);
    database = await useFreshDatabase("code_bridge_c4");
    await migrateAuth();
    await migrateRailPreferences();
    await migrateRailShortcuts();
    await migrateAudit();
    await migrateSettings();
    await migrateAppDomains();
    await migrateAppKeys();
    await migrateAppBootstrap();
    await migrateAppApproval();
    await migrateCode();
    await migrateScheduling();
    await migratePolicy();
    await migrateVersions();
    await migrateCloudCapabilities();
    await sql`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES(${userId}::uuid,'bridge-admin','local','user',true)`;
    const actor = { id: userId, uid: "bridge-admin", provider: "local" as const, roles: ["admin" as const] };
    for (const [index, appId] of ["runner", "other"].entries()) {
      const fixture = APP_KEY_FIXTURES[index]!;
      const enrolled = await appKeys.register({ actor, appId, publicKey: fixture.publicKey });
      if (!enrolled.ok) throw new Error(enrolled.error.message);
      const value = { appId, seed: fixture.seed, installationId: enrolled.data.installationId, keyId: enrolled.data.keyId };
      if (appId === "runner") runner = value;
      else other = value;
    }
    const pair = await generateKeyPair("RS256", { extractable: true });
    signer = { kid, key: pair.privateKey, signUntil: new Date(now.getTime() + 600_000) };
    key = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: "RS256", use: "sig", kid }] });
    settingsSpy = spyOn(codeSettings, "get").mockImplementation(async (name) =>
      name === "core.code.calls_per_run" ? callLimit : name === "core.code.calls_per_second" ? 1 : CODE_SETTINGS[name].default,
    );
    registrySpy = spyOn(registry, "getApp").mockImplementation(async (id) => ({
      id,
      name: id,
      icon: "ti ti-folder",
      description: "Fixture",
      baseUrl: `http://${id}.test`,
      routes: [],
      access: { kind: "signedIn" },
    }));
    capabilitySpy = spyOn(registry, "getCapability").mockImplementation(async (id) => (id === "example" ? currentEntry : null));
  });
  async function resetFixture(options: { personal?: boolean; invalidEntrypoint?: boolean } = {}) {
    currentEntry = structuredClone(baseEntry);
    callLimit = 200;
    rateLimited = false;
    realRate = false;
    realAdmission = false;
    beforeIssue = undefined;
    await sql`UPDATE code.policy_rules SET value='automatic' WHERE group_id IS NULL`;
    const codeId = `c_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const [account] = await sql<
      { id: string }[]
    >`INSERT INTO auth.service_accounts(name,kind) VALUES(${`code:example.folder:${codeId}`},'code') RETURNING id`;
    if (options.personal)
      await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title,state) VALUES(${codeId},'person',${userId}::uuid,'Fixture','active')`;
    else
      await sql`INSERT INTO code.codes(id,owner_kind,owner_type,owner_id,title,service_account_id,state) VALUES(${codeId},'resource','example.folder',${codeId},'Fixture',${account!.id}::uuid,'active')`;
    const files = { "code.ts": "fixture" },
      bundle = "fixture";
    const checked: CodeCheckedVersionManifest = {
      version: 1,
      entry: "code.ts",
      entrypoints: [
        { kind: "manual", entrypoint: options.invalidEntrypoint ? "different" : "weekly", cron: null, file: "code.ts", line: 1 },
      ],
      hashes: { source: codeSourceHash(files, "code.ts"), bundle: codeBundleHash(bundle), sdk: "a".repeat(64) },
      permissions: [{ operation: "example.write", target: item, file: "code.ts", line: 1 }],
      ai: false,
      policyRows: ["silent_shared"],
    };
    const [version] = await sql<
      { id: string }[]
    >`INSERT INTO code.versions(code_id,number,source_files,bundle,source_hash,bundle_hash,manifest,source_bytes,bundle_bytes,created_by) VALUES(${codeId},1,${JSON.stringify(files)}::text::jsonb,${bundle},${checked.hashes.source},${checked.hashes.bundle},${JSON.stringify(checked)}::text::jsonb,7,7,${userId}::uuid) RETURNING id`;
    await sql`UPDATE code.codes SET active_version_id=${version!.id}::uuid WHERE id=${codeId}`;
    const binding = {
      codeId,
      versionId: version!.id,
      sourceHash: checked.hashes.source,
      bundleHash: checked.hashes.bundle,
      manifestHash: approvalArgsDigest(checked),
      comparisonVersionId: null,
      comparisonSourceHash: null,
      comparisonBundleHash: null,
    };
    await sql`INSERT INTO code.version_submissions(code_id,version_id,binding) VALUES(${codeId},${version!.id}::uuid,${JSON.stringify(binding)}::text::jsonb)`;
    const [stored] = await sql`SELECT jsonb_typeof(v.source_files) AS source_kind,jsonb_typeof(v.manifest) AS manifest_kind,
      jsonb_typeof(s.binding) AS binding_kind FROM code.versions v JOIN code.version_submissions s ON s.version_id=v.id
      WHERE v.id=${version!.id}::uuid`;
    expect(stored).toMatchObject({ source_kind: "object", manifest_kind: "object", binding_kind: "object" });
    const [run] = await sql<
      { id: string }[]
    >`INSERT INTO code.runs(code_id,version_id,trigger,entrypoint,state,started_at,lease_expires_at,generation,payload_bytes,calls_limit) VALUES(${codeId},${version!.id}::uuid,'manual','weekly','running',clock_timestamp(),clock_timestamp()+interval '10 minutes',1,32768,200) RETURNING id`;
    const created = await mandates.create({
      authority: { kind: "admin", userId },
      subject: { type: "service_account", id: account!.id },
      ownerAppId: "core",
      workloadType: "code.version",
      workloadId: version!.id,
      policy: {
        version: 1,
        apps: ["example"],
        operations: ["capability.action.run:write", "capability.query:read"],
        actions: "preapproved",
        grants: [
          { kind: "action", appId: "example", capabilityId: "write", target: item, fixedInput: {} },
          { kind: "query", appId: "example", capabilityId: "read", fixedInput: {} },
        ],
      },
    });
    if (!created.ok) throw new Error(created.error.message);
    claims = {
      codeId,
      versionId: version!.id,
      runId: run!.id,
      entrypoint: "weekly",
      generation: 1,
      mandateId: created.data.id,
      mandateRevision: created.data.revision,
      bundleHash: checked.hashes.bundle,
    };
    const [access] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access(service_account_id,permission) VALUES(${account!.id}::uuid,'write') RETURNING id`;
    targetAccess = access!.id;
  }
  beforeEach(() => resetFixture());
  afterAll(async () => {
    settingsSpy?.mockRestore();
    registrySpy?.mockRestore();
    capabilitySpy?.mockRestore();
    await database?.drop();
    setSystemTime();
  });

  async function runnerProtocolRequest(path: string, body: object, app: AppKey | null = runner) {
    const text = JSON.stringify(body);
    const authorization = app ? `Bearer ${await signAppProof(app, { method: "POST", path, body: new TextEncoder().encode(text) })}` : "";
    const router = createCodeRunnerRoutes({ token: { issuer, key, now }, appProof: dependencies().appProof });
    return router.request(`http://core.test${path}`, {
      method: "POST",
      headers: { authorization, "Content-Type": "application/json" },
      body: text,
    });
  }
  test("C13 protocol routes require the runner app proof independently of a valid run token", async () => {
    const token = await signCodeRunToken(claims, { deadlineAt: now.getTime() + 300_000, issuer, signer, now });
    const proof = { token, runId: claims.runId, generation: claims.generation };
    for (const path of [RUNNER_PATHS.config, RUNNER_PATHS.fetch, RUNNER_PATHS.bundle, RUNNER_PATHS.heartbeat, RUNNER_PATHS.complete]) {
      expect((await runnerProtocolRequest(path, proof, null)).status).toBe(401);
      expect((await runnerProtocolRequest(path, proof, other)).status).toBe(403);
    }
  });
  test("C13 signed configuration and run-scoped bundle, heartbeat and completion use the current fence", async () => {
    const token = await signCodeRunToken(claims, { deadlineAt: now.getTime() + 300_000, issuer, signer, now });
    const proof = { token, runId: claims.runId, generation: claims.generation };
    expect((await runnerProtocolRequest(RUNNER_PATHS.config, {})).status).toBe(200);
    expect((await runnerProtocolRequest(RUNNER_PATHS.fetch, { freeSlots: 0 })).status).toBe(400);
    const bundle = await runnerProtocolRequest(RUNNER_PATHS.bundle, { ...proof, bundleHash: claims.bundleHash });
    expect(bundle.status).toBe(200);
    expect(await bundle.text()).toBe("fixture");
    expect((await runnerProtocolRequest(RUNNER_PATHS.heartbeat, proof)).status).toBe(200);
    const bad = await runnerProtocolRequest(RUNNER_PATHS.bundle, { ...proof, bundleHash: "f".repeat(64) });
    expect(bad.status).toBe(403);
    expect((await runnerProtocolRequest(RUNNER_PATHS.complete, { ...proof, outcome: "succeeded" })).status).toBe(204);
    expect((await runnerProtocolRequest(RUNNER_PATHS.heartbeat, proof)).status).toBe(409);
    expect((await runnerProtocolRequest(RUNNER_PATHS.bundle, { ...proof, bundleHash: claims.bundleHash })).status).toBe(409);
    expect((await runnerProtocolRequest(RUNNER_PATHS.complete, { ...proof, outcome: "succeeded" })).status).toBe(409);
  });
  test("a Core token without a runner signature is refused", async () => {
    const response = await send({ app: null });
    expect(response.status).toBe(401);
  });
  test("ongoing runner traffic drains expired replay evidence without growing the minute maintenance budget", async () => {
    await sql`INSERT INTO auth.app_proof_replays(key_id,jti,retain_until) VALUES(${runner.keyId}::uuid,'expired-c4',clock_timestamp()-interval '1 second')`;
    expect((await send()).status).toBe(200);
    const expired = await sql`SELECT jti FROM auth.app_proof_replays WHERE key_id=${runner.keyId}::uuid AND jti='expired-c4'`;
    expect(expired).toHaveLength(0);
  });
  test("another app's valid signature is refused", async () => error({ app: other }, "code_runner_required", 403));
  test("only the runner avoids the shared app-key bucket in production admission", async () => {
    realAdmission = true;
    const limits = spyOn(rateLimits, "ratelimit");
    const settings = spyOn(coreSettings, "get").mockResolvedValue(60);
    try {
      expect((await send()).status).toBe(200);
      expect(limits.mock.calls.filter(([config]) => config.id === "app-bootstrap-key")).toHaveLength(0);
      await error({ app: other }, "code_runner_required", 403);
      expect(limits.mock.calls.filter(([config]) => config.id === "app-bootstrap-key")).toHaveLength(1);
    } finally {
      limits.mockRestore();
      settings.mockRestore();
    }
  });
  test("C13 protocol admission reserves the shared app-key bypass for runners", async () => {
    realAdmission = true;
    const limits = spyOn(rateLimits, "ratelimit");
    const settings = spyOn(coreSettings, "get").mockResolvedValue(60);
    try {
      for (const path of [RUNNER_PATHS.config, RUNNER_PATHS.fetch, RUNNER_PATHS.bundle, RUNNER_PATHS.heartbeat, RUNNER_PATHS.complete]) {
        limits.mockClear();
        await runnerProtocolRequest(path, {});
        expect(limits.mock.calls.filter(([config]) => config.id === "app-bootstrap-key")).toHaveLength(0);
        expect((await runnerProtocolRequest(path, {}, other)).status).toBe(403);
        expect(limits.mock.calls.filter(([config]) => config.id === "app-bootstrap-key")).toHaveLength(1);
      }
    } finally {
      limits.mockRestore();
      settings.mockRestore();
    }
  });
  test("run token is required even with an enrolled runner signature", async () =>
    error({ token: "not-a-token" }, "code_invalid_token", 403));
  test("own HTTP origins are refused at bridge ingress", async () =>
    error({ operation: "http.fetch", input: { url: `${issuer}/api/auth` } }, "code_http_origin_forbidden"));
  test("HTTP calls still check the current lease and are observed", async () => {
    await error({ operation: "http.fetch", input: { url: `${issuer}/api` } }, "code_http_origin_forbidden");
    const rows = await sql`SELECT state FROM code.calls WHERE run_id=${claims.runId}::uuid`;
    expect(rows).toEqual([expect.objectContaining({ state: "failed" })]);
    await sql`UPDATE code.runs SET generation=2 WHERE id=${claims.runId}::uuid`;
    await error({ operation: "http.fetch", input: { url: "https://external.example" } }, "runner_lease_lost", 409);
  });
  test("all configured app domains and redirect hosts are own origins", async () => {
    await sql`INSERT INTO settings.app_domains(host,app_id) VALUES('bridge-app.example','example')`;
    await sql`INSERT INTO settings.app_domains(host,app_id,redirect_to) VALUES('bridge-redirect.example','example','bridge-app.example')`;
    const urlSpy = spyOn(coreSettings, "get").mockResolvedValue(issuer);
    const appsSpy = spyOn(registry, "listApps").mockResolvedValue([]);
    try {
      const origins = await readCodeOwnOrigins();
      expect(origins).toContain("https://bridge-app.example");
      expect(origins).toContain("https://bridge-redirect.example");
      expect(codeHttpOriginAllowed("https://bridge-app.example/api", origins)).toBe(false);
      expect(codeHttpOriginAllowed("https://bridge-redirect.example/api", origins)).toBe(false);
    } finally {
      urlSpy.mockRestore();
      appsSpy.mockRestore();
    }
  });
  test("paused Code refuses a current attempt", async () => {
    await sql`UPDATE code.codes SET state='paused' WHERE id=${claims.codeId}`;
    await error({}, "code_not_active");
  });
  test("the current wall-clock budget refuses an overlong attempt", async () => {
    await sql`UPDATE code.runs SET started_at=clock_timestamp()-interval '301 seconds' WHERE id=${claims.runId}::uuid`;
    await error({}, "code_wall_clock_limit");
  });
  test("the checked version must still bind its entrypoint", async () => {
    await resetFixture({ invalidEntrypoint: true });
    await error({}, "code_version_mismatch");
  });
  test("a personal owner cannot use another subject's mandate", async () => {
    await resetFixture({ personal: true });
    await error({}, "code_mandate_mismatch");
  });
  test("a revoked administrator approval refuses calls", async () => {
    await sql`INSERT INTO code.version_decisions(version_id,binding,approved,sole_admin,decided_by,decided_via,auth_epoch)
      SELECT version_id,binding,true,false,${userId}::uuid,'session',-1 FROM code.version_submissions WHERE version_id=${claims.versionId}::uuid`;
    await error({}, "code_approval_revoked");
  });
  test("oversized input gets a stable refusal before invocation", async () => {
    await sql`UPDATE code.runs SET payload_bytes=8 WHERE id=${claims.runId}::uuid`;
    await error({}, "code_input_limit");
  });
  test("unstorable JSON input gets a stable refusal before invocation", async () => {
    await error(
      { input: { call: { capability: "example.write", target: item, refs: {}, input: { value: "\u0000" } }, metadata: {} } },
      "code_input_limit",
    );
  });
  test("malformed sandbox SDK calls keep their stable refusal", async () => {
    await error({ input: {} }, "code_invalid_call");
    await error(
      { operation: "example.other", input: { call: { capability: "example.write", target: item, refs: {}, input: {} }, metadata: {} } },
      "code_invalid_call",
    );
  });
  test("a stale generation is fenced with 409", async () => {
    await sql`UPDATE code.runs SET generation=2 WHERE id=${claims.runId}::uuid`;
    await error({}, "runner_lease_lost", 409);
  });
  test("the request generation cannot disagree with the signed token", async () => error({ generation: 2 }, "runner_lease_lost", 409));
  test("the immutable bundle hash is checked", async () => error({ change: { bundleHash: "b".repeat(64) } }, "code_bundle_mismatch", 200));
  test("an expired token is refused", async () => {
    const token = await signCodeRunToken(claims, {
      issuer,
      signer,
      now: new Date(now.getTime() - 301_000),
      deadlineAt: now.getTime() - 1000,
    });
    await error({ token }, "code_invalid_token", 403);
  });
  test("current policy Never overrides the checked manifest immediately", async () => {
    await sql`UPDATE code.policy_rules SET value='never' WHERE row='silent_shared' AND group_id IS NULL`;
    await error({}, "code_policy_never", 200);
  });
  test("a new admin policy requires an actual version approval", async () => {
    await sql`UPDATE code.policy_rules SET value='admin' WHERE row='silent_shared' AND group_id IS NULL`;
    await error({}, "code_approval_required", 200);
  });
  test("an existing version approval cannot cover an omitted actual classification", async () => {
    await sql`INSERT INTO code.version_decisions(version_id,binding,approved,sole_admin,decided_by,decided_via,auth_epoch)
      SELECT version_id,binding,true,false,${userId}::uuid,'session',0 FROM code.version_submissions WHERE version_id=${claims.versionId}::uuid`;
    await sql`INSERT INTO code.policy_coverage(version_id,row) VALUES(${claims.versionId}::uuid,'silent_shared')`;
    await sql`UPDATE code.policy_rules SET value='admin' WHERE row='read' AND group_id IS NULL`;
    await error({ operation: "example.read" }, "code_approval_required", 200);
  });
  test("actual admin policy requires a decision as well as row coverage", async () => {
    await sql`UPDATE code.policy_rules SET value='admin' WHERE row='read' AND group_id IS NULL`;
    await sql`INSERT INTO code.policy_coverage(version_id,row) VALUES(${claims.versionId}::uuid,'read')`;
    await error({ operation: "example.read" }, "code_approval_required");
  });
  test("a changed decision binding is refused without reading executable payloads", async () => {
    await sql`INSERT INTO code.version_decisions(version_id,binding,approved,sole_admin,decided_by,decided_via,auth_epoch)
      SELECT version_id,jsonb_set(binding,'{bundleHash}',to_jsonb(${"b".repeat(64)}::text)),true,false,${userId}::uuid,'session',0 FROM code.version_submissions WHERE version_id=${claims.versionId}::uuid`;
    await error({}, "code_hash_mismatch");
  });
  test("the C11 authority wrapper classifies actual HTTP calls as internet", async () => {
    await sql`UPDATE code.policy_rules SET value='never' WHERE row='internet' AND group_id IS NULL`;
    const token = await signCodeRunToken(claims, { issuer, signer, now, deadlineAt: now.getTime() + 300_000 });
    const verified = await verifyCodeRunToken(token, { issuer, key, now });
    if (!verified) throw new Error("Fixture token invalid");
    const response = await createCodeBridgeHost({ checkRate: async () => ({ limited: false }) }).withCall(
      {
        claims: verified,
        kind: "internet",
        call: { capability: "http.fetch", target: null, refs: {}, input: { url: "https://external.example" } },
      },
      async (authority) => {
        await sql.begin((db) =>
          authority.withMandateIssueAuthority(
            {
              mandateId: authority.mandateId,
              expectedRevision: authority.mandateRevision,
              ownerAppId: "core",
              targetAppId: "core",
              operation: "runtime.http",
              actionApproval: "none",
              input: {},
            },
            async () => null,
            { db },
          ),
        );
        return Response.json({ ok: true, data: null });
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, error: { code: "code_policy_never" } });
  });
  test("a changed mandate revision is refused", async () => {
    await sql`UPDATE auth.mandates SET revision=revision+1 WHERE id=${claims.mandateId}::uuid`;
    await error({}, "code_mandate_mismatch", 200);
  });
  test("an expired lease is fenced independently of the valid token", async () => {
    await sql`UPDATE code.runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${claims.runId}::uuid`;
    await error({}, "runner_lease_lost", 409);
  });
  test("an operation absent from the mandate is refused", async () => error({ operation: "example.other" }, "mandate_forbidden"));
  test("the same operation at another target is refused", async () => error({ target: { ...item, id: "b" } }, "mandate_forbidden"));
  test("a revoked current Code target grant is refused at the provider", async () => {
    await sql`DELETE FROM auth.access WHERE id=${targetAccess}::uuid`;
    const response = await send();
    expect(await response.json()).toEqual({ ok: false, error: { code: "forbidden" } });
  });
  test("call limit is durable and current admin tightening applies", async () => {
    callLimit = 1;
    expect(await (await send()).json()).toEqual({ ok: true, data: { value: "a" } });
    await error({}, "code_call_limit", 200);
  });
  test("streams are refused", async () => {
    const entry = structuredClone(baseEntry);
    entry.manifest.queries[0]!.stream = { direction: "read", maxBytes: 1024 };
    await error({ operation: "example.read", entry }, "code_stream_forbidden");
  });
  test("code:false is refused", async () => error({ operation: "example.person" }, "code_disabled"));
  test("code.access.* is refused even when present in a catalog", async () => {
    const entry = structuredClone(baseEntry);
    entry.manifest.actions[0]!.localId = "code.access.set";
    await error({ operation: "example.code.access.set", entry }, "code_access_forbidden");
  });
  test("Valkey admission refusal is visible and recorded", async () => {
    rateLimited = true;
    await error({}, "code_rate_limited", 200);
    const rows = await sql`SELECT state,result FROM code.calls WHERE run_id=${claims.runId}::uuid`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("failed");
  });
  test("two Core hosts share the actual Valkey rate bucket", async () => {
    realRate = true;
    expect(await (await send()).json()).toEqual({ ok: true, data: { value: "a" } });
    await error({}, "code_rate_limited", 200);
  });
  test("asking Actions remain forbidden unattended", async () => error({ operation: "example.asks" }, "code_unattended_forbidden", 200));
  test("every actual call is classified even if the checked manifest omits it", async () => {
    await sql`UPDATE code.policy_rules SET value='never' WHERE row='read' AND group_id IS NULL`;
    await error({ operation: "example.read" }, "code_policy_never", 200);
  });
  test("lease loss between admission and signing never reaches the provider", async () => {
    beforeIssue = async () => {
      await sql`UPDATE code.runs SET generation=2 WHERE id=${claims.runId}::uuid`;
    };
    await error({}, "runner_lease_lost", 409);
  });
  test("policy tightening between admission and signing never reaches the provider", async () => {
    beforeIssue = async () => {
      await sql`UPDATE code.policy_rules SET value='never' WHERE row='silent_shared' AND group_id IS NULL`;
    };
    await error({}, "code_policy_never", 200);
  });
  test("generic mandate dispatch cannot bypass the verified bridge", async () => {
    const response = await dispatchCapability({
      request: new Request("http://core.test"),
      kind: "actions",
      appId: "example",
      capabilityId: "write",
      target: item,
      input: {},
      origin: "app",
      mandate: { mandateId: claims.mandateId, mandateRevision: 1, ownerAppId: "core" },
      dependencies: dependencies().dispatch,
    });
    expect(response.status).toBe(403);
  });
  test("successful calls are ordered and stored before the provider runs", async () => {
    expect(await (await send()).json()).toEqual({ ok: true, data: { value: "a" } });
    expect(await (await send()).json()).toEqual({ ok: true, data: { value: "a" } });
    const rows = await sql<
      { ordinal: number; state: string; result: unknown }[]
    >`SELECT ordinal,state,result FROM code.calls WHERE run_id=${claims.runId}::uuid ORDER BY ordinal`;
    expect(rows.map((row) => [row.ordinal, row.state])).toEqual([
      [1, "succeeded"],
      [2, "succeeded"],
    ]);
  });
});
