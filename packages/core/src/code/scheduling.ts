import { sql } from "@k2b/cloud";
import { type CodeRunTokenClaims, signCodeRunToken } from "@k2b/cloud/code/run-token";
import type { RunnerLease, RunnerOutcome } from "@k2b/cloud/code/runner";
import { CodeCheckedVersionManifestSchema } from "@k2b/cloud/contracts";
import { ratelimit } from "@k2b/cloud/server";
import { audit, coreSettings } from "@k2b/cloud/services";
import { approvalArgsDigest } from "@k2b/cloud/services/approvals";
import type { SQL } from "bun";
import { type CodeContext, CodeDataError, codePerson } from "./access";
import { codeAdmissionLock } from "./admission";
import { requireCodeRunFence } from "./bridge";
import { checkCodeOwnerBeforeRun } from "./owner-check";
import {
  CODE_RUN_HEARTBEAT_MS,
  CODE_RUN_LEASE_MS,
  CODE_SCHEDULE_TICK_RETENTION_MS,
  type CodeRunLimits,
  type CodeRunnerMetrics,
  type CodeScheduleTick,
  type CodeStartRequest,
  CodeStartRequestSchema,
  type CodeStartResult,
} from "./scheduling-contracts";
import { codeSettings } from "./settings";
import { findCode, insertCodeRun, lockCodeForEdit } from "./store";
import { CodeVersionError, requireCodeVersionApproval } from "./versions";

export async function readCodeRunLimits(): Promise<CodeRunLimits> {
  return {
    perCode: await codeSettings.get("core.code.concurrency_per_code"),
    perOwner: await codeSettings.get("core.code.concurrency_per_owner"),
    wallMs: await codeSettings.get("core.code.wall_clock_ms"),
    attempts: await codeSettings.get("core.code.automatic_attempts"),
  };
}

type ScheduledTick = Omit<CodeScheduleTick, "versionId"> & { versionId?: string; cron?: string };

async function enqueue(
  input: { codeId: string; entrypoint: string; requestKey: string; input: unknown; tick?: ScheduledTick },
  db: SQL,
  context?: CodeContext,
): Promise<CodeStartResult | null> {
  await db`SELECT singleton FROM code.policy WHERE singleton FOR SHARE`;
  if (!context) await db`SELECT id FROM code.codes WHERE id=${input.codeId} FOR UPDATE`;
  const code = context ? await lockCodeForEdit(input.codeId, context, db) : await findCode(input.codeId, db);
  if (!code) throw new CodeDataError("NOT_FOUND", "Code not found.");
  const requestDigest = approvalArgsDigest({ entrypoint: input.entrypoint, input: input.input });
  const [receipt] = await db<{ run_id: string; request_digest: string | null }[]>`SELECT run_id,request_digest FROM code.run_requests
    WHERE code_id=${code.id} AND request_key=${input.requestKey}`;
  if (receipt) {
    if (receipt.request_digest !== requestDigest) throw new CodeDataError("CONFLICT", "Idempotency key was used for a different request.");
    return { runId: receipt.run_id, duplicate: true };
  }
  if (input.tick && (code.state !== "active" || (input.tick.versionId !== undefined && code.activeVersionId !== input.tick.versionId)))
    return null;
  if (code.state !== "active" || !code.activeVersionId) throw new CodeDataError("CONFLICT", "Code is not active.");
  const [version] = await db<{ manifest: unknown }[]>`SELECT manifest FROM code.versions WHERE id=${code.activeVersionId}::uuid`;
  const manifest = CodeCheckedVersionManifestSchema.parse(version?.manifest);
  const entry = manifest.entrypoints.find((entry) => entry.entrypoint === input.entrypoint && (!input.tick || entry.kind === "schedule"));
  if (!entry) {
    if (input.tick) return null;
    throw new CodeDataError("BAD_INPUT", "Unknown Code entrypoint.");
  }
  if (input.tick?.cron !== undefined && input.tick.cron !== entry.cron) return null;
  let refused = false;
  try {
    await requireCodeVersionApproval(code, code.activeVersionId, db);
  } catch (error) {
    if (!input.tick || !(error instanceof CodeVersionError)) throw error;
    refused = true;
  }
  const runId = await insertCodeRun(
    {
      codeId: code.id,
      versionId: code.activeVersionId,
      trigger: input.tick ? "schedule" : "manual",
      entrypoint: input.entrypoint,
      input: CodeStartRequestSchema.shape.input.parse(input.input),
    },
    db,
  );
  if (!input.tick && entry.kind === "schedule") await db`UPDATE code.runs SET schedule_key=${input.entrypoint} WHERE id=${runId}::uuid`;
  if (input.tick) {
    // Schedule identity deliberately excludes version: activating a new version cannot overlap the old tick.
    const scheduleKey = input.entrypoint;
    const [busy] = await db`SELECT id FROM code.runs WHERE code_id=${code.id} AND schedule_key=${scheduleKey}
      AND state IN ('queued','running') AND id<>${runId}::uuid LIMIT 1`;
    await db`UPDATE code.runs SET schedule_key=${scheduleKey},state=${busy ? "skipped" : "queued"},
      outcome=${busy ? "previous_schedule_running" : null},ended_at=CASE WHEN ${!!busy} THEN clock_timestamp() ELSE NULL END WHERE id=${runId}::uuid`;
    if (busy) await db`DELETE FROM code.run_outbox WHERE run_id=${runId}::uuid`;
  }
  if (refused) {
    await db`UPDATE code.runs SET state='failed',outcome='code_admission_refused',ended_at=clock_timestamp() WHERE id=${runId}::uuid`;
    await db`DELETE FROM code.run_outbox WHERE run_id=${runId}::uuid`;
  }
  await db`INSERT INTO code.run_requests(code_id,request_key,run_id,request_digest,tick_at)
    VALUES(${code.id},${input.requestKey},${runId}::uuid,${requestDigest},${input.tick?.slot ?? null})`;
  if (context)
    await audit.record(
      {
        action: "core.code.run.started",
        outcome: "allowed",
        actor: { userId: codePerson(context, true).id },
        target: { type: "code", id: code.id },
        requestId: context.requestId,
        metadata: { runId, versionId: code.activeVersionId },
      },
      db,
    );
  return { runId, duplicate: false };
}
/** Permission-aware manual start/rerun for CLI, chat and resource pages. Rerun uses a NEW request key. */
export async function startCodeRun(request: CodeStartRequest, context: CodeContext): Promise<CodeStartResult> {
  const input = CodeStartRequestSchema.parse(request);
  codePerson(context, true);
  const result = await sql.begin((db) => enqueue({ ...input, requestKey: `manual:${input.idempotencyKey}` }, db, context));
  if (!result) throw new Error("Manual admission returned no run");
  return result;
}
/** Retained database tick receipts supplement Sync's at-least-once delivery and finite dedupe window. */
export async function processCodeScheduleTick(tick: CodeScheduleTick): Promise<CodeStartResult | null> {
  return admitScheduleTick(tick);
}
/** Scheduler callbacks bind the current version atomically with admission, including concurrent activation. */
export async function processCurrentCodeScheduleTick(
  tick: Omit<CodeScheduleTick, "versionId"> & { cron: string },
): Promise<CodeStartResult | null> {
  return admitScheduleTick(tick);
}
async function admitScheduleTick(tick: ScheduledTick): Promise<CodeStartResult | null> {
  if (!Number.isFinite(tick.slot.getTime())) throw new RangeError("Invalid schedule slot");
  return sql.begin(async (db) => {
    const [retained] = await db<
      { retained: boolean }[]
    >`SELECT ${tick.slot}>clock_timestamp()-${CODE_SCHEDULE_TICK_RETENTION_MS}*interval '1 millisecond' AS retained`;
    if (!retained?.retained) return null;
    return enqueue(
      {
        codeId: tick.codeId,
        entrypoint: tick.entrypoint,
        input: null,
        tick,
        requestKey: `schedule:${new Bun.CryptoHasher("sha256").update(tick.entrypoint).digest("hex")}:${tick.slot.toISOString()}`,
      },
      db,
    );
  });
}

type ClaimedRun = {
  id: string;
  code_id: string;
  version_id: string;
  entrypoint: string;
  generation: number;
  deadline_at: Date;
  lease_expires_at: Date;
  input: RunnerLease["input"];
  bundle_hash: string;
  mandate_id: string;
  mandate_revision: number;
};
/** Fair DB admission, triggered by a Sync queue delivery. Tickets wake the fleet; they do not pin a worker to a busy Code.
 * Database rows and the generation fence guarantee one active lease despite repeated/delayed queue delivery.
 */
export async function claimCodeRuns(
  freeSlots: number,
  limits: CodeRunLimits,
  instanceId?: string,
  transaction?: SQL,
): Promise<ClaimedRun[]> {
  const slots = Math.min(freeSlots, await codeSettings.get("core.code.runner_slots"));
  if (!Number.isSafeInteger(slots) || slots < 1) throw new RangeError("Invalid runner capacity");
  const claim = async (db: SQL) => {
    await codeAdmissionLock(db);
    await db`SELECT singleton FROM code.policy WHERE singleton FOR SHARE`;
    const claimed: ClaimedRun[] = [];
    // At most the configured slots are examined. Fairness is per Code, including Codes of the same owner.
    for (let index = 0; index < slots; index++) {
      const [candidate] = await db<{ id: string }[]>`
        SELECT c.id FROM code.codes c WHERE c.state='active'
        AND EXISTS(SELECT 1 FROM code.runs r WHERE r.code_id=c.id AND r.state='queued'
          AND r.version_id=c.active_version_id AND (r.deadline_at IS NULL OR r.deadline_at>clock_timestamp()))
        AND (SELECT count(*) FROM code.runs r WHERE r.code_id=c.id AND r.state='running')<${limits.perCode}
        AND (SELECT count(*) FROM code.runs r JOIN code.codes o ON o.id=r.code_id WHERE r.state='running'
          AND ROW(o.owner_kind,o.owner_user_id,o.owner_type,o.owner_id,o.owner_app_id)
            IS NOT DISTINCT FROM ROW(c.owner_kind,c.owner_user_id,c.owner_type,c.owner_id,c.owner_app_id))<${limits.perOwner}
        ORDER BY c.last_dispatched_at NULLS FIRST,c.id LIMIT 1 FOR NO KEY UPDATE OF c SKIP LOCKED`;
      if (!candidate) break;
      const code = await findCode(candidate.id, db);
      if (!code?.activeVersionId) continue;
      try {
        await requireCodeVersionApproval(code, code.activeVersionId, db);
      } catch (error) {
        if (!(error instanceof CodeVersionError)) throw error;
        await db`UPDATE code.runs SET state='failed',outcome='code_admission_refused',ended_at=clock_timestamp()
          WHERE id IN (SELECT id FROM code.runs WHERE code_id=${code.id} AND state='queued' ORDER BY created_at,id LIMIT 100)`;
        await db`UPDATE code.codes SET last_dispatched_at=clock_timestamp() WHERE id=${code.id}`;
        continue;
      }
      const [mandate] = await db<{ id: string; revision: number }[]>`SELECT id,revision::int FROM auth.mandates
        WHERE owner_app_id='core' AND workload_type='code.version' AND workload_id=${code.activeVersionId}
        AND state='active' AND confirmed_at IS NOT NULL AND (expires_at IS NULL OR expires_at>clock_timestamp())
        AND ((subject_kind='user' AND subject_user_id=${code.owner.kind === "person" ? code.owner.userId : null}::uuid)
          OR (subject_kind='service_account' AND subject_service_account_id=${code.serviceAccountId}::uuid))
        ORDER BY id LIMIT 1 FOR SHARE`;
      if (!mandate) {
        await db`UPDATE code.runs SET state='failed',outcome='code_mandate_mismatch',ended_at=clock_timestamp()
          WHERE id IN (SELECT id FROM code.runs WHERE code_id=${code.id} AND state='queued' ORDER BY created_at,id LIMIT 100)`;
        await db`UPDATE code.codes SET last_dispatched_at=clock_timestamp() WHERE id=${code.id}`;
        continue;
      }
      const [run] = await db<ClaimedRun[]>`WITH next AS (
        SELECT id FROM code.runs WHERE code_id=${code.id} AND version_id=${code.activeVersionId}::uuid AND state='queued'
        AND (deadline_at IS NULL OR deadline_at>clock_timestamp()) ORDER BY created_at,id LIMIT 1 FOR NO KEY UPDATE
      ), leased AS (
        UPDATE code.runs r SET state='running',generation=generation+1,runner_instance_id=${instanceId ?? null}::uuid,
          started_at=COALESCE(started_at,clock_timestamp()),
          deadline_at=COALESCE(deadline_at,clock_timestamp()+${limits.wallMs}*interval '1 millisecond'),
          lease_expires_at=LEAST(COALESCE(deadline_at,clock_timestamp()+${limits.wallMs}*interval '1 millisecond'),
            clock_timestamp()+${CODE_RUN_LEASE_MS}*interval '1 millisecond')
        WHERE r.id=(SELECT id FROM next) RETURNING r.*
      ) SELECT leased.*,v.bundle_hash,${mandate.id}::text AS mandate_id,${mandate.revision}::int AS mandate_revision
        FROM leased JOIN code.versions v ON v.id=leased.version_id`;
      if (run) {
        await db`UPDATE code.codes SET last_dispatched_at=clock_timestamp() WHERE id=${code.id}`;
        claimed.push(run);
      }
    }
    return claimed;
  };
  return transaction ? claim(transaction) : sql.begin(claim);
}
/** Owner reads and signing happen after claim commit, outside dispatch locks. Missing owners never receive a token. */
export async function codeRunnerLease(
  run: ClaimedRun,
  sign: typeof signCodeRunToken = signCodeRunToken,
  options: { signal?: AbortSignal; ownerChecks?: Map<string, Promise<boolean>> } = {},
): Promise<RunnerLease | null> {
  const code = await findCode(run.code_id);
  const budget = AbortSignal.timeout(CODE_RUN_HEARTBEAT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, budget]) : budget;
  let check = code ? options.ownerChecks?.get(code.id) : undefined;
  if (code && !check) {
    check = checkCodeOwnerBeforeRun(code, signal);
    options.ownerChecks?.set(code.id, check);
  }
  if (!code || !(await check)) {
    const current = await findCode(run.code_id);
    await sql`UPDATE code.runs SET state=${current?.pauseReason === "owner_not_found" ? "skipped" : "failed"},outcome=${current?.pauseReason === "owner_not_found" ? "owner_not_found" : "code_not_active"},ended_at=clock_timestamp(),lease_expires_at=NULL
      WHERE id=${run.id}::uuid AND generation=${run.generation} AND state='running'`;
    return null;
  }
  signal.throwIfAborted();
  // Refresh the delivery lease after the bounded owner read. Never revive an expired or superseded generation.
  const [renewed] = await sql<{ lease_expires_at: Date }[]>`UPDATE code.runs
    SET lease_expires_at=LEAST(deadline_at,clock_timestamp()+${CODE_RUN_LEASE_MS}*interval '1 millisecond')
    WHERE id=${run.id}::uuid AND generation=${run.generation} AND state='running'
      AND lease_expires_at>clock_timestamp() AND deadline_at>clock_timestamp()
    RETURNING lease_expires_at`;
  if (!renewed) return null;
  const deadlineAt = run.deadline_at.getTime();
  const token = await sign(
    {
      codeId: run.code_id,
      versionId: run.version_id,
      runId: run.id,
      generation: run.generation,
      entrypoint: run.entrypoint,
      mandateId: run.mandate_id,
      mandateRevision: run.mandate_revision,
      bundleHash: run.bundle_hash,
    },
    { deadlineAt },
  );
  return {
    runId: run.id,
    codeId: run.code_id,
    versionId: run.version_id,
    entrypoint: run.entrypoint,
    generation: run.generation,
    mandateRevision: run.mandate_revision,
    bundleHash: run.bundle_hash,
    token,
    organizationId: "installation",
    trustTier: "code",
    deadlineAt,
    leaseExpiresAt: renewed.lease_expires_at.getTime(),
    heartbeatMs: CODE_RUN_HEARTBEAT_MS,
    input: run.input,
  };
}
/** Heartbeats fence under the same row lock as the bridge and never refill a wall-clock budget. */
export async function heartbeatCodeRun(claims: CodeRunTokenClaims): Promise<{ leaseExpiresAt: number }> {
  return sql.begin(async (db) => {
    await requireCodeRunFence(claims, db);
    const [row] = await db<{ lease_expires_at: Date }[]>`UPDATE code.runs
      SET lease_expires_at=LEAST(deadline_at,to_timestamp(${claims.exp}),clock_timestamp()+${CODE_RUN_LEASE_MS}*interval '1 millisecond')
      WHERE id=${claims.runId}::uuid RETURNING lease_expires_at`;
    if (!row) throw new Error("Lease disappeared while locked");
    await db`UPDATE code.runner_instances SET last_seen_at=clock_timestamp()
      WHERE instance_id=(SELECT runner_instance_id FROM code.runs WHERE id=${claims.runId}::uuid)`;
    return { leaseExpiresAt: row.lease_expires_at.getTime() };
  });
}
async function settleRun(runId: string, outcome: RunnerOutcome, limits: CodeRunLimits, db: SQL) {
  // An in-flight or uncertain Action is an effect boundary too. Never retry it automatically.
  const [result] = await db<{ retry: boolean; exhausted: boolean }[]>`SELECT
    (${outcome}<>'succeeded' AND generation<${limits.attempts} AND deadline_at>clock_timestamp()
      AND NOT effect_started AND NOT EXISTS(SELECT 1 FROM code.calls WHERE run_id=r.id AND kind='action')) AS retry,
    (${outcome}<>'succeeded' AND generation>=${limits.attempts} AND deadline_at>clock_timestamp()
      AND NOT effect_started AND NOT EXISTS(SELECT 1 FROM code.calls WHERE run_id=r.id AND kind='action')) AS exhausted
    FROM code.runs r WHERE id=${runId}::uuid`;
  const retry = result?.retry ?? false;
  await db`UPDATE code.calls SET state='uncertain',ended_at=clock_timestamp(),result='{"ok":false,"error":{"code":"code_result_unknown"}}'::json
    WHERE run_id=${runId}::uuid AND state='running'`;
  await db`UPDATE code.runs SET state=${retry ? "queued" : outcome === "succeeded" ? "succeeded" : "failed"},
    outcome=${retry ? null : result?.exhausted ? "retry_exhausted" : outcome}, ended_at=CASE WHEN ${retry} THEN NULL ELSE clock_timestamp() END,lease_expires_at=NULL WHERE id=${runId}::uuid`;
}
/** A reported failure before an Action can requeue within the ORIGINAL budgets; success is terminal. */
export async function completeCodeRun(claims: CodeRunTokenClaims, outcome: RunnerOutcome): Promise<void> {
  const limits = await readCodeRunLimits();
  await sql.begin(async (db) => {
    await requireCodeRunFence(claims, db);
    await settleRun(claims.runId, outcome, limits, db);
  });
}
/** Bounded crash recovery runs on every Core replica; SKIP LOCKED permits safe competing reconcilers. */
export async function reconcileCodeRuns(): Promise<void> {
  const limits = await readCodeRunLimits();
  await sql.begin(async (db) => {
    const expired = await db<{ id: string; timed_out: boolean }[]>`SELECT id,deadline_at<=clock_timestamp() AS timed_out FROM code.runs
      WHERE state='running' AND (lease_expires_at<=clock_timestamp() OR deadline_at<=clock_timestamp())
      ORDER BY lease_expires_at,id LIMIT 100 FOR UPDATE SKIP LOCKED`;
    for (const run of expired) await settleRun(run.id, run.timed_out ? "wall_clock_limit" : "lease_lost", limits, db);
    await db`UPDATE code.runs r SET state='failed',outcome=CASE WHEN r.deadline_at<=clock_timestamp() THEN 'wall_clock_limit' ELSE 'code_not_active' END,ended_at=clock_timestamp()
      WHERE r.id IN(SELECT q.id FROM code.runs q JOIN code.codes c ON c.id=q.code_id WHERE q.state='queued'
        AND (c.state<>'active' OR q.version_id IS DISTINCT FROM c.active_version_id OR q.deadline_at<=clock_timestamp())
        ORDER BY q.created_at,q.id LIMIT 100 FOR UPDATE OF q SKIP LOCKED)`;
    // Periodic outbox repair covers queue retention, delivery exhaustion and a ticket consumed while all Codes were busy.
    await db`INSERT INTO code.run_outbox(run_id) SELECT id FROM code.runs WHERE state='queued'
      AND (wake_at IS NULL OR wake_at<clock_timestamp()-interval '30 seconds') ORDER BY wake_at NULLS FIRST,id LIMIT 100
      ON CONFLICT DO NOTHING`;
    await db`DELETE FROM code.run_requests WHERE (code_id,request_key) IN (
      SELECT code_id,request_key FROM code.run_requests WHERE tick_at<=clock_timestamp()-${CODE_SCHEDULE_TICK_RETENTION_MS}*interval '1 millisecond'
      ORDER BY tick_at LIMIT 1000 FOR UPDATE SKIP LOCKED)`;
    await db`DELETE FROM code.runner_instances WHERE instance_id IN(SELECT instance_id FROM code.runner_instances
      WHERE last_seen_at<clock_timestamp()-${(await codeSettings.get("core.code.runner_poll_ms")) + CODE_RUN_LEASE_MS}*interval '1 millisecond' LIMIT 100)`;
  });
}
/** Signed free-slot telemetry is shared in Postgres. Reported slots are decremented in the fetch response path. */
export async function recordCodeRunner(instanceId: string, freeSlots: number): Promise<void> {
  const [known] = await sql`SELECT instance_id FROM code.runner_instances WHERE instance_id=${instanceId}::uuid`;
  if (!known) {
    // At most the recovery batch's 100 rows / 5 seconds can be introduced per second.
    const limit = Math.min(20, Math.max(1, Math.floor(await coreSettings.get<number>("security.rate_limit_per_second"))));
    if ((await ratelimit({ id: "code-runner-registration", limit }).check("fleet")).limited)
      throw new CodeDataError("CONFLICT", "Runner registration is busy. Retry the poll.");
  }
  await sql`INSERT INTO code.runner_instances(instance_id,free_slots) VALUES(${instanceId}::uuid,${freeSlots})
    ON CONFLICT(instance_id) DO UPDATE SET free_slots=EXCLUDED.free_slots,last_seen_at=clock_timestamp()`;
}
/** Administrative service: callers must carry Core admin authority; run payloads never enter this projection. */
export async function readCodeRunnerMetrics(
  context: CodeContext,
  page: { cursor?: string; limit?: number } = {},
): Promise<CodeRunnerMetrics> {
  if (!codePerson(context).roles.includes("admin")) throw new CodeDataError("FORBIDDEN", "Core admin required.");
  const limit = Math.min(Math.max(page.limit ?? 20, 1), 50);
  if (!Number.isSafeInteger(limit) || (page.cursor && !/^[a-f0-9-]{36}$/.test(page.cursor))) throw new RangeError("Invalid runner page");
  const [counts] = await sql<{ queued: number; running: number; oldest: number }[]>`SELECT
    count(*) FILTER(WHERE state='queued')::int AS queued,count(*) FILTER(WHERE state='running')::int AS running,
    COALESCE(EXTRACT(epoch FROM clock_timestamp()-MIN(created_at) FILTER(WHERE state='queued'))*1000,0)::float8 AS oldest
    FROM code.runs WHERE state IN ('queued','running')`;
  const freshnessMs = (await codeSettings.get("core.code.runner_poll_ms")) + CODE_RUN_LEASE_MS;
  const [fleet] = await sql<
    { instances: number; free_slots: number }[]
  >`SELECT count(*)::int AS instances,COALESCE(sum(free_slots),0)::int AS free_slots
    FROM code.runner_instances WHERE last_seen_at>clock_timestamp()-${freshnessMs}*interval '1 millisecond'`;
  const runners = await sql<{ instance_id: string; free_slots: number; last_seen_at: Date }[]>`SELECT * FROM code.runner_instances
    WHERE last_seen_at>clock_timestamp()-${freshnessMs}*interval '1 millisecond'
    AND (${page.cursor ?? null}::uuid IS NULL OR instance_id>${page.cursor ?? null}::uuid) ORDER BY instance_id LIMIT ${limit + 1}`;
  return {
    queued: counts?.queued ?? 0,
    running: counts?.running ?? 0,
    oldestWaitingMs: Math.max(0, counts?.oldest ?? 0),
    instances: fleet?.instances ?? 0,
    freeSlots: fleet?.free_slots ?? 0,
    runners: runners
      .slice(0, limit)
      .map((r) => ({ instanceId: r.instance_id, freeSlots: r.free_slots, lastSeenAt: r.last_seen_at.toISOString() })),
    nextCursor: runners.length > limit ? runners[limit - 1]!.instance_id : null,
  };
}
