import { afterAll, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { type CodeRunTokenClaims, signCodeRunToken, verifyCodeRunToken } from "@k2b/cloud/code/run-token";
import type { RunnerFetchResponse, RunnerLease } from "@k2b/cloud/code/runner";
import type { CodeCheckedVersionManifest, User } from "@k2b/cloud/contracts";
import { coreSettings } from "@k2b/cloud/services";
import { approvalArgsDigest } from "@k2b/cloud/services/approvals";
import { createSync, type Queue, type Sync, type Worker } from "@k2b/sync";
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { connectTestNats, suiteFor, testSyncNamespace, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAppApproval } from "../migrate/core/app-approval";
import { migrate as migrateAuth } from "../migrate/core/auth";
import { migrate as migrateCode } from "../migrate/core/code";
import { migrate as migratePolicy } from "../migrate/core/code-policy";
import { migrate as migrateScheduling } from "../migrate/core/code-scheduling";
import { migrate as migrateVersions } from "../migrate/core/code-versions";
import { migrate as migrateSettings } from "../migrate/core/settings";
import type { CodeContext } from "./access";
import { createCodeBridgeHost, requireCodeRunFence } from "./bridge";
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
import { type CodeRunWakeup, createCodeScheduleReconciler, fetchCodeRuns } from "./scheduling-runtime";
import { CODE_SETTINGS, codeSettings } from "./settings";
import { appendCodeCall, codeBundleHash, codeSourceHash, insertCodeRun, readCodeRun } from "./store";

const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const slot = new Date("2026-11-01T12:00:00Z");
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

suiteFor("database", "nats")("C13 stateless Core dispatch through real Postgres and NATS", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  let connection: Awaited<ReturnType<typeof connectTestNats>>;
  let syncs: Sync[] = [];
  let queue: Queue<CodeRunWakeup>;
  let signer: { kid: string; key: CryptoKey; signUntil: Date };
  let key: JWTVerifyGetKey;
  let settings: ReturnType<typeof spyOn<typeof codeSettings, "get">>;
  let timezone: ReturnType<typeof spyOn<typeof coreSettings, "get">>;
  let ordinal = 0;
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
      entrypoints: [{ kind: "schedule", entrypoint: "weekly", cron: "* * * * *", file: "code.ts", line: 1 }],
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
  async function enqueueMany(code: Awaited<ReturnType<typeof fixture>>, count: number) {
    const ids: string[] = [];
    for (let index = 0; index < count; index++) {
      const id = await insertCodeRun({ ...code, trigger: "manual", input: null });
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
    await migrateSettings();
    await migrateAppApproval();
    await migrateCode();
    await migratePolicy();
    await migrateVersions();
    await migrateScheduling();
    await migrateScheduling();
    for (const id of [owner, other])
      await sql`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES(${id}::uuid,${id},'local','user',true)`;
    const [clock] = await sql<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    setSystemTime(clock!.now);
    const pair = await generateKeyPair("RS256", { extractable: true });
    const kid = "33333333-3333-4333-8333-333333333333";
    signer = { kid, key: pair.privateKey, signUntil: new Date(clock!.now.getTime() + 3_600_000) };
    key = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: "RS256", kid, use: "sig" }] });
    settings = spyOn(codeSettings, "get").mockImplementation(async (name) => overrides.get(name) ?? CODE_SETTINGS[name].default);
    timezone = spyOn(coreSettings, "get").mockResolvedValue("UTC");
    connection = await connectTestNats();
  });
  beforeEach(async () => {
    await sql`DELETE FROM code.codes`;
    await sql`DELETE FROM code.runner_instances`;
    overrides.clear();
    const sync = createSync({ connection, namespace: testSyncNamespace("c13"), application: "core", defaults: { replicas: 1 } });
    syncs.push(sync);
    queue = sync.queue<CodeRunWakeup>({ id: "runs", retention: { maxAgeMs: 60_000, maxBytes: 1_048_576 } });
    await sync.ready();
  });
  afterAll(async () => {
    settings?.mockRestore();
    timezone?.mockRestore();
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
    const rerun = await startCodeRun({ ...request, idempotencyKey: "invoice:001:rerun" }, context());
    expect(rerun.runId).not.toBe(results[0]!.runId);
    await expect(startCodeRun(request, context(other))).rejects.toMatchObject({ code: "NOT_FOUND" });
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
    expect(result.contents?.calls[0]?.state).toBe("failed");
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
    expect((await state(lease.runId)).state).toBe("failed");
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
