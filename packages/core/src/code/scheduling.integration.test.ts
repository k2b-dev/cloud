import { afterAll, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import * as catalogProvider from "@k2b/cloud/capabilities/server";
import { assertCapabilityReview, compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { CODE_CHECK_LIMITS, type CodeCheckResult, generateCodeSdk } from "@k2b/cloud/code";
import { type CodeRunTokenClaims, signCodeRunToken, verifyCodeRunToken } from "@k2b/cloud/code/run-token";
import type { RunnerFetchResponse, RunnerLease } from "@k2b/cloud/code/runner";
import { RunnerLeaseLostError } from "@k2b/cloud/code/runner";
import type { CapabilityExecutionContext, CodeCheckedVersionManifest, User } from "@k2b/cloud/contracts";
import { coreSettings } from "@k2b/cloud/services";
import { approvalArgsDigest } from "@k2b/cloud/services/approvals";
import { createSync, type Queue, type Sync, type Worker } from "@k2b/sync";
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { connectTestNats, suiteFor, testSyncNamespace, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { aiCapabilities } from "../capabilities";
import { migrate as migrateAppApproval } from "../migrate/core/app-approval";
import { migrate as migrateAudit } from "../migrate/core/audit";
import { migrate as migrateAuth } from "../migrate/core/auth";
import { migrate as migrateCode } from "../migrate/core/code";
import { migrate as migrateJobs } from "../migrate/core/code-jobs";
import { migrate as migratePolicy } from "../migrate/core/code-policy";
import { migrate as migrateScheduling } from "../migrate/core/code-scheduling";
import { migrate as migrateVersions } from "../migrate/core/code-versions";
import { migrate as migrateSettings } from "../migrate/core/settings";
import type { CodeContext } from "./access";
import { verifyCodeSubmission } from "./authoring-check";
import { createCodeBridgeHost, requireCodeRunFence } from "./bridge";
import { claimCodeWork } from "./dispatch";
import {
  completeCodeJob,
  createRunnerCodeCheckHost,
  createRunnerCodeTestingHost,
  readCodeJobInput,
  reconcileCodeJobs,
} from "./runner-jobs";
import {
  claimCodeRuns,
  codeRunnerLease,
  completeCodeRun,
  heartbeatCodeRun,
  processCodeScheduleTick,
  readCodeRunLimits,
  readCodeRunnerMetrics,
  reconcileCodeRuns,
  startCodeRun,
} from "./scheduling";
import {
  type CodeRunWakeup,
  createCodeJobOutbox,
  createCodeRunOutbox,
  createCodeScheduleReconciler,
  fetchCodeRuns,
} from "./scheduling-runtime";
import { CODE_SETTINGS, codeSettings } from "./settings";
import { appendCodeCall, codeBundleHash, codeSourceHash, finishCodeCall, insertCodeRun, readCodeRun } from "./store";

const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
let slot = new Date("2026-11-01T12:00:00Z");
const person = (id: string): User => ({
  id,
  uid: id,
  roles: ["admin"],
  provider: "local",
  profile: "user",
  givenname: "Test",
  sn: "Runner",
  displayName: "Runner Test",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
});
const context = (id = owner): CodeContext => ({
  authority: {
    actor: { kind: "user", user: person(id) },
    accessSubject: { type: "user", userId: id },
    credentialKind: "session",
    scopes: [],
  },
});

suiteFor(
  "database",
  "nats",
  "valkey",
)("C13 stateless Core dispatch through real Postgres and NATS", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  let connection: Awaited<ReturnType<typeof connectTestNats>>;
  let syncs: Sync[] = [];
  let queue: Queue<CodeRunWakeup>;
  let signer: { kid: string; key: CryptoKey; signUntil: Date };
  let key: JWTVerifyGetKey;
  let settings: ReturnType<typeof spyOn<typeof codeSettings, "get">>;
  let ordinal = 0;
  let distantCron = "";
  const overrides = new Map<string, number>();
  const issuer = "https://cloud.example";
  const sign: typeof signCodeRunToken = (claims, options) =>
    signCodeRunToken(claims, {
      ...options,
      issuer,
      signer,
      now: new Date(options.deadlineAt - 300_000),
    });
  async function claims(lease: RunnerLease): Promise<CodeRunTokenClaims> {
    const value = await verifyCodeRunToken(lease.token, { issuer, key, now: new Date(lease.deadlineAt - 300_000) });
    if (!value) throw new Error("Invalid fixture token");
    return value;
  }
  async function fixture(userId = owner) {
    const codeId = `c_c13${String(++ordinal).padStart(5, "0")}`;
    const files = { "code.ts": "fixture" },
      bundle = "export async function weekly() {}";
    const manifest: CodeCheckedVersionManifest = {
      version: 1,
      entry: "code.ts",
      hashes: { source: codeSourceHash(files, "code.ts"), bundle: codeBundleHash(bundle), sdk: "a".repeat(64) },
      entrypoints: [{ kind: "schedule", entrypoint: "weekly", cron: distantCron, file: "code.ts", line: 1 }],
      permissions: [],
      ai: false,
      policyRows: ["read"],
    };
    await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title,state) VALUES(${codeId},'person',${userId}::uuid,'Fixture','active')`;
    const [version] = await sql<
      { id: string }[]
    >`INSERT INTO code.versions(code_id,number,source_files,bundle,source_hash,bundle_hash,manifest,source_bytes,bundle_bytes,created_by)
      VALUES(${codeId},1,${JSON.stringify(files)}::jsonb,${bundle},${manifest.hashes.source},${manifest.hashes.bundle},${JSON.stringify(manifest)}::jsonb,7,32,${userId}::uuid) RETURNING id`;
    if (!version) throw new Error("Missing fixture version");
    await sql`UPDATE code.codes SET active_version_id=${version.id}::uuid WHERE id=${codeId}`;
    const binding = {
      codeId,
      versionId: version.id,
      sourceHash: manifest.hashes.source,
      bundleHash: manifest.hashes.bundle,
      manifestHash: approvalArgsDigest(manifest),
      comparisonVersionId: null,
      comparisonSourceHash: null,
      comparisonBundleHash: null,
    };
    await sql`INSERT INTO code.version_submissions(version_id,code_id,binding) VALUES(${version.id}::uuid,${codeId},${JSON.stringify(binding)}::jsonb)`;
    await sql`INSERT INTO auth.mandates(subject_kind,subject_user_id,owner_app_id,workload_type,workload_id,policy)
      VALUES('user',${userId}::uuid,'core','code.version',${version.id},'{"version":1}'::jsonb)`;
    return { codeId, versionId: version.id, entrypoint: "weekly" };
  }
  async function enqueueMany(code: Awaited<ReturnType<typeof fixture>>, count: number, trigger: "manual" | "schedule" = "manual") {
    const ids: string[] = [];
    for (let index = 0; index < count; index++) {
      const id = await insertCodeRun({ ...code, trigger, input: null });
      ids.push(id);
      await queue.send({ data: { runId: id } });
    }
    return ids;
  }
  async function take() {
    const runs = await claimCodeRuns(1, await readCodeRunLimits());
    expect(runs).toHaveLength(1);
    return codeRunnerLease(runs[0]!, sign);
  }
  async function state(id: string) {
    const [row] = await sql<
      { state: string; outcome: string | null; generation: number; deadline_at: Date }[]
    >`SELECT * FROM code.runs WHERE id=${id}::uuid`;
    if (!row) throw new Error("Missing fixture run");
    return row;
  }
  beforeAll(async () => {
    database = await useFreshDatabase("code_c13");
    await migrateAuth();
    await migrateAudit();
    await migrateSettings();
    await migrateAppApproval();
    await migrateCode();
    await migratePolicy();
    await migrateVersions();
    await migrateScheduling();
    await migrateJobs();
    await migrateScheduling();
    await migrateJobs();
    for (const id of [owner, other])
      await sql`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES(${id}::uuid,${id},'local','user',true)`;
    const [clock] = await sql<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    setSystemTime(clock!.now);
    slot = clock!.now;
    const distant = new Date(clock!.now.getTime() + 7 * 86_400_000);
    distantCron = `0 0 ${distant.getUTCDate()} ${distant.getUTCMonth() + 1} *`;
    const pair = await generateKeyPair("RS256", { extractable: true });
    const kid = "33333333-3333-4333-8333-333333333333";
    signer = { kid, key: pair.privateKey, signUntil: new Date(clock!.now.getTime() + 3_600_000) };
    key = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: "RS256", kid, use: "sig" }] });
    settings = spyOn(codeSettings, "get").mockImplementation(async (name) => overrides.get(name) ?? CODE_SETTINGS[name].default);
    await coreSettings.set("app.timezone", "UTC");
    await coreSettings.set("security.rate_limit_per_second", 60);
    connection = await connectTestNats();
  });
  beforeEach(async () => {
    await sql`DELETE FROM code.codes`;
    await sql`DELETE FROM code.runner_instances`;
    await sql`DELETE FROM code.jobs`;
    await sql`UPDATE code.dispatch_turn SET job_last=FALSE`;
    overrides.clear();
    const sync = createSync({ connection, namespace: testSyncNamespace("c13"), application: "core", defaults: { replicas: 1 } });
    syncs.push(sync);
    queue = sync.queue<CodeRunWakeup>({ id: "runs", retention: { maxAgeMs: 60_000, maxBytes: 1_048_576 } });
    await sync.ready();
  });
  afterAll(async () => {
    settings?.mockRestore();
    for (const sync of syncs) await sync.drain({ timeoutMs: 1000 });
    await connection?.drain();
    await database?.drop();
    setSystemTime();
  });

  test("same permanent key starts one run across Core replicas, while a new key explicitly reruns", async () => {
    const code = await fixture();
    const request = { codeId: code.codeId, entrypoint: code.entrypoint, idempotencyKey: "invoice:001" };
    const results = await Promise.all([
      startCodeRun(request, context()),
      startCodeRun(request, context()),
      startCodeRun(request, context()),
    ]);
    expect(new Set(results.map((r) => r.runId)).size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    const events = await sql<{ actor_user_id: string }[]>`SELECT actor_user_id FROM audit.events
      WHERE action='core.code.run.started' AND target_id=${code.codeId}`;
    expect(events).toEqual([{ actor_user_id: owner }]);
    await expect(startCodeRun({ ...request, input: { changed: true } }, context())).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(startCodeRun({ ...request, entrypoint: "other" }, context())).rejects.toMatchObject({ code: "CONFLICT" });
    const rerun = await startCodeRun({ ...request, idempotencyKey: "invoice:001:rerun" }, context());
    expect(rerun.runId).not.toBe(results[0]!.runId);
    await expect(startCodeRun(request, context(other))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  const checkRequest = () => ({
    files: { "code.ts": "source" },
    entry: "code.ts",
    sdk: generateCodeSdk([], { mode: "personal" }),
    aiOperations: [],
  });
  async function pendingJob() {
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
      const rows = await sql`SELECT id FROM code.jobs WHERE state='queued'`;
      if (rows.length) return;
      await Bun.sleep(5);
    }
    throw new Error("No committed authoring job");
  }
  test("C13b check round-trip preserves permissions and source lines without a bridge token", async () => {
    const expected: CodeCheckResult = {
      ok: true,
      diagnostics: [],
      bundle: "export {}",
      manifest: {
        version: 1,
        entrypoints: [],
        permissions: [{ operation: "example.read", target: null, file: "code.ts", line: 7 }],
        ai: false,
        hashes: { source: "a".repeat(64), sdk: "b".repeat(64), bundle: "c".repeat(64) },
      },
      permissions: [{ operation: "example.read", target: null, file: "code.ts", line: 7, status: "new" }],
    };
    const response = createRunnerCodeCheckHost(context()).check(checkRequest());
    await pendingJob();
    const outbox = createCodeJobOutbox(() => queue);
    expect(await outbox.reconcile()).toBe(1);
    const fetched = await fetchCodeRuns({ instanceId: crypto.randomUUID(), freeSlots: 1 }, new AbortController().signal, { queue, sign });
    expect(fetched.runs).toHaveLength(0);
    const job = fetched.jobs![0]!;
    expect("token" in job).toBe(false);
    expect(
      JSON.parse(await readCodeJobInput({ jobId: job.jobId, generation: job.generation, leaseKey: job.leaseKey })).request.files,
    ).toEqual(checkRequest().files);
    await completeCodeJob(job, { kind: "check", result: expected });
    expect(await response).toEqual(expected);
  });
  test.each(["test", "simulate"] as const)("C13b production testing host transports %s results through the shared queue", async (mode) => {
    const cancel = new AbortController();
    const host = await createRunnerCodeTestingHost({ ...context(), signal: cancel.signal });
    const pending = host.execute({
      mode,
      bundle: "export {}",
      sdk: checkRequest().sdk,
      manifest: {
        version: 1,
        entrypoints: [],
        permissions: [],
        ai: false,
        hashes: { source: "a".repeat(64), sdk: "b".repeat(64), bundle: "c".repeat(64) },
      },
      cases: [],
    });
    const settled = pending.catch((error) => error);
    try {
      await pendingJob();
      await createCodeJobOutbox(() => queue).reconcile();
      const fetched = await fetchCodeRuns({ instanceId: crypto.randomUUID(), freeSlots: 1 }, cancel.signal, { queue, sign });
      const job = fetched.jobs![0]!;
      expect(job.kind).toBe(mode);
      const input = JSON.parse(await readCodeJobInput(job));
      expect(input.execution.mode).toBe(mode);
      expect(input.limits).toEqual(host.limits);
      const result = { version: 1 as const, mode, ok: true, error: null, diagnostics: [], cases: [] };
      await completeCodeJob(job, { kind: mode, result });
      expect(await pending).toEqual(result);
    } finally {
      cancel.abort();
      await settled;
    }
  });
  test.each(["matching", "bundle", "evidence"] as const)("C13b binding server check refuses forged %s submissions", async (variant) => {
    const code = await fixture();
    const [stored] = await sql<
      { source_files: Record<string, string>; bundle: string; manifest: CodeCheckedVersionManifest }[]
    >`SELECT source_files,bundle,manifest FROM code.versions WHERE id=${code.versionId}::uuid`;
    const cancel = new AbortController();
    const catalog = spyOn(catalogProvider, "listCapabilityCatalog").mockResolvedValue({
      ok: true,
      data: { protocolVersion: 2, apps: [], page: { hasMore: false } },
    });
    const pending = verifyCodeSubmission(
      { codeId: code.codeId, sourceFiles: stored!.source_files, bundle: stored!.bundle, manifest: stored!.manifest },
      { ...context(), signal: cancel.signal },
    );
    const settled = pending.then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await pendingJob();
      const job = (await claimCodeWork(1, crypto.randomUUID(), await readCodeRunLimits())).jobs[0]!;
      const { entry: _entry, policyRows: _rows, ...evidence } = stored!.manifest;
      await completeCodeJob(job, {
        kind: "check",
        result: {
          ok: true,
          diagnostics: [],
          bundle: variant === "bundle" ? "forged bundle" : stored!.bundle,
          manifest: { ...evidence, ai: variant === "evidence" ? !evidence.ai : evidence.ai },
          permissions: [],
        },
      });
      if (variant === "matching") expect(await settled).toBeNull();
      else expect(await settled).toMatchObject({ code: "CONFLICT" });
    } finally {
      cancel.abort();
      await settled;
      catalog.mockRestore();
    }
  });
  test("C13b killed checker requeues; the old generation cannot read or complete", async () => {
    const controller = new AbortController();
    const pending = createRunnerCodeCheckHost({ ...context(), signal: controller.signal }).check(checkRequest());
    const settled = pending.catch((error) => error);
    await pendingJob();
    const first = (await claimCodeWork(1, crypto.randomUUID(), await readCodeRunLimits())).jobs[0]!;
    await sql`UPDATE code.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${first.jobId}::uuid`;
    await reconcileCodeJobs();
    const second = (await claimCodeWork(1, crypto.randomUUID(), await readCodeRunLimits())).jobs[0]!;
    expect(second.generation).toBe(first.generation + 1);
    expect(second.leaseKey).not.toBe(first.leaseKey);
    await expect(readCodeJobInput(first)).rejects.toBeInstanceOf(RunnerLeaseLostError);
    await expect(completeCodeJob(first, { kind: "check", result: { ok: false, diagnostics: [] } })).rejects.toBeInstanceOf(
      RunnerLeaseLostError,
    );
    await completeCodeJob(second, { kind: "check", result: { ok: false, diagnostics: [] } });
    expect(await settled).toEqual({ ok: false, diagnostics: [] });
  });
  test("C13b refuses oversized input and overload, and cancellation fences a lease", async () => {
    await expect(
      createRunnerCodeCheckHost(context()).check({ ...checkRequest(), files: { "code.ts": "x".repeat(CODE_CHECK_LIMITS.requestBytes) } }),
    ).rejects.toMatchObject({ code: "code_job_request_limit" });
    expect(await sql`SELECT id FROM code.jobs`).toHaveLength(0);
    overrides.set("core.code.job_pending", 1);
    const cancel = new AbortController();
    const waiting = createRunnerCodeCheckHost({ ...context(), signal: cancel.signal })
      .check(checkRequest())
      .catch((error) => error);
    await pendingJob();
    await expect(createRunnerCodeCheckHost(context()).check(checkRequest())).rejects.toMatchObject({ code: "code_job_busy" });
    const job = (await claimCodeWork(1, crypto.randomUUID(), await readCodeRunLimits())).jobs[0]!;
    cancel.abort();
    expect(await waiting).toMatchObject({ code: "code_job_cancelled" });
    await expect(readCodeJobInput(job)).rejects.toBeInstanceOf(RunnerLeaseLostError);
  });
  test("C13b a burst of checks cannot starve scheduled work with a single free slot", async () => {
    const code = await fixture();
    const ids = await enqueueMany(code, 3, "schedule");
    const input = JSON.stringify({ kind: "check", request: checkRequest() });
    for (let index = 0; index < 20; index++)
      await sql`INSERT INTO code.jobs(kind,owner_id,input,input_bytes,output_bytes,deadline_at) VALUES('check',${owner}::uuid,${input},${Buffer.byteLength(input)},1000,clock_timestamp()+interval '1 minute')`;
    const kinds: string[] = [];
    for (let index = 0; index < 6; index++) {
      const work = await claimCodeWork(1, crypto.randomUUID(), await readCodeRunLimits());
      if (work.jobs.length) {
        kinds.push("job");
        await completeCodeJob(work.jobs[0]!, { kind: "check", result: { ok: false, diagnostics: [] } });
      } else {
        kinds.push("run");
        const run = await codeRunnerLease(work.runs[0]!, sign);
        await completeCodeRun(await claims(run), "succeeded");
      }
    }
    expect(kinds).toEqual(["job", "run", "job", "run", "job", "run"]);
    expect(await sql`SELECT id FROM code.runs WHERE id IN ${sql(ids)} AND state='succeeded'`).toHaveLength(3);
  });
  test("the public manual-run Action shares durable admission across callers", async () => {
    const code = await fixture();
    const request: CapabilityExecutionContext = {
      authority: context().authority,
      actor: context().authority.actor,
      accessSubject: context().authority.accessSubject,
      user: person(owner),
      locale: "en",
      origin: "http",
      signal: new AbortController().signal,
      idempotencyKey: "public-run",
      requestId: "c13-manual",
    };
    const input = { codeId: code.codeId, entrypoint: "weekly", input: null };
    const manifest = compileCapabilityManifest("core", { protocolVersion: 2, actions: { "code.run": aiCapabilities.actions["code.run"] } });
    expect(manifest.actions[0]?.localId).toBe("code.run");
    const review = await aiCapabilities.actions["code.run"].review(input, request);
    expect(review.ok).toBe(true);
    if (review.ok) assertCapabilityReview(review.data);
    const results = await Promise.all([0, 1, 2].map(() => aiCapabilities.actions["code.run"].run(input, request)));
    for (const result of results) expect(result.ok).toBe(true);
    const receipts = results.flatMap((result) => (result.ok ? [result.data.data] : []));
    expect(new Set(receipts.map((r) => r.runId)).size).toBe(1);
    expect(receipts.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(await sql`SELECT id FROM audit.events WHERE action='core.code.run.started' AND target_id=${code.codeId}`).toHaveLength(1);
    const runs = await sql`SELECT id FROM code.runs WHERE code_id=${code.codeId}`;
    expect(runs).toHaveLength(1);
    expect(await aiCapabilities.actions["code.run"].run({ ...input, input: { changed: true } }, request)).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
    const [grant] = await sql<{ id: string }[]>`INSERT INTO auth.access(user_id,permission) VALUES(${other}::uuid,'write') RETURNING id`;
    await sql`INSERT INTO code.shares(code_id,access_id) VALUES(${code.codeId},${grant!.id}::uuid)`;
    const secondEditor: CapabilityExecutionContext = {
      ...request,
      authority: context(other).authority,
      actor: context(other).authority.actor,
      accessSubject: context(other).authority.accessSubject,
      user: person(other),
      requestId: "c13-manual-other",
    };
    const separate = await aiCapabilities.actions["code.run"].run(input, secondEditor);
    expect(separate.ok).toBe(true);
    if (separate.ok) {
      expect(separate.data.data.duplicate).toBe(false);
      expect(separate.data.data.runId).not.toBe(receipts[0]!.runId);
    }
    expect(await sql`SELECT id FROM code.runs WHERE code_id=${code.codeId}`).toHaveLength(2);
    expect(await sql`SELECT id FROM audit.events WHERE action='core.code.run.started' AND target_id=${code.codeId}`).toHaveLength(2);
  });
  test("committed starts and retries reach the real queue through the durable outbox", async () => {
    const code = await fixture();
    const started = await startCodeRun({ codeId: code.codeId, entrypoint: "weekly", idempotencyKey: "outbox" }, context());
    const publisher = createCodeRunOutbox(() => queue);
    expect(await publisher.reconcile()).toBe(1);
    const instanceId = "77777777-7777-4777-8777-777777777777";
    const first = (await fetchCodeRuns({ instanceId, freeSlots: 1 }, new AbortController().signal, { queue, sign })).runs[0]!;
    expect(first.runId).toBe(started.runId);
    await completeCodeRun(await claims(first), "failed");
    expect(await publisher.reconcile()).toBe(1);
    const second = (await fetchCodeRuns({ instanceId, freeSlots: 1 }, new AbortController().signal, { queue, sign })).runs[0]!;
    expect(second.runId).toBe(started.runId);
    expect(second.generation).toBe(2);
    await completeCodeRun(await claims(second), "succeeded");
    await publisher.stop();
  });
  for (const ownerLimit of [false, true])
    test(`real outbox drains default-limit backlog without recovery (owner limit: ${ownerLimit})`, async () => {
      overrides.set("core.code.runner_poll_ms", 1000);
      if (ownerLimit) overrides.set("core.code.concurrency_per_owner", 1);
      const code = await fixture();
      const neighbor = ownerLimit ? await fixture() : code;
      const ids = [];
      for (let index = 0; index < 6; index++)
        ids.push(
          (
            await startCodeRun(
              {
                codeId: index % 2 ? neighbor.codeId : code.codeId,
                entrypoint: "weekly",
                idempotencyKey: `backlog:${index}`,
              },
              context(),
            )
          ).runId,
        );
      const publisher = createCodeRunOutbox(() => queue);
      const instanceId = "88888888-8888-4888-8888-888888888888";
      const fetch = () => fetchCodeRuns({ instanceId, freeSlots: 1 }, new AbortController().signal, { queue, sign });
      try {
        await publisher.reconcile();
        const takeResponse = async () => {
          const deadline = AbortSignal.timeout(5000);
          while (!deadline.aborted) {
            const response = await fetchCodeRuns({ instanceId, freeSlots: 1 }, deadline, { queue, sign });
            if (response.runs.length) return response;
          }
          throw new Error("No runnable backlog lease within the test budget");
        };
        let response = await takeResponse();
        // Exhaust the real published tickets while capacity is occupied, just as concurrent idle runners do.
        expect((await fetch()).runs).toHaveLength(0);
        const seen = new Set<string>();
        for (let index = 0; index < ids.length; index++) {
          expect(response.runs).toHaveLength(1);
          const lease = response.runs[0]!;
          expect(seen.has(lease.runId)).toBe(false);
          seen.add(lease.runId);
          await completeCodeRun(await claims(lease), "succeeded");
          if (index < ids.length - 1) {
            expect(await publisher.reconcile()).toBeGreaterThan(0);
            response = await takeResponse();
          }
        }
        expect(seen).toEqual(new Set(ids));
      } finally {
        await publisher.stop();
      }
    }, 10_000);
  test("expired wall budget has its own outcome for queued and running runs", async () => {
    const code = await fixture();
    const ids = await enqueueMany(code, 2);
    await take();
    await sql`UPDATE code.runs SET deadline_at=clock_timestamp()-interval '1 second' WHERE code_id=${code.codeId}`;
    await reconcileCodeRuns();
    for (const id of ids) expect(await state(id)).toMatchObject({ state: "failed", outcome: "wall_clock_limit" });
  });
  test("a refused scheduled tick is visible and permanently deduplicated", async () => {
    const code = await fixture();
    await sql`DELETE FROM code.version_submissions WHERE version_id=${code.versionId}::uuid`;
    const tick = { ...code, slot };
    const result = await processCodeScheduleTick(tick);
    expect(await state(result!.runId)).toMatchObject({ state: "failed", outcome: "code_admission_refused" });
    expect(await processCodeScheduleTick(tick)).toEqual({ runId: result!.runId, duplicate: true });
    const expired = new Date(slot.getTime() - 8 * 86_400_000);
    await sql`UPDATE code.run_requests SET tick_at=${expired} WHERE run_id=${result!.runId}::uuid`;
    await reconcileCodeRuns();
    expect(await sql`SELECT run_id FROM code.run_requests WHERE run_id=${result!.runId}::uuid`).toHaveLength(0);
    expect(await processCodeScheduleTick({ ...tick, slot: expired })).toBeNull();
    expect(await claimCodeRuns(1, await readCodeRunLimits())).toHaveLength(0);
  });
  test("three runners complete 200 runs exactly once, never exceeding their free slots", async () => {
    overrides.set("core.code.concurrency_per_code", 100);
    overrides.set("core.code.concurrency_per_owner", 1000);
    const code = await fixture();
    const ids = await enqueueMany(code, 200);
    // Repeated queue delivery cannot manufacture a second lease.
    await queue.send({ data: { runId: ids[0]! } });
    const seen = new Set<string>();
    const stop = new AbortController();
    const timeout = setTimeout(() => stop.abort(new Error("Bounded runner test expired")), 15_000);
    const runners = [
      "44444444-4444-4444-8444-444444444441",
      "44444444-4444-4444-8444-444444444442",
      "44444444-4444-4444-8444-444444444443",
    ];
    try {
      await Promise.all(
        runners.map(async (instanceId) => {
          while (!stop.signal.aborted) {
            let response: RunnerFetchResponse;
            try {
              response = await fetchCodeRuns({ instanceId, freeSlots: 4 }, stop.signal, { queue, sign });
            } catch (error) {
              if (seen.size === 200 && stop.signal.aborted) return;
              throw error;
            }
            expect(response.runs.length).toBeLessThanOrEqual(4);
            for (const lease of response.runs) {
              expect(seen.has(lease.runId)).toBe(false);
              expect(lease.generation).toBe(1);
              await completeCodeRun(await claims(lease), "succeeded");
              seen.add(lease.runId);
            }
            if (seen.size === 200) stop.abort();
          }
        }),
      );
      expect(seen.size).toBe(200);
      const [summary] = await sql<
        { count: number; generations: number }[]
      >`SELECT count(*)::int AS count,max(generation)::int AS generations
        FROM code.runs WHERE code_id=${code.codeId} AND state='succeeded'`;
      expect(summary).toEqual({ count: 200, generations: 1 });
    } finally {
      clearTimeout(timeout);
      stop.abort();
    }
  }, 20_000);
  test("failure before the first Action retries with a new generation and unchanged budget", async () => {
    const code = await fixture();
    await enqueueMany(code, 1);
    const first = await take(),
      old = await claims(first);
    await completeCodeRun(old, "failed");
    expect((await state(first.runId)).state).toBe("queued");
    const next = await take();
    expect(next.runId).toBe(first.runId);
    expect(next.generation).toBe(2);
    expect(next.deadlineAt).toBe(first.deadlineAt);
    await expect(heartbeatCodeRun(old)).rejects.toMatchObject({ code: "runner_lease_lost", status: 409 });
    await expect(sql.begin((db) => requireCodeRunFence(old, db))).rejects.toMatchObject({ status: 409 });
    await completeCodeRun(await claims(next), "succeeded");
  });
  test("Action observation before an uncertain effect prevents automatic retry and preserves the ordered call list", async () => {
    const code = await fixture();
    await enqueueMany(code, 1);
    const lease = await take();
    await sql.begin((db) =>
      appendCodeCall({ runId: lease.runId, kind: "action", call: { capability: "example.write", target: null, refs: {}, input: {} } }, db),
    );
    await completeCodeRun(await claims(lease), "failed");
    expect((await state(lease.runId)).state).toBe("failed");
    const result = await readCodeRun({ codeId: code.codeId, runId: lease.runId, cursor: 0, offset: 0, length: 1000 }, context());
    expect(result.contents?.calls[0]?.ordinal).toBe(1);
    expect(result.contents?.calls[0]?.state).toBe("uncertain");
    expect(result.contents?.calls[0]?.result).toEqual({ ok: false, error: { code: "code_result_unknown" } });
    await sql.begin((db) =>
      finishCodeCall(
        { runId: lease.runId, ordinal: 1, state: "succeeded", result: { ok: true, data: { stored: true } }, endedAt: new Date() },
        db,
      ),
    );
    const late = await readCodeRun({ codeId: code.codeId, runId: lease.runId, cursor: 0, offset: 0, length: 1000 }, context());
    expect(late.contents?.calls[0]).toMatchObject({ state: "succeeded", result: { ok: true, data: { stored: true } } });
    expect(await claimCodeRuns(1, await readCodeRunLimits())).toHaveLength(0);
  });
  test("killed runner before an Action requeues; after an Action fails; expired generation cannot heartbeat or call", async () => {
    const code = await fixture();
    await enqueueMany(code, 1);
    const first = await take(),
      old = await claims(first);
    await sql`UPDATE code.runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${first.runId}::uuid`;
    await expect(heartbeatCodeRun(old)).rejects.toMatchObject({ status: 409 });
    await reconcileCodeRuns();
    const second = await take();
    expect(second.generation).toBe(2);
    await expect(
      createCodeBridgeHost().withCall(
        { claims: old, kind: "query", call: { capability: "example.read", target: null, refs: {}, input: {} } },
        async () => Response.json({ ok: true, data: null }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await sql.begin((db) =>
      appendCodeCall({ runId: second.runId, kind: "action", call: { capability: "example.write", target: null, refs: {}, input: {} } }, db),
    );
    await sql`UPDATE code.runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${first.runId}::uuid`;
    await reconcileCodeRuns();
    expect((await state(first.runId)).state).toBe("failed");
  });
  test("a Code with 100 queued runs cannot block a different Code or owner", async () => {
    const busy = await fixture(),
      neighbor = await fixture(other);
    await enqueueMany(busy, 100);
    await enqueueMany(neighbor, 1);
    const leases = await claimCodeRuns(4, await readCodeRunLimits());
    expect(leases).toHaveLength(2);
    expect(new Set(leases.map((r) => r.code_id))).toEqual(new Set([busy.codeId, neighbor.codeId]));
  });
  test("owner concurrency is shared across Codes and independent Core fetches", async () => {
    overrides.set("core.code.concurrency_per_owner", 1);
    for (let index = 0; index < 3; index++) await enqueueMany(await fixture(), 1);
    const batches = await Promise.all([
      claimCodeRuns(4, await readCodeRunLimits()),
      claimCodeRuns(4, await readCodeRunLimits()),
      claimCodeRuns(4, await readCodeRunLimits()),
    ]);
    expect(batches.flat()).toHaveLength(1);
  });
  test("heartbeats never extend the original wall deadline and automatic retry stops at its attempt budget", async () => {
    const code = await fixture();
    await enqueueMany(code, 1);
    let lease = await take();
    const renewed = await heartbeatCodeRun(await claims(lease));
    expect(renewed.leaseExpiresAt).toBeLessThanOrEqual(lease.deadlineAt);
    for (let generation = 1; generation <= 3; generation++) {
      expect(lease.generation).toBe(generation);
      await completeCodeRun(await claims(lease), "failed");
      if (generation < 3) lease = await take();
    }
    expect(await state(lease.runId)).toMatchObject({ state: "failed", outcome: "retry_exhausted" });
  });
  test("one permanent schedule tick with three Core deliveries; running predecessor records the skipped tick", async () => {
    const code = await fixture();
    const ticks = await Promise.all([0, 1, 2].map(() => processCodeScheduleTick({ ...code, slot })));
    expect(new Set(ticks.map((t) => t?.runId)).size).toBe(1);
    const lease = await take();
    const skipped = await processCodeScheduleTick({ ...code, slot: new Date(slot.getTime() + 60_000) });
    expect(await state(skipped!.runId)).toMatchObject({ state: "skipped", outcome: "previous_schedule_running" });
    await completeCodeRun(await claims(lease), "succeeded");
    const next = await processCodeScheduleTick({ ...code, slot: new Date(slot.getTime() + 120_000) });
    expect((await state(next!.runId)).state).toBe("queued");
  });
  test("a manual execution of a schedule also causes an overlapping tick to be skipped", async () => {
    const code = await fixture();
    await startCodeRun({ codeId: code.codeId, entrypoint: "weekly", idempotencyKey: "manual-schedule" }, context());
    await take();
    const skipped = await processCodeScheduleTick({ ...code, slot });
    expect(await state(skipped!.runId)).toMatchObject({ state: "skipped", outcome: "previous_schedule_running" });
  });
  test("real Sync scheduler fires once with three Core workers, independently of runner count", async () => {
    const code = await fixture();
    const namespace = testSyncNamespace("c13-scheduler");
    const workers: Worker[] = [];
    const schedulers = [];
    try {
      for (let index = 0; index < 3; index++) {
        const sync = createSync({ connection, namespace, application: "core", defaults: { replicas: 1 } });
        syncs.push(sync);
        const scheduler = sync.scheduler({ id: "code" });
        schedulers.push(scheduler);
        await createCodeScheduleReconciler(scheduler)();
        workers.push(await scheduler.process());
      }
      const schedule = (await schedulers[0]!.list())[0]!;
      const run = await schedulers[0]!.runNow({ id: schedule.id, requestId: "one-tick" });
      const completed = await schedulers[0]!.awaitRun({ id: schedule.id, runId: run.runId, timeoutMs: 5000 });
      expect(completed.completed).toBe(true);
      const [count] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM code.runs WHERE code_id=${code.codeId}`;
      expect(count?.count).toBe(1);
    } finally {
      for (const worker of workers) worker.stop();
      await Promise.all(workers.map((w) => w.drain({ timeoutMs: 1000 })));
    }
  }, 10_000);
  test("a rejected schedule definition does not prevent another Code from registering", async () => {
    const broken = await fixture(),
      healthy = await fixture();
    const sync = createSync({
      connection,
      namespace: testSyncNamespace("c13-sync-isolation"),
      application: "core",
      defaults: { replicas: 1 },
    });
    syncs.push(sync);
    const scheduler = sync.scheduler({ id: "code" });
    const create = scheduler.create.bind(scheduler);
    const fail = spyOn(scheduler, "create").mockImplementation((definition) => {
      if (definition.meta?.codeId === broken.codeId) return Promise.reject(new Error("Fixture definition rejected"));
      return create(definition);
    });
    try {
      await createCodeScheduleReconciler(scheduler)();
      expect((await scheduler.list()).map((s) => s.meta?.codeId)).toEqual([healthy.codeId]);
    } finally {
      fail.mockRestore();
    }
  });
  test("retained schedule callbacks bind a newly active version without waiting for reconciliation", async () => {
    const code = await fixture();
    const sync = createSync({ connection, namespace: testSyncNamespace("c13-activation"), application: "core", defaults: { replicas: 1 } });
    syncs.push(sync);
    const scheduler = sync.scheduler({ id: "code" });
    const reconcile = createCodeScheduleReconciler(scheduler);
    await reconcile();
    const original = (await scheduler.list())[0]!;
    const [next] = await sql<
      { id: string }[]
    >`INSERT INTO code.versions(code_id,number,source_files,bundle,source_hash,bundle_hash,manifest,source_bytes,bundle_bytes,created_by)
      SELECT code_id,2,source_files,bundle,source_hash,bundle_hash,manifest,source_bytes,bundle_bytes,created_by
      FROM code.versions WHERE id=${code.versionId}::uuid RETURNING id`;
    await sql`INSERT INTO code.version_submissions(version_id,code_id,binding)
      SELECT ${next!.id}::uuid,code_id,jsonb_set(binding,'{versionId}',to_jsonb(${next!.id}::text))
      FROM code.version_submissions WHERE version_id=${code.versionId}::uuid`;
    await sql`UPDATE code.codes SET active_version_id=${next!.id}::uuid WHERE id=${code.codeId}`;
    const worker = await scheduler.process();
    try {
      const tick = await scheduler.runNow({ id: original.id, requestId: "after-activation" });
      expect((await scheduler.awaitRun({ id: original.id, runId: tick.runId, timeoutMs: 5000 })).completed).toBe(true);
      const runs = await sql<{ version_id: string }[]>`SELECT version_id FROM code.runs WHERE code_id=${code.codeId}`;
      expect(runs).toEqual([{ version_id: next!.id }]);
      await reconcile();
      expect((await scheduler.list()).map((s) => s.id)).toEqual([original.id]);
    } finally {
      worker.stop();
      await worker.drain({ timeoutMs: 1000 });
    }
  }, 10_000);
  test("fully occupied runners remain visible through lease heartbeats", async () => {
    const code = await fixture();
    await enqueueMany(code, 1);
    const instanceId = "66666666-6666-4666-8666-666666666666";
    const response = await fetchCodeRuns({ instanceId, freeSlots: 1 }, new AbortController().signal, { queue, sign });
    const lease = response.runs[0]!;
    expect((await readCodeRunnerMetrics(context())).freeSlots).toBe(0);
    await sql`UPDATE code.runner_instances SET last_seen_at=clock_timestamp()-interval '1 minute' WHERE instance_id=${instanceId}::uuid`;
    expect((await readCodeRunnerMetrics(context())).instances).toBe(0);
    await heartbeatCodeRun(await claims(lease));
    expect((await readCodeRunnerMetrics(context())).instances).toBe(1);
  });
  test("fleet metrics expose queue age, fresh instances and free slots without run payloads", async () => {
    const code = await fixture();
    await enqueueMany(code, 2);
    await sql`INSERT INTO code.runner_instances(instance_id,free_slots) VALUES('55555555-5555-4555-8555-555555555555',3)`;
    const metrics = await readCodeRunnerMetrics(context());
    expect(metrics.queued).toBe(2);
    expect(metrics.instances).toBe(1);
    expect(metrics.freeSlots).toBe(3);
    expect(metrics.oldestWaitingMs).toBeGreaterThanOrEqual(0);
    expect(Object.keys(metrics.runners[0]!).sort()).toEqual(["freeSlots", "instanceId", "lastSeenAt"]);
  });
});
