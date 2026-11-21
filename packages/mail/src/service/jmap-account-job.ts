import { redis } from "@k2b/cloud";
import { createRuntimeTaskTracker, logger, stopRuntimeJobs, trace } from "@k2b/cloud/services";
import type { JobContext, JobFailureDecision, Worker } from "@k2b/sync";
import { resolvePublicEndpoint } from "./connectors/endpoint-policy";
import type { JmapAccountScan } from "./connectors/jmap-account-state";
import type { JmapTransportDependencies } from "./connectors/jmap-transport";
import { type JmapAccountAccess, type JmapAccountUnavailableReason, loadJmapAccountAccess } from "./jmap-account-access";
import { extendJmapCooldown, type JmapAccountFailureContext, jmapCooldownMs, recordJmapAccountFailure } from "./jmap-account-failure";
import { classifyJmapFailure } from "./jmap-failure";
import {
  JMAP_SCAN_STALL_MS,
  type JmapAccountRead,
  type JmapAccountScanResult,
  type JmapAccountScanStartResult,
  type JmapAccountSyncResult,
  readJmapAccountCheckpoint,
  startJmapAccountScan,
  syncJmapAccountDelta,
  syncJmapAccountScan,
} from "./jmap-sync-runtime";
import { withLeaseHeartbeat } from "./lease-heartbeat";
import { providerErrorCode } from "./provider-errors";
import {
  acquireProviderLease,
  MAIL_PROVIDER_JOB_CONCURRENCY,
  type ProviderLeasePriority,
  providerLeaseWaiterWoken,
  recordProviderFailure,
  recordProviderReachable,
  releaseProviderLease,
} from "./provider-operation-lock";
import { waitForMailProviderSlot } from "./provider-pacer";
import {
  extendSyncLease,
  type JmapAccountJobInput,
  jmapAccountJob,
  jmapAccountJobInputSchema,
  jmapAccountWaiter,
  parkedJmapAccountInput,
  SYNC_FOLDER_DELIVERY,
  SYNC_FOLDER_MAX_ATTEMPTS,
  SYNC_LEASE_HEARTBEAT_MS,
  SYNC_LEASE_MS,
  wakeMailboxHydration,
} from "./sync-runtime";

const log = logger("mail:sync");

type Phase = JmapAccountJobInput["phase"];
type JmapAccountJobContext = Pick<JobContext<JmapAccountJobInput>, "input" | "heartbeat" | "resubmit" | "signal">;

/** A delta ranks as a folder sync, a scan step or verify page as background work. */
const PHASE_PRIORITY: Record<Phase, ProviderLeasePriority> = { delta: "sync", scan: "background" };

/**
 * One slot of the provider pacer per HTTP request of the account (Session, redirect, API call,
 * download): the pacer waits before the request resolves its endpoint. Valkey only, no SQL.
 */
export const pacedJmapTransport = (remoteResourceId: string, base: JmapTransportDependencies = {}): JmapTransportDependencies => ({
  ...base,
  resolveEndpoint: async (endpoint, timeoutMs, signal) => {
    await waitForMailProviderSlot(remoteResourceId, signal);
    return (base.resolveEndpoint ?? resolvePublicEndpoint)(endpoint, timeoutMs, signal);
  },
});

const stalled = (scan: JmapAccountScan, now: Date): boolean =>
  scan.stalledAt !== null && Date.parse(scan.stalledAt) > now.getTime() - JMAP_SCAN_STALL_MS;

/**
 * What the stored checkpoint asks of a turn, before any network request:
 * - `start`: no checkpoint or a missing state; a scan starts (`initial`), as background work;
 * - `delta`: an initialized account in a `delta` turn, or a `scan` turn without a running scan;
 * - `scan`: the running scan's next step, as background work;
 * - `stalled`: a scan that restarted too often waits out its pause; the turn ends.
 * `phase` is the lease rank the work needs: a turn whose input asked otherwise lets the lease go
 * and asks again with this one.
 */
export function routeJmapAccountTurn(read: JmapAccountRead, phase: Phase): { work: "start" | "delta" | "scan" | "stalled"; phase: Phase } {
  const state = read.state;
  if (!state || state.emailState === null || state.mailboxState === null) return { work: "start", phase: "scan" };
  if (phase === "delta" || state.scan === null) return { work: "delta", phase: "delta" };
  return { work: stalled(state.scan, read.now) ? "stalled" : "scan", phase: "scan" };
}

/** How a turn ended; tests and the trace read it. */
export type JmapAccountTurn =
  | { kind: "deferred"; code: "MAIL_RATE_LIMITED" | "SYNC_BUSY" | "PROVIDER_UNREACHABLE" | "JMAP_PHASE"; retryAfterMs?: number }
  | { kind: "ended"; reason: JmapAccountUnavailableReason | "account_changed" | "stalled" | "auth_required" | "access_denied" }
  | { kind: "delta"; result: JmapAccountSyncResult }
  | { kind: "start"; reason: JmapAccountScan["reason"]; result: JmapAccountScanStartResult }
  | { kind: "scan"; result: JmapAccountScanResult };

// A scan or delta that reported `folders_required` although the delta of its account had no
// folder change asks again; the second report within the scan's stall pause starts a repair from
// a folder snapshot instead of repeating. A repair does not reset the count: a report after it
// fails the turn visibly, so a folder the server never shows ends in the job's attempts instead of
// endless repairs. Only a delta that brings folder changes forgets it. Ephemeral Valkey state.
const foldersRequiredKey = (remoteResourceId: string): string => `mail:jmap-folders-required:{${remoteResourceId}}`;
const countFoldersRequired = async (remoteResourceId: string): Promise<number> => {
  const key = foldersRequiredKey(remoteResourceId);
  try {
    const count = Number(await redis.send("INCR", [key]));
    await redis.send("PEXPIRE", [key, String(JMAP_SCAN_STALL_MS)]);
    return count;
  } catch {
    // Without the count, repair now rather than risk an endless repetition.
    return 2;
  }
};
const forgetFoldersRequired = (remoteResourceId: string): Promise<unknown> =>
  redis.send("DEL", [foldersRequiredKey(remoteResourceId)]).catch(() => 0);

const leaseLost = (code: string): boolean => code === "SYNC_LEASE_LOST" || code === "SYNC_JOB_LEASE_LOST";

/**
 * One turn of `mail:sync-jmap-account`: under the mailbox's provider lease, at most one bounded
 * pass, then the lease goes and the job continues through `resubmit` while work remains.
 *
 * A turn first waits out the account's rate-limit cooldown without the lease. A turn that finds the
 * lease held parks without SQL or network until a release wakes it (`wakeParkedFolderSync`). With
 * the lease, it reads the checkpoint, loads the Session once (`loadJmapAccountAccess`, nothing
 * cached) and runs the pass the checkpoint asks for, the delta before any scan step. A pass whose
 * Session changed loads it once more and reads again; a second change fails the turn. Hydration
 * the pass asked for is woken after the lease is released.
 *
 * `awaited`: a sync command waits for a fresh checkpoint, so a quiet delta still commits. Nobody
 * waits yet; a later slice wires it.
 */
export const runJmapAccountJob = async (
  ctx: JmapAccountJobContext,
  options: { transport?: JmapTransportDependencies; awaited?: boolean } = {},
): Promise<JmapAccountTurn> => {
  const input = jmapAccountJobInputSchema.parse(ctx.input);
  const resource = input.remoteResourceId;
  const waiter = jmapAccountWaiter(resource);
  let phase: Phase = input.phase;
  const continueWith = (next: Phase, delayMs: number) => ctx.resubmit({ delayMs, input: { remoteResourceId: resource, phase: next } });

  const coolingMs = await jmapCooldownMs(resource);
  if (coolingMs > 0) {
    continueWith(phase, coolingMs);
    return { kind: "deferred", code: "MAIL_RATE_LIMITED", retryAfterMs: coolingMs };
  }
  // A delta asked for by an earlier job of the account that parked joins this one.
  const join = (left: string | null) => {
    if (parkedJmapAccountInput(left)?.phase === "delta") phase = "delta";
  };
  const turn = await acquireProviderLease({
    resource,
    waiter,
    priority: PHASE_PRIORITY[phase],
    ttlMs: SYNC_LEASE_MS,
    park: (left) => {
      join(left);
      return JSON.stringify({ remoteResourceId: resource, phase } satisfies JmapAccountJobInput);
    },
  });
  if (!turn.lock) {
    join(turn.left);
    // As for a folder sync: the breaker's window ends the turn; the next request queues it again.
    if (turn.unreachableForMs !== null) return { kind: "deferred", code: "PROVIDER_UNREACHABLE", retryAfterMs: turn.unreachableForMs };
    if (!turn.parked) continueWith(phase, turn.retryAfterMs);
    // A wake that came while this job still ran started no new job, so it goes on itself.
    else if (await providerLeaseWaiterWoken(resource, waiter)) continueWith(phase, 0);
    return { kind: "deferred", code: "SYNC_BUSY", retryAfterMs: turn.retryAfterMs };
  }
  const { lock } = turn;
  const transport = pacedJmapTransport(resource, options.transport);
  // Set by the pass, read after it and after the lease is released.
  const after: {
    next: { phase: Phase; delayMs: number } | null;
    hydrationMailbox: string | null;
    reached: boolean;
    context: JmapAccountFailureContext | null;
  } = { next: null, hydrationMailbox: null, reached: false, context: null };
  let outcome: JmapAccountTurn;
  try {
    outcome = await withLeaseHeartbeat<JmapAccountTurn>({
      intervalMs: SYNC_LEASE_HEARTBEAT_MS,
      heartbeat: async () => {
        await extendSyncLease(lock, "during a JMAP account turn");
        try {
          await ctx.heartbeat();
        } catch (cause) {
          throw Object.assign(new Error("Mail JMAP account job lease was lost"), { code: "SYNC_JOB_LEASE_LOST", cause });
        }
      },
      work: async (_assertLeaseActive, leaseSignal): Promise<JmapAccountTurn> => {
        const signal = AbortSignal.any([ctx.signal, leaseSignal]);
        const read = await readJmapAccountCheckpoint(resource);
        if (!read) return { kind: "ended", reason: "missing" };
        const route = routeJmapAccountTurn(read, phase);
        if (route.phase !== phase) {
          after.next = { phase: route.phase, delayMs: 0 };
          return { kind: "deferred", code: "JMAP_PHASE" };
        }
        if (route.work === "stalled") return { kind: "ended", reason: "stalled" };

        const load = () =>
          loadJmapAccountAccess({
            remoteResourceId: resource,
            signal,
            transport,
            onRead: (credentials) => {
              after.context = { remoteResourceId: resource, ...credentials };
            },
          });
        const loaded = await load();
        if (loaded.status !== "ready") return { kind: "ended", reason: loaded.reason };
        let access: JmapAccountAccess = loaded.access;
        const account = () => ({
          remoteResourceId: resource,
          bindingId: access.bindingId,
          secretRevision: access.secretRevision,
          session: access.session,
          accountId: access.accountId,
          authorization: access.authorization,
          signal,
          transport,
          captureWorkflowTriggers: true,
          read,
        });
        // Nothing of a pass whose Session changed was committed: load the Session once more and
        // read again, for the same binding, credentials and account only.
        const withSession = async <T>(pass: () => Promise<T>): Promise<T | "changed"> => {
          try {
            return await pass();
          } catch (error) {
            if (classifyJmapFailure(error, Date.now())?.kind !== "session_changed") throw error;
            const reloaded = await load();
            if (
              reloaded.status !== "ready" ||
              reloaded.access.bindingId !== access.bindingId ||
              reloaded.access.secretRevision !== access.secretRevision ||
              reloaded.access.accountId !== access.accountId ||
              reloaded.access.session.origin !== access.session.origin
            )
              return "changed";
            access = reloaded.access;
            return pass();
          }
        };
        const ended = (): JmapAccountTurn => ({ kind: "ended", reason: "account_changed" });
        const scanRunning = read.state?.scan != null && !stalled(read.state.scan, read.now);

        const start = async (reason: JmapAccountScan["reason"]): Promise<JmapAccountTurn> => {
          const result = await withSession(() => startJmapAccountScan({ ...account(), reason }));
          if (result === "changed") return ended();
          if (result.status === "committed") {
            after.reached = true;
            after.next = { phase: "scan", delayMs: 0 };
          } else if (result.status === "retry") {
            // A state moved while the snapshot was read: try again after the first retry delay.
            after.reached = true;
            after.next = { phase: "scan", delayMs: SYNC_FOLDER_DELIVERY.backoffMs[0] };
          }
          return { kind: "start", reason, result };
        };
        // `folders_required` although the delta has no folder change: the next turn is a delta,
        // which brings the folders; a repetition starts a repair instead.
        const foldersRequired = async (turnResult: JmapAccountTurn): Promise<JmapAccountTurn> => {
          const reports = await countFoldersRequired(resource);
          if (reports > 2)
            throw Object.assign(new Error("JMAP mailboxes stay unknown after a repair"), { code: "JMAP_FOLDERS_UNRESOLVED" });
          if (reports === 2) return start("repair");
          after.next = { phase: "delta", delayMs: 0 };
          return turnResult;
        };

        if (route.work === "start") return start("initial");
        if (route.work === "delta") {
          const result = await withSession(() => syncJmapAccountDelta({ ...account(), quiet: { awaited: options.awaited === true } }));
          if (result === "changed") return ended();
          const turnResult: JmapAccountTurn = { kind: "delta", result };
          if (result.status === "reconciliation_required") return start(result.axis === "email" ? "reconciliation" : "repair");
          if (result.status === "superseded") return result.cause === "folders_required" ? foldersRequired(turnResult) : ended();
          after.reached = true;
          if (result.hydrationRequested) after.hydrationMailbox = access.mailboxId;
          if (result.stats.folders > 0) await forgetFoldersRequired(resource);
          if (result.hasMore) after.next = { phase: "delta", delayMs: 0 };
          else if (scanRunning) after.next = { phase: "scan", delayMs: 0 };
          return turnResult;
        }
        const result = await withSession(() => syncJmapAccountScan(account()));
        if (result === "changed") return ended();
        const turnResult: JmapAccountTurn = { kind: "scan", result };
        if (result.status === "superseded") return result.cause === "folders_required" ? foldersRequired(turnResult) : ended();
        if (result.status === "idle" || result.status === "stalled") return turnResult;
        after.reached = true;
        // New mail arrives through the delta first; the scan goes on after it, without a failure.
        if (result.status === "delta_required") after.next = { phase: "delta", delayMs: 0 };
        else {
          if (result.hydrationRequested) after.hydrationMailbox = access.mailboxId;
          // After the scan, a delta brings the account up to date.
          after.next = { phase: result.scanComplete ? "delta" : "scan", delayMs: 0 };
        }
        return turnResult;
      },
    });
  } catch (error) {
    const code = providerErrorCode(error, "JMAP_SYNC_FAILED");
    const failure = classifyJmapFailure(error, Date.now());
    // A lost lease or an aborted turn is neither a failure of the account nor a success; nothing
    // is written under a lease or fence this turn may no longer hold.
    if (leaseLost(code) || failure?.kind === "aborted" || ctx.signal.aborted) throw error;
    if (failure?.kind === "rate_limited") {
      // The server's wait, up to its cap, for every JMAP turn of the account; no failure.
      const waitMs = await extendJmapCooldown(resource, failure.retryAfterMs);
      after.next = { phase, delayMs: waitMs };
      return { kind: "deferred", code: "MAIL_RATE_LIMITED", retryAfterMs: waitMs };
    }
    // Only a timeout opens the breaker; other failures leave it as it is.
    await recordProviderFailure(resource, error);
    // Health is written only while this turn still holds the lease.
    const held = await extendSyncLease(lock, "before recording a JMAP failure").then(
      () => true,
      () => false,
    );
    const recorded = after.context;
    if (held && recorded) {
      if (failure?.kind === "auth_required" || failure?.kind === "access_denied") {
        await recordJmapAccountFailure(recorded, { kind: failure.kind });
        // A refused login or account stops the account until it is verified again; no retry.
        return { kind: "ended", reason: failure.kind };
      }
      await recordJmapAccountFailure(recorded, { kind: "degraded", code });
    } else if (failure?.kind === "auth_required" || failure?.kind === "access_denied") {
      return { kind: "ended", reason: failure.kind };
    }
    // Timeouts, unavailable servers, invalid answers and a second Session change retry through the
    // job's attempts; the failed run and the health stay visible.
    throw error;
  } finally {
    const next = after.next;
    await releaseProviderLease(lock, next?.delayMs === 0 ? { waiter, priority: PHASE_PRIORITY[next.phase] } : undefined);
    const mailboxId = after.hydrationMailbox;
    // The durable request is committed; a lost wake waits for the hydration publisher.
    if (mailboxId)
      await wakeMailboxHydration(mailboxId).catch((error: unknown) => {
        log.warn("Mail could not wake body hydration after a JMAP account turn", {
          remoteResourceId: resource,
          code: providerErrorCode(error, "MAIL_HYDRATION_WAKE_FAILED"),
        });
      });
    if (next) continueWith(next.phase, next.delayMs);
  }
  // Only a completed pass closes the breaker, not a Session request that succeeded before a timeout.
  if (after.reached) await recordProviderReachable(resource);
  return outcome;
};

/** Traces turns that changed something or failed; busy, parked and quiet turns stay out. */
export const summarizeJmapAccountTurn = (turn: JmapAccountTurn): Record<string, unknown> | null => {
  if (turn.kind === "deferred") return turn.code === "PROVIDER_UNREACHABLE" ? { deferred: turn.code } : null;
  if (turn.kind === "ended") return turn.reason === "auth_required" || turn.reason === "access_denied" ? { ended: turn.reason } : null;
  const result = turn.result;
  if (result.status !== "committed") return { pass: turn.kind, status: result.status };
  const stats = result.stats;
  const changed = stats.imported + stats.memberships + stats.flagsUpdated + stats.removed + stats.folders > 0;
  return changed || turn.kind !== "delta" ? { pass: turn.kind, ...stats } : null;
};

const tracedJmapAccountJob = trace.backgroundJob(
  "mail:sync-jmap-account",
  (ctx: JobContext<JmapAccountJobInput>) => runJmapAccountJob(ctx),
  summarizeJmapAccountTurn,
);

/** Retries a failed turn or gives up after the last attempt; the log does not need the database. */
export const onJmapAccountJobError = ({
  context,
  error,
}: {
  context: Pick<JobContext<JmapAccountJobInput>, "input" | "attempt">;
  error: Error;
}): JobFailureDecision => {
  if (context.attempt < SYNC_FOLDER_MAX_ATTEMPTS) return { action: "retry" };
  log.error("Mail JMAP account sync exhausted retries", {
    remoteResourceId: context.input.remoteResourceId,
    attempt: context.attempt,
    code: providerErrorCode(error, "JMAP_SYNC_FAILED"),
  });
  return { action: "dead_letter", reason: error.message };
};

const tasks = createRuntimeTaskTracker();
let worker: Worker | undefined;

/**
 * The account job's worker, started and stopped with the Mail runtime. Nothing queues the job
 * yet except its own continuations, a parked turn's wake and a body download whose source was
 * missing. Stopping takes no new turn; a running turn finishes, or its signal aborts it on a forced
 * drain, and it releases the lease either way.
 */
export const jmapAccountRuntime = {
  start: async (): Promise<void> => {
    tasks.open();
    worker = await jmapAccountJob().process({ concurrency: MAIL_PROVIDER_JOB_CONCURRENCY, onError: onJmapAccountJobError }, async (ctx) => {
      await tracedJmapAccountJob(ctx);
    });
  },
  stop: async (): Promise<void> => {
    const running = worker;
    worker = undefined;
    await stopRuntimeJobs(tasks, running ? [running] : []);
  },
};
