import { afterAll, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { Readable } from "node:stream";
import * as decision from "@k2b/cloud/ai";
import { err } from "@k2b/stdlib";
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { APP_KEY_FIXTURES } from "../../../../scripts/fixtures/app-key-fixtures";
import { suiteFor, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { aiDecisionQuery } from "../../../core/src/ai-decision-capability";
import { decisionInputFixture, decisionResultFixture } from "../../../core/src/ai-decision-capability.test-fixture";
import { aiGenerationQuery } from "../../../core/src/ai-generation-capability";
import { reserveCodeAiBudget, settleCodeAiBudget } from "../../../core/src/code/ai-budget";
import { codeAiFileTool } from "../../../core/src/code/ai-loop";
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
import { migrate as migrateLogging } from "../../../core/src/migrate/core/logging";
import { migrate as migrateRailPreferences } from "../../../core/src/migrate/core/rail-preferences";
import { migrate as migrateRailShortcuts } from "../../../core/src/migrate/core/rail-shortcuts";
import { migrate as migrateSettings } from "../../../core/src/migrate/core/settings";
import { migrate as migrateWorkflows } from "../../../core/src/migrate/core/workflows";
import { mailCapabilities } from "../../../mail/src/capabilities";
import { migrate as migrateMail } from "../../../mail/src/migrate";
import { storeReadableBlob } from "../../../mail/src/service/message-blobs";
import * as mailMessages from "../../../mail/src/service/messages";
import { compileCapabilities, invokeCompiledCapability, serializeCapabilityProviderResult } from "../_internal/capabilities";
import { invokeCapabilityStream } from "../_internal/capability-streams";
import * as registry from "../_internal/registry";
import { aiModelFixture, aiSettingsFixture } from "../ai/model-fixture";
import { migrateAiQuotas } from "../ai/quotas-migrate";
import {
  type CapabilityDispatchDependencies,
  codeHttpOriginAllowed,
  createCodeRunnerCallRoutes,
  dispatchCapability,
  dispatchCodeSdkCall,
} from "../api/capabilities";
import { dispatchCapabilityStream } from "../api/capability-streams";
import { readCodeAiFile } from "../api/code-file-reader";
import type { AppKey } from "../app-key";
import { signAppProof } from "../app-proof";
import { migrateCloudCapabilities } from "../capabilities/migrate";
import { compileCapabilityManifest } from "../capabilities/testing";
import type { CapabilityError, CodeCheckedVersionManifest } from "../contracts";
import type { AppEventEnvelope } from "../contracts/app-events";
import {
  type CapabilityExecutionContext,
  CapabilityFileMetadataSchema,
  CapabilityInvocationBodySchema,
  capabilityResultSchema,
} from "../contracts/capabilities";
import type { CapabilityRegistryEntry } from "../contracts/registry";
import { appEventFixture, installLiveOutbox } from "../events/testing";
import { sql } from "../runtime/clients";
import { getEffectivePermission, hasPermission } from "../server";
import { AppAccessDeniedError } from "../server/middleware/app-access";
import * as rateLimits from "../server/ratelimit";
import { coreSettings } from "../services";
import { appKeys } from "../services/app-keys";
import { approvalArgsDigest } from "../services/approvals";
import { resolveInvocationAuthority } from "../services/identity/invocation-actor";
import { type CloudInvocationClaims, verifyInvocationToken } from "../services/identity/invocation-token";
import { issueInvocationToken } from "../services/identity/issue-invocation";
import { mandates } from "../services/mandates";
import { loadCodeRunCalls } from "../ssr/code-page/calls";
import type { CodePageInvoke } from "../ssr/code-page/data";
import { createCodeAiTools } from "./ai-tools";
import { CodeFileRefSchema } from "./file-ref";
import { CodeRunTokenClaimsSchema, type CodeRunTokenInput, signCodeRunToken, verifyCodeRunToken } from "./run-token";
import { RUNNER_PATHS, type RunnerCallRequest, type RunnerJsonValue } from "./runner-protocol";

// real clock: Postgres fences use its own clock, so the frozen JS clock starts from the real time of this run.
const now = new Date(Math.floor(Date.now() / 1000) * 1000);
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
    removes: { ...actionOp, target: "folder", destructive: true, idempotency: "required", policy: { ask: "deletes" } },
    sends: { ...actionOp, target: "folder", destructive: false, openWorld: true, idempotency: "required", policy: { ask: "sends" } },
    interactive: {
      ...actionOp,
      target: "folder",
      destructive: false,
      idempotency: "none",
      policy: { silent: "shared" },
      unattended: false,
    },
    no_routines: { ...actionOp, target: "folder", destructive: false, idempotency: "none", policy: { silent: "shared", routines: false } },
    asks: { ...actionOp, target: "folder", destructive: false, idempotency: "none", policy: { ask: "app_asks" } },
  },
});
const confirmationCompiled = compileCapabilities("example", {
  protocolVersion: 2,
  types: { folder: { title: "Folder", description: "Fixture folder." } },
  actions: {
    write: {
      ...actionOp,
      target: "folder",
      destructive: false,
      idempotency: "none",
      policy: { silent: "shared" },
      review: () => ({ ok: true as const, data: { ...actionOp.review().data, ask: "involves_people" as const } }),
    },
  },
});
const decisionCompiled = compileCapabilities("core", {
  protocolVersion: 2,
  queries: { "ai.decide": aiDecisionQuery, "ai.generate": aiGenerationQuery, "ai.skills.list": op },
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
  let aiSettingsSpy: ReturnType<typeof spyOn<typeof decision, "readAiSettingsState">>;
  let registrySpy: ReturnType<typeof spyOn<typeof registry, "getApp">>;
  let capabilitySpy: ReturnType<typeof spyOn<typeof registry, "getCapability">>;
  let claims: CodeRunTokenInput;
  let targetAccess: string;
  let fetched = 0;
  let currentEntry = baseEntry;
  let targetFailure: CapabilityError | null = null;
  let providerRequestsConfirmation = false;
  let queryCursor: string | undefined;
  let callLimit = 200;
  let aiBudget = 1;
  let rateLimited = false;
  let realRate = false;
  let realAdmission = false;
  let beforeIssue: (() => Promise<void>) | undefined;
  let fileTransport: CapabilityDispatchDependencies["fetch"] | undefined;
  let fileEntries = new Map<string, CapabilityRegistryEntry>();
  let mailMigrated = false;
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
      getCapability: async (id: string) => fileEntries.get(id) ?? (id === currentEntry.appId ? currentEntry : null),
      withActiveSigner: withSigner,
      signInvocation: async (params, options) => issueInvocationToken(params, { ...options, groupsAdmin: [] }),
      fetch: async (_url, init) => {
        fetched++;
        if (fileTransport) return fileTransport(_url, init);
        const headers = new Headers(init?.headers);
        const invocationBody = JSON.parse(String(init?.body));
        const operation =
          currentEntry.manifest.actions.find(
            (candidate) => !String(_url).includes("/review") && String(_url).endsWith(`/${candidate.localId}`),
          ) ?? currentEntry.manifest.queries.find((candidate) => String(_url).endsWith(`/${candidate.localId}`))!;
        const verified = await verifyInvocationToken(
          headers.get("authorization")!.slice(7),
          {
            targetAppId: currentEntry.appId,
            operation: `${"destructive" in operation ? "capability.action.run" : "capability.query"}:${operation.localId}`,
            schemaHash: operation.schemaHash,
          },
          { issuer, key, now },
        );
        const authority = verified ? await resolveInvocationAuthority(verified, sql, []) : null;
        if (currentEntry.appId === "core") {
          if (!authority) throw new Error("Expected verified Code authority");
          const outcome = await invokeCompiledCapability({
            compiled: decisionCompiled,
            kind: "query",
            localId: operation.localId,
            expectedSchemaHash: decisionCompiled.queries.get(operation.localId)!.manifest.schemaHash,
            input: invocationBody.input,
            context: {
              authority,
              actor: authority.actor,
              accessSubject: authority.accessSubject,
              user: null,
              locale: "en",
              requestId: "bridge-decision",
              origin: "app",
              signal: new AbortController().signal,
            },
          });
          const wire = serializeCapabilityProviderResult(outcome);
          return new Response(wire.body, { status: wire.status, headers: { "content-type": "application/json" } });
        }
        const body = z.object({ target: z.object({ id: z.string() }) }).parse(invocationBody);
        const permission = authority
          ? await getEffectivePermission({ accessIds: [targetAccess], subject: authority.accessSubject })
          : "none";
        if (!hasPermission(permission, "write")) return Response.json({ code: "FORBIDDEN", message: "No Code access" }, { status: 403 });
        if (providerRequestsConfirmation && authority) {
          const outcome = await invokeCompiledCapability({
            compiled: confirmationCompiled,
            kind: "action",
            localId: "write",
            target: item,
            input: {},
            expectedSchemaHash: confirmationCompiled.actions.get("write")!.manifest.schemaHash,
            context: {
              authority,
              actor: authority.actor,
              accessSubject: authority.accessSubject,
              user: null,
              locale: "en",
              requestId: "provider-asks",
              origin: "app",
              signal: new AbortController().signal,
            },
          });
          expect(outcome).toMatchObject({ ok: false, error: { code: "CODE_UNATTENDED_FORBIDDEN", status: 403 } });
          if (!outcome.ok) {
            const { status, ...failure } = outcome.error;
            return Response.json(failure, { status });
          }
        }
        if (targetFailure)
          return Response.json({ code: targetFailure.code, message: targetFailure.message }, { status: targetFailure.status });
        return Response.json({
          data: { value: body.target.id },
          ...(queryCursor === undefined ? {} : { page: { hasMore: true, nextCursor: queryCursor } }),
        });
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
  const error = async (options: Parameters<typeof send>[0], code: string, status?: number, capabilityStatus?: number) => {
    const before = fetched;
    const response = await send(options);
    expect(response.status).toBe(status ?? 200);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code, ...(capabilityStatus === undefined ? {} : { status: capabilityStatus }) },
    });
    expect(fetched).toBe(before);
  };
  async function expectPolicyRefusal(kind: "policy" | "approval" = "policy") {
    const [row] = await sql`SELECT c.refusal_kind,r.first_refused_call_ordinal FROM code.calls c JOIN code.runs r ON r.id=c.run_id
      WHERE c.run_id=${claims.runId}::uuid ORDER BY c.ordinal DESC LIMIT 1`;
    expect(row).toMatchObject({ refusal_kind: kind, first_refused_call_ordinal: null });
  }
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
    // Shared Code AI admission includes actual Code-started chat inference costs.
    await sql`CREATE SCHEMA IF NOT EXISTS ai`.simple();
    await migrateAiQuotas();
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
      name === "core.code.calls_per_run"
        ? callLimit
        : name === "core.code.calls_per_second"
          ? 1
          : name === "core.code.ai_budget_usd"
            ? aiBudget
            : CODE_SETTINGS[name].default,
    );
    aiSettingsSpy = spyOn(decision, "readAiSettingsState").mockResolvedValue(
      aiSettingsFixture({
        profiles: [aiModelFixture({ id: "clef", pricing: { inputPerMillion: 1, outputPerMillion: 2 } })],
      }),
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
    capabilitySpy = spyOn(registry, "getCapability").mockImplementation(
      async (id) => fileEntries.get(id) ?? (id === currentEntry.appId ? currentEntry : null),
    );
  });
  async function resetFixture(
    options: {
      personal?: boolean;
      invalidEntrypoint?: boolean;
      entry?: boolean;
      policyRows?: CodeCheckedVersionManifest["policyRows"];
      permissions?: CodeCheckedVersionManifest["permissions"];
      entrypointKind?: "schedule" | "route";
      event?: AppEventEnvelope;
    } = {},
  ) {
    currentEntry = structuredClone(baseEntry);
    callLimit = 200;
    queryCursor = undefined;
    aiBudget = 1;
    rateLimited = false;
    realRate = false;
    realAdmission = false;
    beforeIssue = undefined;
    await sql`UPDATE code.policy_rules SET value='automatic' WHERE group_id IS NULL`;
    const codeId = `c_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const [account] = await sql<
      { id: string }[]
    >`INSERT INTO auth.service_accounts(name,kind) VALUES(${`code:${options.event?.place?.type ?? "example.folder"}:${options.event?.place?.id ?? codeId}`},'code') RETURNING id`;
    if (options.personal)
      await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title,state) VALUES(${codeId},'person',${userId}::uuid,'Fixture','active')`;
    else
      await sql`INSERT INTO code.codes(id,owner_kind,owner_type,owner_id,title,service_account_id,state) VALUES(${codeId},'resource',${options.event?.place?.type ?? "example.folder"},${options.event?.place?.id ?? codeId},'Fixture',${account!.id}::uuid,'active')`;
    const files = { "code.ts": "fixture" },
      bundle = "fixture";
    const entrypoint = options.event
      ? `event:${options.event.type}@${options.event.version}`
      : options.invalidEntrypoint
        ? "different"
        : options.entrypointKind === "route"
          ? "route:GET:/"
          : "weekly";
    const trigger = options.event ? "event" : options.entrypointKind === "route" ? "path" : (options.entrypointKind ?? "manual");
    const runEntrypoint = options.invalidEntrypoint ? "weekly" : entrypoint;
    const checked: CodeCheckedVersionManifest = {
      version: 1,
      entry: "code.ts",
      entrypoints: [
        options.event
          ? {
              kind: "event",
              entrypoint,
              cron: null,
              file: "code.ts",
              line: 1,
              event: { type: options.event.type, version: options.event.version, place: options.event.place! },
            }
          : options.entrypointKind === "route"
            ? { kind: "route", entrypoint, route: { method: "GET", path: "/", public: false }, cron: null, file: "code.ts", line: 1 }
            : {
                kind: options.entrypointKind ?? "manual",
                entrypoint,
                cron: options.entrypointKind === "schedule" ? "0 8 * * 1" : null,
                file: "code.ts",
                line: 1,
              },
      ],
      hashes: { source: codeSourceHash(files, "code.ts"), bundle: codeBundleHash(bundle), sdk: "a".repeat(64) },
      permissions: options.permissions ?? [
        ...[...manifest.queries, ...manifest.actions].map((operation) => ({
          operation: `example.${operation.localId}`,
          target: item,
          file: "code.ts",
          line: 1,
        })),
        ...[...decisionCompiled.manifest.queries, ...decisionCompiled.manifest.actions].map((operation) => ({
          operation: `core.${operation.localId}`,
          target: null,
          file: "code.ts",
          line: 1,
        })),
      ],
      ai: options.policyRows?.includes("ai") ?? false,
      policyRows: options.policyRows ?? ["silent_shared"],
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
    >`INSERT INTO code.runs(code_id,version_id,trigger,entrypoint,input,state,started_at,lease_expires_at,generation,payload_bytes,calls_limit) VALUES(${codeId},${version!.id}::uuid,${trigger},${runEntrypoint},${JSON.stringify(options.event ?? null)}::text::jsonb,'running',clock_timestamp(),clock_timestamp()+interval '10 minutes',1,32768,200) RETURNING id`;
    const created = await mandates.create({
      authority: { kind: "admin", userId },
      subject: { type: "service_account", id: account!.id },
      ownerAppId: options.entry ? "runner" : "core",
      workloadType: "code.version",
      workloadId: version!.id,
      policy: options.entry
        ? null
        : {
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
      entrypoint: runEntrypoint,
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
  beforeEach(async () => {
    await sql`TRUNCATE code.ai_daily_budget`;
    targetFailure = null;
    fileTransport = undefined;
    fileEntries = new Map();
    providerRequestsConfirmation = false;
    await resetFixture();
  });
  afterAll(async () => {
    settingsSpy?.mockRestore();
    aiSettingsSpy?.mockRestore();
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
  test("the actual decision call applies the KI policy even without checker AI classification", async () => {
    await resetFixture({ entry: true, policyRows: ["read"] });
    await sql`UPDATE code.policy_rules SET value='never' WHERE row='ai' AND group_id IS NULL`;
    const entry = { ...baseEntry, appId: "core", manifest: decisionCompiled.manifest };
    const response = await send({
      entry,
      operation: "core.ai.decide",
      input: { call: { capability: "core.ai.decide", target: null, refs: {}, input: decisionInputFixture }, metadata: {} },
    });
    expect(await response.json()).toEqual({ ok: false, error: { code: "code_policy_never" } });
    await expectPolicyRefusal();
  });
  test.each([false, true])("Code decision query reaches runAiDecision with the workload subject (personal=%s)", async (personal) => {
    await resetFixture({ personal, entry: true, policyRows: ["read", "ai"] });
    if (personal)
      await sql`UPDATE auth.mandates SET subject_kind='user',subject_user_id=${userId}::uuid,subject_service_account_id=NULL WHERE id=${claims.mandateId}::uuid`;
    const run = spyOn(decision, "runAiDecision").mockResolvedValue(decisionResultFixture);
    try {
      const entry = { ...baseEntry, appId: "core", manifest: decisionCompiled.manifest };
      const response = await send({
        entry,
        operation: "core.ai.decide",
        input: { call: { capability: "core.ai.decide", target: null, refs: {}, input: decisionInputFixture }, metadata: {} },
      });
      expect(await response.json()).toEqual({ ok: true, data: { data: decisionResultFixture } });
      const [code] = await sql<
        { service_account_id: string | null }[]
      >`SELECT service_account_id FROM code.codes WHERE id=${claims.codeId}`;
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          usageSubject: personal ? { type: "user", userId } : { type: "service_account", serviceAccountId: code!.service_account_id },
        }),
      );
    } finally {
      run.mockRestore();
    }
  });
  test.each([false, true])("Code generation preserves workload accounting and policy KI (personal=%s)", async (personal) => {
    await resetFixture({ personal, entry: true, policyRows: ["ai"] });
    if (personal)
      await sql`UPDATE auth.mandates SET subject_kind='user',subject_user_id=${userId}::uuid,subject_service_account_id=NULL WHERE id=${claims.mandateId}::uuid`;
    const run = spyOn(decision, "runAiStructured").mockResolvedValue({
      output: { text: "Summary" },
      model: decisionResultFixture.model,
      usage: decisionResultFixture.usage,
      structuredMeta: { mode: "native", repaired: false, attempts: 1, usedResponseFormat: true },
    });
    try {
      const response = await send({
        entry: { ...baseEntry, appId: "core", manifest: decisionCompiled.manifest },
        operation: "core.ai.generate",
        input: {
          call: {
            capability: "core.ai.generate",
            target: null,
            refs: {},
            input: { task: "mail.summary", prompt: "Summarize.", input: { body: "Message" }, output: { type: "text", maxChars: 500 } },
          },
          metadata: {},
        },
      });
      expect(await response.json()).toMatchObject({ ok: true, data: { data: { output: "Summary" } } });
      const [code] = await sql<
        { service_account_id: string | null }[]
      >`SELECT service_account_id FROM code.codes WHERE id=${claims.codeId}`;
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          usageSubject: personal ? { type: "user", userId } : { type: "service_account", serviceAccountId: code!.service_account_id },
        }),
      );
      const counters = await sql<
        { scope_kind: string; cost: string }[]
      >`SELECT scope_kind,reference_cost::text AS cost FROM code.ai_daily_budget
        WHERE scope_key=${claims.codeId} OR scope_key=json_build_array('person',${userId}::text)::text ORDER BY scope_kind`;
      expect(counters.find((counter) => counter.scope_kind === "code")?.cost).toBe("0.000046000000");
    } finally {
      run.mockRestore();
    }
  });

  test.each([false, true])(
    "signed Core AI initializes a file loop from the real run, version and mandate schema (personal=%s)",
    async (personal) => {
      await resetFixture({ personal, entry: true, policyRows: ["ai"] });
      if (personal)
        await sql`UPDATE auth.mandates SET subject_kind='user',subject_user_id=${userId}::uuid,subject_service_account_id=NULL WHERE id=${claims.mandateId}::uuid`;
      await sql`UPDATE code.runs SET deadline_at=clock_timestamp()+interval '5 minutes' WHERE id=${claims.runId}::uuid`;
      const selected = spyOn(decision, "selectAssistantAiModel").mockResolvedValue({ id: "clef" });
      const resolved = spyOn(decision, "resolveAiModel").mockResolvedValue({
        model: decisionResultFixture.model,
        profile: aiModelFixture({ id: "clef", contextWindow: 32_768 }),
        provider: {
          name: "fixture",
          family: "openai-compatible",
          model: "fixture",
          capabilities: { streaming: true, tools: true, images: true, thinking: false, usage: true },
          async *stream() {},
        },
      });
      const run = spyOn(decision, "runAiStructured").mockResolvedValue({
        output: { text: "Summary" },
        model: decisionResultFixture.model,
        usage: decisionResultFixture.usage,
        structuredMeta: { mode: "native", repaired: false, attempts: 1, usedResponseFormat: true },
      });
      try {
        const response = await send({
          entry: { ...baseEntry, appId: "core", manifest: decisionCompiled.manifest },
          operation: "core.ai.generate",
          input: {
            call: {
              capability: "core.ai.generate",
              target: null,
              refs: {},
              input: {
                task: "mail.summary",
                prompt: "Summarize.",
                // A ref in input starts the loop but does not read bytes until a viewer asks.
                input: { file: { id: "not-yet-opened", mediaType: "text/plain", size: 12 } },
                fileTools: false,
                output: { type: "text", maxChars: 500 },
              },
            },
            metadata: {},
          },
        });
        expect(await response.json()).toMatchObject({ ok: true, data: { data: { output: "Summary" } } });
        expect(run).toHaveBeenCalledTimes(1);
        expect(run.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal);
        expect(run.mock.calls[0]![0].tools).toBeUndefined();
        expect(resolved).toHaveBeenCalledTimes(1);
      } finally {
        selected.mockRestore();
        resolved.mockRestore();
        run.mockRestore();
      }
    },
  );

  test.each([false, true])("generation failures settle known usage before payload-free runner projection (unknown=%s)", async (unknown) => {
    await resetFixture({ personal: true, entry: true, policyRows: ["ai"] });
    await sql`UPDATE auth.mandates SET subject_kind='user',subject_user_id=${userId}::uuid,subject_service_account_id=NULL WHERE id=${claims.mandateId}::uuid`;
    const run = spyOn(decision, "runAiStructured").mockImplementation(async (request) => {
      request.onUsage?.({ model: decisionResultFixture.model, usage: { input: 30, output: 2 } });
      request.onUsage?.({ model: decisionResultFixture.model, usage: unknown ? undefined : { input: 10, output: 1, estimated: true } });
      throw Object.assign(new Error("private provider failure"), { code: "quota_exhausted" });
    });
    try {
      const response = await send({
        entry: { ...baseEntry, appId: "core", manifest: decisionCompiled.manifest },
        operation: "core.ai.generate",
        input: {
          call: {
            capability: "core.ai.generate",
            target: null,
            refs: {},
            input: {
              task: "mail.summary",
              prompt: "Summarize.",
              input: { body: "Message" },
              output: { type: "text", maxChars: 500 },
            },
          },
          metadata: {},
        },
      });
      expect(await response.json()).toEqual({ ok: false, error: { code: "quota_exhausted", status: 429 } });
      const [budget] = await sql`SELECT ai_reference_cost::text AS cost,ai_reserved_cost::text AS reserved,ai_budget_call
        FROM code.runs WHERE id=${claims.runId}::uuid`;
      expect(run).toHaveBeenCalledTimes(1);
      expect(budget).toEqual({ cost: unknown ? "1.000000000000" : "0.000046000000", reserved: "0", ai_budget_call: null });
      const counters = await sql<{ cost: string }[]>`SELECT reference_cost::text AS cost FROM code.ai_daily_budget
        WHERE scope_key=${claims.codeId} OR scope_key=json_build_array('person',${userId}::text)::text`;
      expect(counters).toHaveLength(2);
      expect(counters.every((counter) => counter.cost === budget!.cost)).toBe(true);
    } finally {
      run.mockRestore();
    }
  });

  test("daily Code and exact-owner counters reserve together and a stale generation cannot release them", async () => {
    await resetFixture({ personal: true, entry: true, policyRows: ["ai"] });
    const daily = { code: 0.5, owner: 0.75, timeZone: "UTC" };
    const reserve = (ordinal: number) => sql.begin((db) => reserveCodeAiBudget(claims, ordinal, 1, db, daily));
    expect(await reserve(1)).toEqual({ ok: true, reserved: "0.500000000000" });
    expect(await reserve(2)).toEqual({ ok: false, code: "code_ai_budget_reserved" });
    await sql.begin((db) => settleCodeAiBudget({ ...claims, generation: claims.generation + 1 }, 1, "0", db));
    expect(await reserve(3)).toEqual({ ok: false, code: "code_ai_budget_reserved" });
    await sql.begin((db) => settleCodeAiBudget(claims, 1, "0.5", db));
    expect(await reserve(4)).toEqual({ ok: false, code: "code_ai_daily_budget_limit" });
    // A new personal Code under the same owner cannot evade the aggregate owner allowance.
    const previous = { ...claims };
    await resetFixture({ personal: true, entry: true, policyRows: ["ai"] });
    const second = await reserve(1);
    expect(second).toEqual({ ok: true, reserved: "0.250000000000" });
    const attempts = await Promise.all([reserve(2), reserve(3)]);
    expect(attempts.every((result) => !result.ok)).toBe(true);
    await sql.begin((db) => settleCodeAiBudget(claims, 1, "0.25", db));
    expect(await reserve(4)).toEqual({ ok: false, code: "code_ai_owner_daily_budget_limit" });
    // The old Code's recorded spend is independent of the new Code's run.
    const [spent] = await sql<{ cost: string }[]>`SELECT ai_reference_cost::text AS cost FROM code.runs WHERE id=${previous.runId}::uuid`;
    expect(spent?.cost).toBe("0.5");
  });

  test("concurrent runs of different Code cannot spend one owner's reserved daily allowance", async () => {
    await resetFixture({ personal: true, entry: true, policyRows: ["ai"] });
    const first = { ...claims };
    await resetFixture({ personal: true, entry: true, policyRows: ["ai"] });
    const second = { ...claims };
    const daily = { code: 1, owner: 0.5, timeZone: "UTC" };
    const outcomes = await Promise.all([first, second].map((run) => sql.begin((db) => reserveCodeAiBudget(run, 1, 0.5, db, daily))));
    expect(outcomes.filter((result) => result.ok)).toHaveLength(1);
    expect(outcomes.find((result) => !result.ok)).toEqual({ ok: false, code: "code_ai_owner_daily_budget_limit" });
    const admitted = outcomes[0]!.ok ? first : second;
    await sql.begin((db) => settleCodeAiBudget(admitted, 1, "0", db));
    const refused = outcomes[0]!.ok ? second : first;
    expect(await sql.begin((db) => reserveCodeAiBudget(refused, 2, 0.5, db, daily))).toEqual({ ok: true, reserved: "0.500000000000" });
  });

  test("settlement retains the admission day across midnight and releases only its own reservation", async () => {
    await resetFixture({ entry: true, policyRows: ["ai"] });
    const reserve = await sql.begin((db) => reserveCodeAiBudget(claims, 1, 1, db, { code: 1, owner: 1, timeZone: "UTC" }));
    expect(reserve.ok).toBe(true);
    const [period] = await sql<
      { day: string; owner_key: string }[]
    >`SELECT ai_budget_day::text AS day,ai_budget_owner_key AS owner_key FROM code.runs WHERE id=${claims.runId}::uuid`;
    // Move the reservation and counters into a fixed prior day to model an in-flight midnight crossing.
    await sql`UPDATE code.ai_daily_budget SET day='2000-01-01' WHERE day=${period!.day}::date
      AND (scope_key=${claims.codeId} OR scope_key=${period!.owner_key})`;
    await sql`UPDATE code.runs SET ai_budget_day='2000-01-01' WHERE id=${claims.runId}::uuid`;
    await sql.begin((db) => settleCodeAiBudget(claims, 1, "0.1", db));
    const prior = await sql<{ cost: string }[]>`SELECT reference_cost::text AS cost FROM code.ai_daily_budget WHERE day='2000-01-01'
      AND (scope_key=${claims.codeId} OR scope_key=${period!.owner_key})`;
    expect(prior.map((row) => row.cost)).toEqual(["0.100000000000", "0.100000000000"]);
    expect(await sql.begin((db) => reserveCodeAiBudget(claims, 2, 1, db, { code: 1, owner: 1, timeZone: "UTC" }))).toEqual({
      ok: true,
      reserved: "0.900000000000",
    });
  });

  const sendDecision = () =>
    send({
      entry: { ...baseEntry, appId: "core", manifest: decisionCompiled.manifest },
      operation: "core.ai.decide",
      input: { call: { capability: "core.ai.decide", target: null, refs: {}, input: decisionInputFixture }, metadata: {} },
    });
  test("zero Code AI budget refuses before any model call and records a policy refusal", async () => {
    await resetFixture({ entry: true, policyRows: ["ai"] });
    aiBudget = 0;
    const run = spyOn(decision, "runAiDecision").mockResolvedValue(decisionResultFixture);
    try {
      expect(await (await sendDecision()).json()).toEqual({ ok: false, error: { code: "code_ai_budget_limit" } });
      expect(run).not.toHaveBeenCalled();
      await expectPolicyRefusal();
    } finally {
      run.mockRestore();
    }
  });
  test("returned reference cost exhausts the attempt budget before the next AI call", async () => {
    await resetFixture({ entry: true, policyRows: ["ai"] });
    aiBudget = 0.000046;
    const run = spyOn(decision, "runAiDecision").mockResolvedValue(decisionResultFixture);
    try {
      expect(await (await sendDecision()).json()).toEqual({ ok: true, data: { data: decisionResultFixture } });
      expect(await (await sendDecision()).json()).toEqual({ ok: false, error: { code: "code_ai_budget_limit" } });
      expect(run).toHaveBeenCalledTimes(1);
      const [cost] =
        await sql`SELECT ai_reference_cost::text AS cost,ai_reserved_cost::text AS reserved,ai_budget_call FROM code.runs WHERE id=${claims.runId}::uuid`;
      expect(cost).toEqual({ cost: "0.000046000000", reserved: "0", ai_budget_call: null });
      await expectPolicyRefusal();
    } finally {
      run.mockRestore();
    }
  });
  test("parallel AI calls cannot reserve the same attempt remainder across bridge hosts", async () => {
    await resetFixture({ entry: true, policyRows: ["ai"] });
    aiBudget = 0.000046;
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const run = spyOn(decision, "runAiDecision").mockResolvedValue(decisionResultFixture);
    beforeIssue = async () => {
      started.resolve();
      await finish.promise;
    };
    const first = sendDecision();
    try {
      await Promise.race([
        started.promise,
        first.then(async (response) => {
          throw new Error(`Reservation was not reached: ${JSON.stringify(await response.clone().json())}`);
        }),
      ]);
      const responses = await Promise.all([sendDecision(), sendDecision()]);
      for (const response of responses) expect(await response.json()).toEqual({ ok: false, error: { code: "code_ai_budget_reserved" } });
      expect(run).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      try {
        expect(await (await first).json()).toEqual({ ok: true, data: { data: decisionResultFixture } });
        expect(run).toHaveBeenCalledTimes(1);
      } finally {
        run.mockRestore();
      }
    }
    expect(await (await sendDecision()).json()).toEqual({ ok: false, error: { code: "code_ai_budget_limit" } });
  });
  test("settlement releases unused reservation and sums later AI calls", async () => {
    await resetFixture({ entry: true, policyRows: ["ai"] });
    aiBudget = 0.000092;
    const run = spyOn(decision, "runAiDecision").mockResolvedValue(decisionResultFixture);
    try {
      for (let call = 0; call < 2; call++)
        expect(await (await sendDecision()).json()).toEqual({ ok: true, data: { data: decisionResultFixture } });
      expect(await (await sendDecision()).json()).toEqual({ ok: false, error: { code: "code_ai_budget_limit" } });
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      run.mockRestore();
    }
  });
  test("a successful non-model AI query releases its reservation without spending the budget", async () => {
    await resetFixture({ entry: true, policyRows: ["ai"] });
    aiBudget = 0.000046;
    const run = spyOn(decision, "runAiDecision").mockResolvedValue(decisionResultFixture);
    try {
      const response = await send({
        entry: { ...baseEntry, appId: "core", manifest: decisionCompiled.manifest },
        operation: "core.ai.skills.list",
        input: { call: { capability: "core.ai.skills.list", target: null, refs: {}, input: {} }, metadata: {} },
      });
      expect(await response.json()).toEqual({ ok: true, data: { data: { value: "done" } } });
      expect(run).not.toHaveBeenCalled();
      expect(await (await sendDecision()).json()).toEqual({ ok: true, data: { data: decisionResultFixture } });
    } finally {
      run.mockRestore();
    }
  });
  test("pre-model quota and settings refusals release or avoid the reservation", async () => {
    await resetFixture({ entry: true, policyRows: ["ai"] });
    aiBudget = 0.000046;
    const run = spyOn(decision, "runAiDecision").mockRejectedValueOnce(
      new decision.AiQuotaError("quota_exhausted", "Chat usage limit reached."),
    );
    try {
      expect(await (await sendDecision()).json()).toMatchObject({ ok: false, error: { code: "quota_exhausted", status: 429 } });
      const [budget] = await sql`SELECT ai_reference_cost::text AS cost,ai_reserved_cost::text AS reserved,ai_budget_call
        FROM code.runs WHERE id=${claims.runId}::uuid`;
      expect(budget).toEqual({ cost: "0", reserved: "0", ai_budget_call: null });
      aiSettingsSpy.mockRejectedValueOnce(new Error("fixture unavailable"));
      expect(await (await sendDecision()).json()).toEqual({ ok: false, error: { code: "code_bridge_unavailable" } });
      run.mockResolvedValue(decisionResultFixture);
      expect(await (await sendDecision()).json()).toEqual({ ok: true, data: { data: decisionResultFixture } });
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      run.mockRestore();
    }
  });
  test("policy refusal at issuance releases the AI reservation", async () => {
    await resetFixture({ entry: true, policyRows: ["ai"] });
    aiBudget = 0.000046;
    const run = spyOn(decision, "runAiDecision").mockResolvedValue(decisionResultFixture);
    try {
      beforeIssue = async () => {
        await sql`UPDATE code.policy_rules SET value='never' WHERE group_id IS NULL AND row='ai'`;
      };
      expect(await (await sendDecision()).json()).toEqual({ ok: false, error: { code: "code_policy_never" } });
      expect(run).not.toHaveBeenCalled();
      beforeIssue = undefined;
      await sql`UPDATE code.policy_rules SET value='automatic' WHERE group_id IS NULL AND row='ai'`;
      expect(await (await sendDecision()).json()).toEqual({ ok: true, data: { data: decisionResultFixture } });
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      run.mockRestore();
    }
  });
  test("Code budget zero leaves non-AI capability calls unaffected", async () => {
    aiBudget = 0;
    const before = fetched;
    expect(await (await send()).json()).toEqual({ ok: true, data: { value: item.id } });
    expect(fetched).toBeGreaterThan(before);
  });
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
    const [heartbeat] = await sql<{ live: boolean; bounded: boolean }[]>`SELECT lease_expires_at>clock_timestamp() AS live,
      lease_expires_at<=to_timestamp(${Math.floor(now.getTime() / 1000) + 300}) AS bounded FROM code.runs WHERE id=${claims.runId}::uuid`;
    expect(heartbeat).toEqual({ live: true, bounded: true });
    const bad = await runnerProtocolRequest(RUNNER_PATHS.bundle, { ...proof, bundleHash: "f".repeat(64) });
    expect(bad.status).toBe(403);
    expect((await runnerProtocolRequest(RUNNER_PATHS.complete, { ...proof, outcome: "succeeded" })).status).toBe(204);
    const [completed] = await sql`SELECT state,lease_expires_at FROM code.runs WHERE id=${claims.runId}::uuid`;
    expect(completed).toEqual({ state: "succeeded", lease_expires_at: null });
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
  test("own HTTP origins are refused at bridge ingress", async () => {
    await error({ operation: "http.fetch", input: { url: `${issuer}/api/auth` } }, "code_http_origin_forbidden");
    await expectPolicyRefusal();
  });
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
  test("target refusals survive dispatch, SQL storage and Code page data without provider payload", async () => {
    // Spaces requireSpaceUuid returns this error (with a localized message); its code is NOT_FOUND.
    for (const failure of [err.notFound("Space"), err.forbidden("Access denied"), err.internal("Unavailable")]) {
      targetFailure = failure.code === "FORBIDDEN" ? null : failure;
      if (failure.code === "FORBIDDEN") await sql`UPDATE auth.access SET permission='read' WHERE id=${targetAccess}::uuid`;
      else await sql`UPDATE auth.access SET permission='write' WHERE id=${targetAccess}::uuid`;
      // Queries preserve unrelated target failures instead of Action outcome-unknown conversion.
      const response = await send({ operation: "example.read" });
      expect(response.status).toBe(200);
      const [stored] = await sql<{ result: unknown; ordinal: number; state: string; kind: string; capability: string; call: unknown }[]>`
        SELECT result,ordinal,state,kind,call->>'capability' AS capability,call FROM code.calls WHERE run_id=${claims.runId}::uuid ORDER BY ordinal DESC LIMIT 1`;
      const expected = { ok: false, error: { code: failure.code.toLowerCase(), status: failure.status } };
      expect(stored?.result).toEqual(expected);
      expect(stored?.state).toBe("failed");
      const [classification] = await sql`SELECT c.refusal_kind,r.first_refused_call_ordinal FROM code.calls c
        JOIN code.runs r ON r.id=c.run_id WHERE c.run_id=${claims.runId}::uuid AND c.ordinal=${stored!.ordinal}`;
      expect(classification?.refusal_kind).toBe(failure.status === 403 || failure.status === 404 ? "target_refused" : "bridge");
      expect(classification?.first_refused_call_ordinal).toBe(1);
      expect(await response.json()).toEqual(expected);
      const invoke: CodePageInvoke = async (_invocation, schema) => ({
        ok: true,
        data: capabilityResultSchema(schema).parse({
          data: {
            run: {
              id: claims.runId,
              versionId: claims.versionId,
              trigger: "schedule",
              entrypoint: "weekly",
              state: "failed",
              outcome: "failed",
              createdAt: now.toISOString(),
              startedAt: null,
              endedAt: null,
            },
            contents: {
              input: null,
              inputChunked: false,
              content: null,
              nextCursor: null,
              calls: [{ ...stored, refusalKind: classification?.refusal_kind }],
            },
          },
        }),
      });
      const page = await loadCodeRunCalls(invoke, claims.codeId, claims.runId, 0, 1);
      expect(page?.calls[0]?.refusal).toBe(failure.status === 403 || failure.status === 404 ? "target_refused" : "bridge");
    }
  });
  test("A3a a provider review requiring confirmation is policy, despite its HTTP 403", async () => {
    providerRequestsConfirmation = true;
    const response = await send();
    expect(await response.json()).toEqual({ ok: false, error: { code: "code_unattended_forbidden", status: 403 } });
    await expectPolicyRefusal();
  });
  test("A3a provider capability drift is a bridge failure, despite its HTTP 404", async () => {
    targetFailure = { code: "CAPABILITY_NOT_FOUND", message: "Capability not found", status: 404 };
    expect(await (await send({ operation: "example.read" })).json()).toEqual({
      ok: false,
      error: { code: "capability_not_found", status: 404 },
    });
    const [row] = await sql`SELECT c.refusal_kind,r.first_refused_call_ordinal FROM code.calls c JOIN code.runs r ON r.id=c.run_id
      WHERE c.run_id=${claims.runId}::uuid`;
    expect(row).toMatchObject({ refusal_kind: "bridge", first_refused_call_ordinal: null });
  });
  test("A3a app admission is distinct from a target refusal", async () => {
    beforeIssue = async () => {
      throw new AppAccessDeniedError({ id: "example" });
    };
    await error({ operation: "example.read" }, "app_access_denied", 200, 403);
    const [row] = await sql`SELECT c.refusal_kind,r.first_refused_call_ordinal FROM code.calls c JOIN code.runs r ON r.id=c.run_id
      WHERE c.run_id=${claims.runId}::uuid`;
    expect(row).toMatchObject({ refusal_kind: "app_not_allowed", first_refused_call_ordinal: null });
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
    await expectPolicyRefusal("approval");
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
    await expectPolicyRefusal();
  });
  test("a new admin policy requires an actual version approval", async () => {
    await sql`UPDATE code.policy_rules SET value='admin' WHERE row='silent_shared' AND group_id IS NULL`;
    await error({}, "code_approval_required", 200);
    await expectPolicyRefusal("approval");
  });
  test("an existing version approval cannot cover an omitted actual classification", async () => {
    await sql`INSERT INTO code.version_decisions(version_id,binding,approved,sole_admin,decided_by,decided_via,auth_epoch)
      SELECT version_id,binding,true,false,${userId}::uuid,'session',0 FROM code.version_submissions WHERE version_id=${claims.versionId}::uuid`;
    await sql`INSERT INTO code.policy_coverage(version_id,row) VALUES(${claims.versionId}::uuid,'silent_shared')`;
    await sql`UPDATE code.policy_rules SET value='admin' WHERE row='read' AND group_id IS NULL`;
    await error({ operation: "example.read" }, "code_approval_required", 200);
    await expectPolicyRefusal("approval");
  });
  test("actual admin policy requires a decision as well as row coverage", async () => {
    await sql`UPDATE code.policy_rules SET value='admin' WHERE row='read' AND group_id IS NULL`;
    await sql`INSERT INTO code.policy_coverage(version_id,row) VALUES(${claims.versionId}::uuid,'read')`;
    await error({ operation: "example.read" }, "code_approval_required");
    await expectPolicyRefusal("approval");
  });
  test("a changed decision binding is refused without reading executable payloads", async () => {
    await sql`INSERT INTO code.version_decisions(version_id,binding,approved,sole_admin,decided_by,decided_via,auth_epoch)
      SELECT version_id,jsonb_set(binding,'{bundleHash}',to_jsonb(${"b".repeat(64)}::text)),true,false,${userId}::uuid,'session',0 FROM code.version_submissions WHERE version_id=${claims.versionId}::uuid`;
    await error({}, "code_hash_mismatch");
    await expectPolicyRefusal("approval");
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
  for (const row of ["ai", "internet"] as const)
    test(`${row}: the bridge requires version approval before admitting the call`, async () => {
      await resetFixture({
        entry: true,
        policyRows: [row],
        permissions: [{ operation: "example.read", target: null, file: "code.ts", line: 1 }],
      });
      await sql`UPDATE code.policy_rules SET value='admin' WHERE row=${row} AND group_id IS NULL`;
      // AI is a checked-manifest flag in this release; there is no runtime AI bridge kind.
      // Internet additionally classifies the actual HTTP call and requires that row's coverage.
      const token = await signCodeRunToken(claims, { issuer, signer, now, deadlineAt: now.getTime() + 300_000 });
      const verified = await verifyCodeRunToken(token, { issuer, key, now });
      if (!verified) throw new Error("Fixture token invalid");
      let executed = 0;
      const call = () =>
        createCodeBridgeHost({ checkRate: async () => ({ limited: false }) }).withCall(
          {
            claims: verified,
            kind: row === "ai" ? "query" : "internet",
            call: { capability: row === "ai" ? "example.read" : "http.fetch", target: null, refs: {}, input: {} },
          },
          async (authority) => {
            await sql.begin((db) =>
              authority.withMandateIssueAuthority(
                {
                  mandateId: authority.mandateId,
                  expectedRevision: authority.mandateRevision,
                  ownerAppId: "runner",
                  targetAppId: row === "ai" ? "example" : "core",
                  operation: row === "ai" ? "capability.query:read" : "runtime.http",
                  ...(row === "ai" ? { call: { capability: "example.read", target: null, refs: {}, input: {} } } : {}),
                  actionApproval: "none",
                  input: {},
                },
                async () => {
                  executed++;
                  return null;
                },
                { db },
              ),
            );
            return Response.json({ ok: true, data: null });
          },
        );
      expect(await (await call()).json()).toEqual({ ok: false, error: { code: "code_approval_required" } });
      expect(executed).toBe(0);
      await sql`INSERT INTO code.version_decisions(version_id,binding,approved,sole_admin,decided_by,decided_via,auth_epoch)
        SELECT version_id,binding,true,false,${userId}::uuid,'session',0 FROM code.version_submissions WHERE version_id=${claims.versionId}::uuid`;
      if (row === "internet") {
        expect(await (await call()).json()).toEqual({ ok: false, error: { code: "code_approval_required" } });
        expect(executed).toBe(0);
      }
      await sql`INSERT INTO code.policy_coverage(version_id,row) VALUES(${claims.versionId}::uuid,${row})`;
      expect(await (await call()).json()).toEqual({ ok: true, data: null });
      expect(executed).toBe(1);
    });

  for (const scenario of [
    { operation: "example.no_routines", rows: ["silent_shared"], code: "code_unattended_forbidden" },
    { operation: "example.asks", rows: ["silent_shared", "ask_app_asks"], code: "code_unattended_forbidden" },
    { operation: "example.sends", rows: ["silent_shared", "ask_sends"], code: "code_sends_not_yet" },
  ] as const)
    test(`an approved version declaring ${scenario.rows.join(",")} still refuses ${scenario.operation} at the bridge`, async () => {
      await resetFixture({ entry: true, policyRows: [...scenario.rows] });
      await sql`INSERT INTO code.version_decisions(version_id,binding,approved,sole_admin,decided_by,decided_via,auth_epoch)
        SELECT version_id,binding,true,false,${userId}::uuid,'session',0 FROM code.version_submissions WHERE version_id=${claims.versionId}::uuid`;
      const call = { capability: scenario.operation, target: item, refs: {}, input: {} };
      await error(
        {
          operation: scenario.operation,
          input: { call, metadata: scenario.operation === "example.sends" ? { idempotencyKey: "release-refusal" } : {} },
        },
        scenario.code,
      );
    });

  test("a changed mandate revision is refused", async () => {
    await sql`UPDATE auth.mandates SET revision=revision+1 WHERE id=${claims.mandateId}::uuid`;
    await error({}, "code_mandate_mismatch", 200);
  });
  test("an expired lease is fenced independently of the valid token", async () => {
    await sql`UPDATE code.runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${claims.runId}::uuid`;
    await error({}, "runner_lease_lost", 409);
  });
  test("an operation absent from the mandate is refused", async () => error({ operation: "example.other" }, "mandate_forbidden", 200, 403));
  test("the same operation at another target is refused", async () =>
    error({ target: { ...item, id: "b" } }, "code_capability_undeclared", 403));
  test.each(["core.code.file.read", "core.code.file.view"] as const)(
    "%s observations are trusted accounting only, while SDK calls remain constrained",
    async (operation) => {
      await resetFixture({ entry: true, permissions: [] });
      const token = await signCodeRunToken(claims, { issuer, signer, now, deadlineAt: now.getTime() + 300_000 });
      const verified = await verifyCodeRunToken(token, { issuer, key, now });
      if (!verified) throw new Error("Fixture token invalid");
      const host = createCodeBridgeHost({ checkRate: async () => ({ limited: false }) });
      let executed = 0;
      const execute = async (...args: unknown[]) => {
        expect(args).toEqual([]);
        executed++;
        return new Response("private file bytes", { headers: { "Content-Type": "application/octet-stream" } });
      };
      const response = await host.withFileObservation({ claims: verified, operation, input: { name: "image.png" } }, execute);
      expect(await response.text()).toBe("private file bytes");
      expect(executed).toBe(1);
      const [observed] = await sql<{ result: unknown }[]>`SELECT result FROM code.calls WHERE run_id=${claims.runId}::uuid`;
      expect(observed?.result).toEqual({ ok: true, data: null });
      const external = await host.withCall(
        { claims: verified, kind: "query", call: { capability: operation, target: null, refs: {}, input: {} } },
        async () => {
          executed++;
          return Response.json({ ok: true, data: null });
        },
      );
      expect(external.status).toBe(403);
      expect(await external.json()).toEqual({ ok: false, error: { code: "code_capability_undeclared" } });
      expect(executed).toBe(1);
      expect(await sql<{ state: string }[]>`SELECT state FROM code.calls WHERE run_id=${claims.runId}::uuid ORDER BY ordinal`).toEqual([
        { state: "succeeded" },
        { state: "failed" },
      ]);
      await sql`UPDATE code.runs SET calls_limit=2 WHERE id=${claims.runId}::uuid`;
      await expect(host.withFileObservation({ claims: verified, operation, input: {} }, execute)).rejects.toMatchObject({
        code: "code_call_limit",
      });
      await sql`UPDATE code.runs SET generation=generation+1 WHERE id=${claims.runId}::uuid`;
      await expect(host.withFileObservation({ claims: verified, operation, input: {} }, execute)).rejects.toMatchObject({
        code: "runner_lease_lost",
      });
      expect(executed).toBe(1);
    },
  );
  test("issuance cannot reuse an admitted call for another operation or coordinate", async () => {
    await resetFixture({ entry: true });
    const token = await signCodeRunToken(claims, { issuer, signer, now, deadlineAt: now.getTime() + 300_000 });
    const verified = await verifyCodeRunToken(token, { issuer, key, now });
    if (!verified) throw new Error("Fixture token invalid");
    const admitted = { capability: "example.read", target: item, refs: {}, input: {} };
    for (const issued of [
      { ...admitted, capability: "example.other" },
      { ...admitted, target: { ...item, id: "b" } },
      { ...admitted, refs: { hidden: item } },
    ]) {
      let executed = false;
      const response = await createCodeBridgeHost({ checkRate: async () => ({ limited: false }) }).withCall(
        { claims: verified, kind: "query", call: admitted },
        async (authority) => {
          await sql.begin((db) =>
            authority.withMandateIssueAuthority(
              {
                mandateId: authority.mandateId,
                expectedRevision: authority.mandateRevision,
                ownerAppId: "core",
                targetAppId: "example",
                operation: "capability.query:read",
                call: issued,
              },
              async () => {
                executed = true;
                return null;
              },
              { db },
            ),
          );
          return Response.json({ ok: true, data: null });
        },
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ ok: false, error: { code: "code_capability_undeclared" } });
      expect(executed).toBe(false);
    }
  });
  test.each([false, true])("dynamic evidence retains Type constraints with personal=%s", async (personal) => {
    await resetFixture({
      entry: true,
      personal,
      permissions: [{ operation: "example.read", target: { type: item.type, id: null }, file: "code.ts", line: 1 }],
    });
    if (personal) {
      await sql`UPDATE auth.mandates SET subject_kind='user',subject_user_id=${userId}::uuid,subject_service_account_id=NULL WHERE id=${claims.mandateId}::uuid`;
      const [access] = await sql<
        { id: string }[]
      >`INSERT INTO auth.access(user_id,permission) VALUES(${userId}::uuid,'write') RETURNING id`;
      targetAccess = access!.id;
    }
    expect(await (await send({ operation: "example.read" })).json()).toEqual({ ok: true, data: { data: { value: "a" } } });
  });
  test("policy-free entries refuse operations and targets absent from version evidence and log the refusal", async () => {
    await resetFixture({ entry: true, permissions: [{ operation: "example.write", target: item, file: "code.ts", line: 1 }] });
    await error({ operation: "example.other" }, "code_capability_undeclared", 403);
    await error({ target: { ...item, id: "b" } }, "code_capability_undeclared", 403);
    await error(
      { input: { call: { capability: "example.write", target: item, refs: { hidden: { ...item, id: "b" } }, input: {} }, metadata: {} } },
      "code_capability_undeclared",
      403,
    );
    await expectPolicyRefusal();
    const rows = await sql`SELECT state,result FROM code.calls WHERE run_id=${claims.runId}::uuid ORDER BY ordinal`;
    expect(rows).toEqual([
      { state: "failed", result: { ok: false, error: { code: "code_capability_undeclared" } } },
      { state: "failed", result: { ok: false, error: { code: "code_capability_undeclared" } } },
      { state: "failed", result: { ok: false, error: { code: "code_capability_undeclared" } } },
    ]);
    expect(await (await send()).json()).toEqual({ ok: true, data: { value: "a" } });
  });
  test.each(["schedule", "route", "event"] as const)(
    "%s runs refuse a mis-attributed AI call independently of the checker",
    async (kind) => {
      const event =
        kind === "event"
          ? appEventFixture(
              mailCapabilities,
              "message.received",
              {
                subject: "Ms4g00",
                place: "Mb4g00",
                data: { receiptId: "44444444-4444-4444-8444-444444444444" },
              },
              { appId: "mail", id: "55555555-5555-4555-8555-555555555555", time: now.toISOString() },
            )
          : undefined;
      await resetFixture({
        entry: true,
        ...(kind === "event" ? { event } : { entrypointKind: kind }),
        policyRows: ["read"],
        permissions: [{ operation: "core.catalog.list", target: null, file: "code.ts", line: 1 }],
      });
      const before = fetched;
      const response = await send({
        entry: { ...baseEntry, appId: "core", manifest: decisionCompiled.manifest },
        operation: "core.ai.generate",
        input: { call: { capability: "core.ai.generate", target: null, refs: {}, input: {} }, metadata: {} },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ ok: false, error: { code: "code_capability_undeclared" } });
      expect(fetched).toBe(before);
      await expectPolicyRefusal();
      const [run] = await sql`SELECT ai_reserved_cost::text AS reserved FROM code.runs WHERE id=${claims.runId}::uuid`;
      expect(run?.reserved).toBe("0");
    },
  );
  test("personal Code also uses its active policy-free entry and current person rights", async () => {
    await resetFixture({ entry: true, personal: true });
    await sql`UPDATE auth.mandates SET subject_kind='user',subject_user_id=${userId}::uuid,subject_service_account_id=NULL WHERE id=${claims.mandateId}::uuid`;
    const [access] = await sql<{ id: string }[]>`INSERT INTO auth.access(user_id,permission) VALUES(${userId}::uuid,'write') RETURNING id`;
    targetAccess = access!.id;
    expect(await (await send({ operation: "example.other" })).json()).toEqual({ ok: true, data: { value: "a" } });
    await sql`UPDATE auth.mandates SET state='paused' WHERE id=${claims.mandateId}::uuid`;
    await error({}, "code_mandate_mismatch");
  });
  test("an all-admin policy requires version approval and coverage for each actual call", async () => {
    await resetFixture({ entry: true });
    await sql`UPDATE code.policy_rules SET value='admin' WHERE group_id IS NULL`;
    await error({ operation: "example.read" }, "code_approval_required");
    await error({}, "code_approval_required");
    await sql`INSERT INTO code.version_decisions(version_id,binding,approved,sole_admin,decided_by,decided_via,auth_epoch)
      SELECT version_id,binding,true,false,${userId}::uuid,'session',0 FROM code.version_submissions WHERE version_id=${claims.versionId}::uuid`;
    await sql`INSERT INTO code.policy_coverage(version_id,row) VALUES(${claims.versionId}::uuid,'silent_shared')`;
    expect(await (await send()).json()).toEqual({ ok: true, data: { value: "a" } });
    await error({ operation: "example.read" }, "code_approval_required");
    await sql`INSERT INTO code.policy_coverage(version_id,row) VALUES(${claims.versionId}::uuid,'read'),(${claims.versionId}::uuid,'ask_app_asks')`;
    expect(await (await send({ operation: "example.read" })).json()).toEqual({ ok: true, data: { data: { value: "a" } } });
    await error({ operation: "example.asks" }, "code_unattended_forbidden");
  });

  test("new entries still obey actual-call admin policy, current grants and unattended refusals", async () => {
    await resetFixture({ entry: true });
    await sql`UPDATE code.policy_rules SET value='admin' WHERE row='read' AND group_id IS NULL`;
    await error({ operation: "example.read" }, "code_approval_required");
    await error({ operation: "example.asks" }, "code_unattended_forbidden");
    await sql`DELETE FROM auth.access WHERE id=${targetAccess}::uuid`;
    expect(await (await send()).json()).toEqual({ ok: false, error: { code: "forbidden", status: 403 } });
  });
  test("a pending or paused entry cannot issue, including a personal Code entry", async () => {
    for (const personal of [false, true]) {
      await resetFixture({ entry: true, personal });
      if (personal) {
        await sql`UPDATE auth.mandates SET subject_kind='user',subject_user_id=${userId}::uuid,subject_service_account_id=NULL WHERE id=${claims.mandateId}::uuid`;
      }
      await sql`UPDATE auth.mandates SET confirmed_at=NULL,confirmation_deadline=created_at+interval '15 minutes' WHERE id=${claims.mandateId}::uuid`;
      await error({}, "code_mandate_mismatch");
      await sql`UPDATE auth.mandates SET confirmed_at=created_at,confirmation_deadline=NULL,state='paused' WHERE id=${claims.mandateId}::uuid`;
      await error({}, "code_mandate_mismatch");
    }
  });
  test("a revoked current Code target grant is refused at the provider", async () => {
    await sql`DELETE FROM auth.access WHERE id=${targetAccess}::uuid`;
    const response = await send();
    expect(await response.json()).toEqual({ ok: false, error: { code: "forbidden", status: 403 } });
  });
  test("call limit is durable and current admin tightening applies", async () => {
    callLimit = 1;
    expect(await (await send()).json()).toEqual({ ok: true, data: { value: "a" } });
    await error({}, "code_call_limit", 200);
  });
  async function fileFixture(sourceAction = false, event?: AppEventEnvelope, permissions?: CodeCheckedVersionManifest["permissions"]) {
    const mailManifest = compileCapabilityManifest("mail", mailCapabilities);
    await resetFixture({
      entry: true,
      policyRows: ["read", "silent_shared"],
      event,
      permissions: permissions ?? [
        ...[...mailManifest.queries, ...mailManifest.actions].map((operation) => ({
          operation: `mail.${operation.localId}`,
          target: operation.target ? { type: `mail.${operation.target}`, id: "Mb4g00" } : null,
          file: "code.ts",
          line: 1,
        })),
        { operation: "imports.import", target: null, file: "code.ts", line: 1 },
      ],
    });
    if (!mailMigrated) {
      await installLiveOutbox(sql);
      await migrateLogging();
      await migrateWorkflows();
      await migrateMail();
      mailMigrated = true;
    }
    await sql`DELETE FROM mail.mailboxes WHERE short_id='Mb4g00'`;
    const [mailbox] = await sql<{ id: string }[]>`INSERT INTO mail.mailboxes(short_id,name) VALUES('Mb4g00','Invoices') RETURNING id`;
    const [account] = await sql<{ service_account_id: string }[]>`SELECT service_account_id FROM code.codes WHERE id=${claims.codeId}`;
    const [access] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access(service_account_id,permission) VALUES(${account!.service_account_id}::uuid,'read') RETURNING id`;
    await sql`INSERT INTO mail.mailbox_access(mailbox_id,access_id) VALUES(${mailbox!.id}::uuid,${access!.id}::uuid)`;
    const payload = Buffer.from("%PDF-invoice-xml-private-".repeat(32_768));
    const blob = await storeReadableBlob(Readable.from([payload]), payload.length);
    const [message] = await sql<
      { id: string }[]
    >`INSERT INTO mail.message_contents(short_id,mailbox_id,internal_date,content_hash,hydration_status)
      VALUES('Ms4g00',${mailbox!.id}::uuid,${now},${blob.contentHash},'complete') RETURNING id`;
    const [part] = await sql<
      { id: string }[]
    >`INSERT INTO mail.message_parts(message_id,part_path,content_type,disposition,filename,size_bytes,blob_id,hydration_status)
      VALUES(${message!.id}::uuid,'1','application/pdf','attachment','invoice.pdf',${payload.length},${blob.id}::uuid,'complete') RETURNING id`;
    await sql`INSERT INTO mail.attachments(short_id,message_id,part_id,filename,content_type,size_bytes,blob_id)
      VALUES('At4g00',${message!.id}::uuid,${part!.id}::uuid,'invoice.pdf','application/pdf',${payload.length},${blob.id}::uuid)`;
    const source = compileCapabilities(
      "mail",
      sourceAction
        ? {
            protocolVersion: 2,
            actions: {
              "attachment.content.read": {
                ...actionOp,
                ...mailCapabilities.queries["attachment.content.read"],
                destructive: false,
                idempotency: "none",
                policy: { silent: "shared" },
              },
            },
          }
        : mailCapabilities,
    );
    let received: Uint8Array | undefined;
    let targetWritable = true;
    let writes = 0;
    let sourceBytes = 0;
    let targetBytes = 0;
    let offerSize = payload.length;
    let sourceExtraByte = false;
    let revokeAtWrite = false;
    let sourceLifetimeMs = 240_000;
    const published = new Set<string>();
    const reservations = new Map<string, z.infer<typeof CapabilityFileMetadataSchema>>();
    async function requireTarget(context: CapabilityExecutionContext) {
      const permission = await getEffectivePermission({ accessIds: [targetAccess], subject: context.accessSubject });
      if (!targetWritable || !hasPermission(permission, "write")) throw err.forbidden("No import access");
    }
    const target = compileCapabilities("imports", {
      protocolVersion: 2,
      actions: {
        import: {
          ...actionOp,
          input: z.object({ file: CapabilityFileMetadataSchema }).strict(),
          data: z.object({ imported: z.boolean() }).strict(),
          destructive: false,
          idempotency: "required",
          policy: { silent: "shared" },
          async run(input, context) {
            await requireTarget(context);
            const id = context.idempotencyKey!;
            reservations.set(id, input.file);
            return {
              ok: true,
              data: {
                data: { imported: false },
                stream: {
                  ...input.file,
                  id,
                  direction: "write",
                  size: offerSize,
                  expiresAt: new Date(now.getTime() + 240_000).toISOString(),
                },
              },
            };
          },
          stream: {
            direction: "write",
            maxBytes: 100 * 1024 * 1024,
            async write(stream, body, context) {
              await requireTarget(context);
              expect(reservations.has(stream.id)).toBe(true);
              const bytes = new Uint8Array(await new Response(body).arrayBuffer());
              await requireTarget(context);
              received = bytes;
              if (!published.has(stream.id)) {
                writes++;
                published.add(stream.id);
              }
              return { data: { imported: true } };
            },
            async status(_stream, context) {
              await requireTarget(context);
              return { state: "open" };
            },
            async abort(_stream, context) {
              await requireTarget(context);
            },
          },
        },
      },
    });
    for (const compiled of [source, target])
      fileEntries.set(compiled.manifest.appId, {
        ...baseEntry,
        appId: compiled.manifest.appId,
        manifest: compiled.manifest,
        endpoint: `http://${compiled.manifest.appId}.test/api/_internal/capabilities/v1`,
      });
    let lastInvocation: CloudInvocationClaims | null = null;
    fileTransport = async (url, init) => {
      const request = new Request(url, init);
      const appId = new URL(request.url).hostname.split(".")[0]!;
      const compiled = appId === "mail" ? source : target;
      const segments = new URL(request.url).pathname.split("/");
      const streamVerb = request.headers.has("x-cloud-stream-offer") ? segments.at(-1) : null;
      const localId = streamVerb ? segments.at(-2)! : segments.at(-1)!;
      const kind = compiled.queries.has(localId) ? "query" : "action";
      const operation = (kind === "query" ? compiled.queries : compiled.actions).get(localId)!;
      const verified = await verifyInvocationToken(
        request.headers.get("authorization")!.slice(7),
        {
          targetAppId: appId,
          operation: `${kind === "query" ? "capability.query" : "capability.action.run"}:${localId}`,
          schemaHash: operation.manifest.schemaHash,
        },
        { issuer, key, now },
      );
      lastInvocation = verified;
      const authority = verified ? await resolveInvocationAuthority(verified, sql, []) : null;
      if (!authority) throw new Error("File transfer lacks current Code authority");
      const context: CapabilityExecutionContext = {
        authority,
        actor: authority.actor,
        accessSubject: authority.accessSubject,
        user: null,
        locale: "en",
        requestId: "file-ref-fixture",
        origin: "app",
        signal: request.signal,
      };
      if (streamVerb) {
        if (appId === "imports" && revokeAtWrite) targetWritable = false;
        const response = await invokeCapabilityStream({
          compiled,
          kind: kind === "query" ? "queries" : "actions",
          localId,
          verb: streamVerb,
          request,
          context,
        });
        if (appId === "mail" && response.ok && response.body)
          return new Response(
            response.body.pipeThrough(
              new TransformStream({
                transform(chunk, controller) {
                  sourceBytes += chunk.byteLength;
                  controller.enqueue(chunk);
                },
                flush(controller) {
                  if (sourceExtraByte) controller.enqueue(new Uint8Array([1]));
                },
              }),
            ),
            { status: response.status, headers: response.headers },
          );
        if (appId === "imports") targetBytes = received?.length ?? 0;
        return response;
      }
      const body = CapabilityInvocationBodySchema.parse(await request.json());
      const outcome = await invokeCompiledCapability({
        compiled,
        kind,
        localId,
        input: body.input,
        target: body.target,
        refs: body.refs,
        expectedSchemaHash: operation.manifest.schemaHash,
        context: {
          ...context,
          ...(request.headers.has("idempotency-key") ? { idempotencyKey: request.headers.get("idempotency-key")! } : {}),
        },
      });
      if (appId === "mail" && outcome.ok && outcome.data.stream)
        outcome.data.stream.expiresAt = new Date(now.getTime() + sourceLifetimeMs).toISOString();
      const wire = serializeCapabilityProviderResult(outcome);
      return new Response(wire.body, { status: wire.status, headers: { "content-type": "application/json" } });
    };
    const read = async () => {
      const response = await send({
        operation: "mail.attachment.content.read",
        input: {
          call: {
            capability: "mail.attachment.content.read",
            target: null,
            refs: {},
            input: { id: "At4g00" },
          },
          metadata: {},
        },
      });
      return response.json();
    };
    let serial = 0;
    const write = (file: RunnerJsonValue, change?: Partial<CodeRunTokenInput>, businessKey?: string) =>
      send({
        change,
        operation: "imports.import",
        input: {
          call: {
            capability: "imports.import",
            target: null,
            refs: {},
            input: { file },
          },
          metadata: { idempotencyKey: businessKey ?? `import-${++serial}` },
        },
      });
    return {
      read,
      write,
      lastInvocation: () => lastInvocation,
      messageId: message!.id,
      call: (operation: string, input: RunnerJsonValue, target: { type: string; id: string } | null = null) =>
        send({
          operation: `mail.${operation}`,
          input: { call: { capability: `mail.${operation}`, target, refs: {}, input }, metadata: {} },
        }),
      payload,
      source,
      target,
      mailboxId: mailbox!.id,
      accessId: access!.id,
      writes: () => writes,
      received: () => received,
      sourceBytes: () => sourceBytes,
      targetBytes: () => targetBytes,
      denyTarget: () => {
        targetWritable = false;
      },
      extraByte: () => {
        sourceExtraByte = true;
      },
      revokeAtWrite: () => {
        revokeAtWrite = true;
      },
      expireIn: (ms: number) => {
        sourceLifetimeMs = ms;
      },
      offerSize: (value: number) => {
        offerSize = value;
      },
    };
  }
  const aiClaims = () =>
    CodeRunTokenClaimsSchema.parse({
      ...claims,
      ver: 1,
      token_use: "code_run",
      iss: issuer,
      aud: "cloud-code-bridge",
      iat: Math.floor(now.getTime() / 1000),
      nbf: Math.floor(now.getTime() / 1000),
      exp: Math.floor(now.getTime() / 1000) + 300,
    });
  const aiRead = (ref: unknown, maximum = 20 * 1024 * 1024) =>
    readCodeAiFile({
      ref: CodeFileRefSchema.parse(ref),
      claims: aiClaims(),
      request: new Request(issuer),
      maxBytes: maximum,
      dependencies: dependencies(),
    });
  test("AI file reader reuses the owning Mail authorization and logs its read, including a visible 403", async () => {
    const fixture = await fileFixture();
    const opened = await fixture.read();
    expect(await aiRead(opened.data)).toEqual(fixture.payload);
    const [logged] = await sql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM code.calls WHERE run_id=${claims.runId}::uuid AND call->>'capability'='mail.attachment.content.read'`;
    expect(logged!.count).toBe(2);
    const denied = await fixture.read();
    await sql`DELETE FROM auth.access WHERE id=${fixture.accessId}::uuid`;
    await expect(aiRead(denied.data)).rejects.toMatchObject({ code: "code_file_source_refused", status: 403 });
  }, 30_000);
  test("AI viewers share the real durable call observer and make a source refusal visible", async () => {
    const fixture = await fileFixture();
    const opened = await fixture.read();
    expect(await codeAiFileTool(aiClaims(), "read_file", { ref: opened.data }, () => aiRead(opened.data), dependencies().host)).toEqual(
      fixture.payload,
    );
    const denied = await fixture.read();
    await sql`DELETE FROM auth.access WHERE id=${fixture.accessId}::uuid`;
    await expect(
      codeAiFileTool(aiClaims(), "view_image", { ref: denied.data }, () => aiRead(denied.data), dependencies().host),
    ).rejects.toMatchObject({ code: "code_file_source_refused", status: 403 });
    const rows = await sql<{ state: string; call: { capability: string } }[]>`SELECT state,call FROM code.calls
      WHERE run_id=${claims.runId}::uuid AND call->>'capability' IN ('core.code.file.read','core.code.file.view') ORDER BY ordinal`;
    expect(rows.map((row) => [row.call.capability, row.state])).toEqual([
      ["core.code.file.read", "succeeded"],
      ["core.code.file.view", "failed"],
    ]);
  }, 30_000);
  test("AI file reader rejects changed metadata, another run, byte overflow and the durable call limit", async () => {
    const fixture = await fileFixture();
    const opened = await fixture.read();
    await expect(aiRead({ ...opened.data, size: 1 })).rejects.toMatchObject({ code: "code_file_invalid" });
    await expect(aiRead(opened.data, fixture.payload.length - 1)).rejects.toMatchObject({ code: "code_file_size_limit" });
    const original = { ...claims };
    claims = { ...claims, runId: crypto.randomUUID() };
    await expect(aiRead(opened.data)).rejects.toMatchObject({ code: "code_file_invalid" });
    claims = original;
    fixture.extraByte();
    await expect(aiRead(opened.data)).rejects.toMatchObject({ code: "code_file_size_limit" });
    const fresh = await fixture.read();
    callLimit = 1;
    await expect(aiRead(fresh.data)).rejects.toMatchObject({ code: "code_call_limit" });
  }, 30_000);
  test("AI SDK tools use the exact direct-call policy, approval, target, account and durable call log", async () => {
    const invoke = async (capability: string) => {
      const tools = await createCodeAiTools({
        bindings: [{ capability, target: item }],
        permissions: [{ operation: capability, target: item, file: "code.ts", line: 1 }],
        requestId: "ai-loop",
        registerFiles: () => {},
        getCapability: dependencies().dispatch.getCapability,
        invoke: async (invocation) =>
          (
            await dispatchCodeSdkCall({
              claims: aiClaims(),
              invocation,
              operationId: capability,
              request: new Request(issuer),
              dependencies: dependencies(),
            })
          ).json(),
      });
      return tools[0]!.execute(
        {},
        {
          signal: new AbortController().signal,
          requestApproval: async () => {
            throw new Error("No independent tool approval");
          },
          requestClientTool: async () => {
            throw new Error("No client tools");
          },
        },
      );
    };
    await resetFixture({ entry: true });
    expect(await invoke("example.write")).toEqual(await (await send()).json());
    await sql`UPDATE code.policy_rules SET value='admin' WHERE row='read' AND group_id IS NULL`;
    expect(await invoke("example.read")).toMatchObject({ ok: false, error: { code: "code_approval_required" } });
    expect(await (await send({ operation: "example.read" })).json()).toMatchObject({
      ok: false,
      error: { code: "code_approval_required" },
    });
    await sql`INSERT INTO code.version_decisions(version_id,binding,approved,sole_admin,decided_by,decided_via,auth_epoch)
      SELECT version_id,binding,true,false,${userId}::uuid,'session',0 FROM code.version_submissions WHERE version_id=${claims.versionId}::uuid`;
    await sql`INSERT INTO code.policy_coverage(version_id,row) VALUES(${claims.versionId}::uuid,'read')`;
    expect(await invoke("example.read")).toEqual(await (await send({ operation: "example.read" })).json());
    expect(await invoke("example.asks")).toMatchObject({ ok: false, error: { code: "code_unattended_forbidden" } });
    await sql`DELETE FROM auth.access WHERE id=${targetAccess}::uuid`;
    expect(await invoke("example.write")).toEqual({ ok: false, error: { code: "forbidden", status: 403 } });
    const [logged] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM code.calls WHERE run_id=${claims.runId}::uuid`;
    expect(logged!.count).toBe(8);
  });
  test("Mail event work changes use the stored trigger across the real signed bridge and provider", async () => {
    const event = appEventFixture(
      mailCapabilities,
      "message.received",
      {
        subject: "Ms4g00",
        place: "Mb4g00",
        data: { receiptId: "44444444-4444-4444-8444-444444444444" },
      },
      { appId: "mail", id: "55555555-5555-4555-8555-555555555555", time: now.toISOString() },
    );
    const fixture = await fileFixture(false, event);
    await sql`UPDATE auth.access SET permission='write' WHERE id=${fixture.accessId}::uuid`;
    const [conversation] = await sql<{ id: string }[]>`INSERT INTO mail.conversations(short_id,mailbox_id,subject,latest_message_at)
      VALUES('Cv4g00',${fixture.mailboxId}::uuid,'Linked message',${now}) RETURNING id`;
    await sql`INSERT INTO mail.conversation_messages(conversation_id,message_id,position,added_by)
      VALUES(${conversation!.id}::uuid,${fixture.messageId}::uuid,0,'list')`;
    const target = { type: "mail.mailbox", id: "Mb4g00" };
    expect(await (await fixture.call("message.read", { id: "Ms4g00" })).json()).toMatchObject({
      ok: true,
      data: { data: { conversationId: "Cv4g00" } },
    });
    expect(fixture.lastInvocation()).toMatchObject({
      workload_run: claims.runId,
      workload_trigger: {
        type: event.type,
        subject: event.subject,
        place: event.place,
      },
    });
    await sql`INSERT INTO mail.conversations(short_id,mailbox_id,subject,latest_message_at)
      VALUES('Cv4g01',${fixture.mailboxId}::uuid,'Other message',${now})`;
    const snapshot = () => sql`SELECT short_id,work_status,revision,snoozed_until FROM mail.conversations
      WHERE mailbox_id=${fixture.mailboxId}::uuid ORDER BY short_id`;
    const before = await snapshot();
    const mutations = [
      ["conversation.status.set", { conversationId: "Cv4g00", expectedRevision: 1, status: "done" }],
      ["conversation.status.set.batch", { conversationIds: ["Cv4g01", "Cv4g00"], status: "done" }],
      ["conversation.assign", { conversationId: "Cv4g00", mode: "replace", assigneeUserIds: [] }],
      ["conversation.assign.batch", { conversationIds: ["Cv4g01", "Cv4g00"], mode: "replace", assigneeUserIds: [] }],
      ["conversation.snooze", { conversationId: "Cv4g00", expectedRevision: 1, snoozedUntil: "2026-11-10T12:00:00Z" }],
    ] satisfies [string, RunnerJsonValue][];
    for (const [operation, input] of mutations) {
      const response = await fixture.call(operation, input, target);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "forbidden", status: 403 } });
      expect(await snapshot()).toEqual(before);
    }
    expect(await sql`SELECT * FROM mail.conversation_assignees WHERE conversation_id=${conversation!.id}::uuid`).toHaveLength(0);
    // A regular link keeps the same granted workload useful.
    await sql`UPDATE mail.conversation_messages SET added_by='headers' WHERE message_id=${fixture.messageId}::uuid`;
    expect(
      await (
        await fixture.call(
          "conversation.status.set",
          {
            conversationId: "Cv4g00",
            expectedRevision: 1,
            status: "done",
          },
          target,
        )
      ).json(),
    ).toMatchObject({ ok: true });
    expect((await snapshot())[0]).toMatchObject({ short_id: "Cv4g00", work_status: "done" });
    // Current grants remain independently necessary after the signed projection succeeds.
    await sql`DELETE FROM auth.access WHERE id=${fixture.accessId}::uuid`;
    expect(await (await fixture.call("message.read", { id: "Ms4g00" })).json()).toMatchObject({ ok: false });
    expect(
      await (
        await fixture.call(
          "conversation.status.set.batch",
          {
            conversationIds: ["Cv4g00"],
            status: "needs_action",
          },
          target,
        )
      ).json(),
    ).toMatchObject({ ok: false });
    expect((await snapshot())[0]).toMatchObject({ short_id: "Cv4g00", work_status: "done" });
  });

  test("Mail waiting reads keep pending content in one bridge call and report terminal hydration explicitly", async () => {
    const fixture = await fileFixture();
    await sql`UPDATE mail.message_contents SET hydration_status='envelope' WHERE id=${fixture.messageId}::uuid`;
    const read = mailMessages.getMessage;
    let polls = 0;
    const barrier = spyOn(mailMessages, "getMessage").mockImplementation(async (input) => {
      const result = await read(input);
      if (++polls === 5) await sql`UPDATE mail.message_contents SET hydration_status='complete' WHERE id=${fixture.messageId}::uuid`;
      return result;
    });
    try {
      expect(await (await fixture.call("message.read", { id: "Ms4g00", waitForHydration: true })).json()).toMatchObject({
        ok: true,
        data: { data: { hydrationStatus: "complete" } },
      });
      expect(polls).toBe(6);
      expect(
        await sql<
          { generation: number; effect_started: boolean }[]
        >`SELECT generation,effect_started FROM code.runs WHERE id=${claims.runId}::uuid`,
      ).toEqual([{ generation: 1, effect_started: false }]);
      expect(await sql`SELECT * FROM code.calls WHERE run_id=${claims.runId}::uuid`).toHaveLength(1);
    } finally {
      barrier.mockRestore();
    }
    await sql`UPDATE mail.message_contents SET hydration_status='failed',hydration_attempt=5 WHERE id=${fixture.messageId}::uuid`;
    expect(await (await fixture.call("message.read", { id: "Ms4g00", waitForHydration: true })).json()).toMatchObject({
      ok: false,
      error: { code: "mail_message_hydration_failed", status: 409 },
    });
    expect(fixture.lastInvocation()?.workload_trigger).toBeNull();
    expect(await (await fixture.call("message.read", { id: "Ms4g00" })).json()).toMatchObject({
      ok: true,
      data: { data: { hydrationStatus: "failed" } },
    });
  }, 20000);

  test("4g Mail attachment passes through Core to a third-party import, with metadata only at the sandbox seam", async () => {
    const fixture = await fileFixture();
    const opened = await fixture.read();
    if (!opened.ok) throw new Error(JSON.stringify(opened));
    expect(opened.ok).toBe(true);
    const file = CodeFileRefSchema.parse(opened.data);
    expect(Object.keys(file).sort()).toEqual(["id", "mediaType", "name", "size"]);
    expect(file).toMatchObject({ name: "invoice.pdf", mediaType: "application/pdf", size: fixture.payload.length });
    expect(JSON.stringify(opened).length).toBeLessThan(8192);
    expect(JSON.stringify(opened)).not.toContain("%PDF");
    expect(fixture.sourceBytes()).toBe(0);
    expect(await (await fixture.write(file)).json()).toEqual({ ok: true, data: { imported: true } });
    expect(fixture.received()).toEqual(new Uint8Array(fixture.payload));
    expect(fixture.sourceBytes()).toBe(fixture.payload.length);
    expect(fixture.targetBytes()).toBe(fixture.payload.length);
    expect(await (await fixture.write(file)).json()).toEqual({ ok: false, error: { code: "code_file_spent" } });
    const rows = await sql`SELECT digest FROM code.file_redemptions WHERE run_id=${claims.runId}::uuid`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.digest).not.toBe(file.id);
    // Interactive and foreign credentials cannot exchange the Code continuation.
    expect(
      (await dispatchCapabilityStream(new Request("http://core.test", { headers: { "x-cloud-stream-id": file.id } }), null, "read")).status,
    ).toBe(403);
  }, 30_000);
  test("4g foreign account cannot obtain a Mail file, and another Code with its own valid mandate cannot redeem it", async () => {
    const fixture = await fileFixture();
    const opened = await fixture.read();
    await resetFixture({
      entry: true,
      policyRows: ["read", "silent_shared"],
      permissions: [
        { operation: "mail.attachment.content.read", target: null, file: "code.ts", line: 1 },
        { operation: "imports.import", target: null, file: "code.ts", line: 1 },
      ],
    });
    expect(await fixture.read()).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await (await fixture.write(opened.data)).json()).toEqual({ ok: false, error: { code: "code_file_invalid" } });
    expect(fixture.received()).toBeUndefined();
  }, 30_000);
  test.each(["read", "write"] as const)(
    "stream %s calls must belong to the declared version set before bytes move",
    async (direction) => {
      const fixture = await fileFixture(false, undefined, [
        {
          operation: direction === "read" ? "imports.import" : "mail.attachment.content.read",
          target: null,
          file: "code.ts",
          line: 1,
        },
      ]);
      const opened = await fixture.read();
      if (direction === "read") expect(opened).toMatchObject({ ok: false, error: { code: "code_capability_undeclared" } });
      else {
        expect(opened.ok).toBe(true);
        const response = await fixture.write(opened.data);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ ok: false, error: { code: "code_capability_undeclared" } });
      }
      expect(fixture.sourceBytes()).toBe(0);
      expect(fixture.received()).toBeUndefined();
      await expectPolicyRefusal();
    },
    30_000,
  );
  test("4g a read-stream Action uses its actual Action policy again when Core redeems its reference", async () => {
    const fixture = await fileFixture(true);
    const opened = await fixture.read();
    expect(opened).toMatchObject({ ok: true });
    expect(await (await fixture.write(opened.data)).json()).toEqual({ ok: true, data: { imported: true } });
    const fresh = await fixture.read();
    fileEntries.get("mail")!.manifest.policies!["attachment.content.read"] = { ask: "app_asks" };
    expect(await (await fixture.write(fresh.data)).json()).toMatchObject({ ok: false, error: { code: "code_file_source_refused" } });
    expect(fixture.writes()).toBe(1);
  }, 30_000);
  test("4g references reject tampered metadata and another run or generation", async () => {
    const fixture = await fileFixture();
    const opened = await fixture.read();
    for (const file of [
      { ...opened.data, size: 1 },
      { ...opened.data, name: "forged.xml" },
      { ...opened.data, mediaType: "text/xml" },
    ])
      expect(await (await fixture.write(file)).json()).toEqual({ ok: false, error: { code: "code_file_invalid" } });
    // A valid new run of the same executable cannot redeem the old run's reference.
    const original = { ...claims };
    const [run] = await sql<
      { id: string }[]
    >`INSERT INTO code.runs(code_id,version_id,trigger,entrypoint,state,started_at,lease_expires_at,generation,payload_bytes,calls_limit)
      VALUES(${claims.codeId},${claims.versionId}::uuid,'manual','weekly','running',clock_timestamp(),clock_timestamp()+interval '10 minutes',1,32768,200) RETURNING id`;
    claims = { ...claims, runId: run!.id };
    expect(await (await fixture.write(opened.data)).json()).toEqual({ ok: false, error: { code: "code_file_invalid" } });
    claims = original;
    await sql`UPDATE code.runs SET generation=2 WHERE id=${claims.runId}::uuid`;
    claims = { ...claims, generation: 2 };
    expect(await (await fixture.write(opened.data)).json()).toEqual({ ok: false, error: { code: "code_file_invalid" } });
  }, 30_000);
  test("4g a file expires before the run token and cannot be redeemed", async () => {
    const fixture = await fileFixture();
    fixture.expireIn(30_000);
    const opened = await fixture.read();
    try {
      setSystemTime(new Date(now.getTime() + 31_000));
      expect(await (await fixture.write(opened.data)).json()).toEqual({ ok: false, error: { code: "code_file_invalid" } });
      expect(fixture.received()).toBeUndefined();
    } finally {
      setSystemTime(now);
    }
  }, 30_000);
  test("4g a concurrent redemption has exactly one winner", async () => {
    const fixture = await fileFixture();
    const opened = await fixture.read();
    const outcomes = await Promise.all([fixture.write(opened.data), fixture.write({ ...opened.data, id: opened.data.id.toUpperCase() })]);
    const results = await Promise.all(outcomes.map((response) => response.json()));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => result.error?.code === "code_file_spent")).toHaveLength(1);
    expect(fixture.sourceBytes()).toBe(fixture.payload.length);
  }, 30_000);
  test("4g equivalent opaque reference encodings share the same single redemption", async () => {
    const fixture = await fileFixture();
    const opened = await fixture.read();
    const file = CodeFileRefSchema.parse(opened.data);
    expect(await (await fixture.write(file)).json()).toEqual({ ok: true, data: { imported: true } });
    for (const id of [file.id.toUpperCase(), `${file.id.startsWith("01") ? "02" : "01"}${file.id.slice(2)}`]) {
      expect(id).not.toBe(file.id);
      expect(await (await fixture.write({ ...file, id })).json()).toEqual({ ok: false, error: { code: "code_file_spent" } });
    }
    expect(fixture.writes()).toBe(1);
  }, 30_000);
  test("4g current target stream access and the actual byte count still gate publication", async () => {
    const fixture = await fileFixture();
    const opened = await fixture.read();
    fixture.revokeAtWrite();
    expect(await (await fixture.write(opened.data)).json()).toEqual({
      ok: false,
      error: { code: "code_file_target_refused", status: 403 },
    });
    expect(fixture.received()).toBeUndefined();
  }, 30_000);
  test("4g an oversized source body fails without publishing a target result", async () => {
    const fixture = await fileFixture();
    const opened = await fixture.read();
    fixture.extraByte();
    expect(await (await fixture.write(opened.data)).json()).toMatchObject({ ok: false });
    expect(fixture.received()).toBeUndefined();
  }, 30_000);
  test("4g a fresh run resumes its authorized idempotent target reservation without reusing the old file or publishing twice", async () => {
    const fixture = await fileFixture();
    const opened = await fixture.read();
    expect(await (await fixture.write(opened.data, undefined, "invoice-business-key")).json()).toEqual({
      ok: true,
      data: { imported: true },
    });
    const [run] = await sql<
      { id: string }[]
    >`INSERT INTO code.runs(code_id,version_id,trigger,entrypoint,state,started_at,lease_expires_at,generation,payload_bytes,calls_limit)
      VALUES(${claims.codeId},${claims.versionId}::uuid,'manual','weekly','running',clock_timestamp(),clock_timestamp()+interval '10 minutes',1,32768,200) RETURNING id`;
    claims = { ...claims, runId: run!.id };
    expect(await (await fixture.write(opened.data)).json()).toEqual({ ok: false, error: { code: "code_file_invalid" } });
    const fresh = await fixture.read();
    expect(await (await fixture.write(fresh.data, undefined, "invoice-business-key")).json()).toEqual({
      ok: true,
      data: { imported: true },
    });
    expect(fixture.writes()).toBe(1);
  }, 30_000);
  test("4g even the same run and account cannot redeem a file after its executable version or mandate revision changes", async () => {
    const fixture = await fileFixture();
    const opened = await fixture.read();
    await sql`UPDATE auth.mandates SET revision=revision+1 WHERE id=${claims.mandateId}::uuid`;
    claims = { ...claims, mandateRevision: claims.mandateRevision + 1 };
    expect(await (await fixture.write(opened.data)).json()).toEqual({ ok: false, error: { code: "code_file_invalid" } });
    const fresh = await fixture.read();
    const previousVersion = claims.versionId;
    const [version] = await sql<
      { id: string }[]
    >`INSERT INTO code.versions(code_id,number,source_files,bundle,source_hash,bundle_hash,manifest,source_bytes,bundle_bytes,created_by)
      SELECT code_id,number+1,source_files,bundle,source_hash,bundle_hash,manifest,source_bytes,bundle_bytes,created_by
      FROM code.versions WHERE id=${previousVersion}::uuid RETURNING id`;
    await sql`INSERT INTO code.version_submissions(code_id,version_id,binding)
      SELECT code_id,${version!.id}::uuid,jsonb_set(binding,'{versionId}',to_jsonb(${version!.id}::text)) FROM code.version_submissions WHERE version_id=${previousVersion}::uuid`;
    const [account] = await sql<{ service_account_id: string }[]>`SELECT service_account_id FROM code.codes WHERE id=${claims.codeId}`;
    const mandate = await mandates.create({
      authority: { kind: "admin", userId },
      subject: { type: "service_account", id: account!.service_account_id },
      ownerAppId: "runner",
      workloadType: "code.version",
      workloadId: version!.id,
      policy: null,
    });
    if (!mandate.ok) throw new Error(mandate.error.message);
    await sql`UPDATE code.runs SET version_id=${version!.id}::uuid WHERE id=${claims.runId}::uuid`;
    claims = { ...claims, versionId: version!.id, mandateId: mandate.data.id, mandateRevision: mandate.data.revision };
    expect(await (await fixture.write(fresh.data)).json()).toEqual({ ok: false, error: { code: "code_file_invalid" } });
    // The replacement version is admitted and can obtain its own reference.
    expect(await fixture.read()).toMatchObject({ ok: true });
    expect(fixture.received()).toBeUndefined();
  }, 30_000);
  test("4g the source's current advertised limit is checked again at redemption", async () => {
    const fixture = await fileFixture();
    const opened = await fixture.read();
    fileEntries.get("mail")!.manifest.queries[0]!.stream!.maxBytes = fixture.payload.length - 1;
    expect(await (await fixture.write(opened.data)).json()).toEqual({ ok: false, error: { code: "code_file_source_refused" } });
    expect(fixture.sourceBytes()).toBe(0);
    expect(fixture.received()).toBeUndefined();
  }, 30_000);
  test("4g both source and target recheck current access and failures consume the redemption", async () => {
    const fixture = await fileFixture();
    const opened = await fixture.read();
    fixture.denyTarget();
    expect(await (await fixture.write(opened.data)).json()).toMatchObject({ ok: false });
    expect(fixture.received()).toBeUndefined();
    expect(fixture.sourceBytes()).toBe(0);
    expect(await (await fixture.write(opened.data)).json()).toEqual({ ok: false, error: { code: "code_file_spent" } });
  }, 30_000);
  test("4g source grant revoked after issuance refuses the actual read", async () => {
    const fixture = await fileFixture();
    const opened = await fixture.read();
    await sql`DELETE FROM auth.access WHERE id=${fixture.accessId}::uuid`;
    expect(await (await fixture.write(opened.data)).json()).toEqual({ ok: false, error: { code: "code_file_source_refused" } });
    expect(fixture.received()).toBeUndefined();
  }, 30_000);
  test("4g target limits and exact reservation sizes are enforced before source bytes are pulled", async () => {
    const fixture = await fileFixture();
    const opened = await fixture.read();
    fileEntries.get("imports")!.manifest.actions[0]!.stream!.maxBytes = fixture.payload.length - 1;
    expect(await (await fixture.write(opened.data)).json()).toEqual({ ok: false, error: { code: "code_file_size_limit" } });
    fileEntries.get("imports")!.manifest.actions[0]!.stream!.maxBytes = 100 * 1024 * 1024;
    fixture.offerSize(fixture.payload.length - 1);
    expect(await (await fixture.write(opened.data)).json()).toEqual({ ok: false, error: { code: "code_file_mismatch" } });
    expect(fixture.sourceBytes()).toBe(0);
    expect(fixture.received()).toBeUndefined();
  }, 30_000);
  test("write streams without a file metadata input remain unavailable to Code", async () => {
    const entry = structuredClone(baseEntry);
    entry.manifest.actions.find((action) => action.localId === "write")!.stream = { direction: "write", maxBytes: 1024 };
    await error({ entry }, "code_stream_forbidden");
    await expectPolicyRefusal();
  });
  test("code:false is refused", async () => {
    await error({ operation: "example.person" }, "code_disabled");
    await expectPolicyRefusal();
  });
  test("code.access.* is refused even when present in a catalog", async () => {
    await resetFixture({ permissions: [{ operation: "example.code.access.set", target: item, file: "code.ts", line: 1 }] });
    const entry = structuredClone(baseEntry);
    entry.manifest.actions[0]!.localId = "code.access.set";
    await error({ operation: "example.code.access.set", entry }, "code_access_forbidden");
    await expectPolicyRefusal();
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
  for (const operation of ["removes", "sends", "interactive"]) {
    test(`${operation} remains forbidden under an approved Code version`, async () => {
      await sql`INSERT INTO code.version_decisions(version_id,binding,approved,sole_admin,decided_by,decided_via,auth_epoch)
        SELECT version_id,binding,true,false,${userId}::uuid,'session',0 FROM code.version_submissions WHERE version_id=${claims.versionId}::uuid`;
      const capability = `example.${operation}`;
      const call = { capability, target: item, refs: {}, input: {} };
      await error(
        { operation: capability, input: { call, metadata: { idempotencyKey: `forbidden-${operation}` } } },
        operation === "sends" ? "code_sends_not_yet" : "code_unattended_forbidden",
      );
    });
  }
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
  test.each(["settings", "run"])("paginated queries still stop at the durable per-run call limit (%s)", async (limitSource) => {
    await resetFixture({ entry: true, policyRows: ["read"] });
    const entry = {
      ...baseEntry,
      // Dispatch caches validators by schemaHash; compile the cursor schema and its hash together.
      manifest: compileCapabilityManifest("example", {
        protocolVersion: 2,
        types: { folder: { title: "Folder", description: "Fixture folder." } },
        queries: {
          read: {
            ...op,
            target: "folder",
            input: z.object({ cursor: z.string().optional().describe("Opaque next-page cursor.") }).strict(),
          },
        },
      }),
    };
    queryCursor = "opaque:again";
    if (limitSource === "settings") callLimit = 2;
    else await sql`UPDATE code.runs SET calls_limit=2 WHERE id=${claims.runId}::uuid`;
    const fetchedBefore = fetched;
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const response = await send({
        entry,
        operation: "example.read",
        input: {
          call: { capability: "example.read", target: { type: "example.folder", id: "a" }, refs: {}, input: cursor ? { cursor } : {} },
          metadata: {},
        },
      });
      const result = await response.json();
      if (page === 2) expect(result).toEqual({ ok: false, error: { code: "code_call_limit" } });
      else {
        expect(result).toEqual({ ok: true, data: { data: { value: "a" }, page: { hasMore: true, nextCursor: queryCursor } } });
        cursor = result.data.page.nextCursor;
      }
    }
    expect(fetched - fetchedBefore).toBe(2);
    const calls = await sql<
      { ordinal: number; state: string }[]
    >`SELECT ordinal,state FROM code.calls WHERE run_id=${claims.runId}::uuid ORDER BY ordinal`;
    expect(calls).toEqual([
      { ordinal: 1, state: "succeeded" },
      { ordinal: 2, state: "succeeded" },
    ]);
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
