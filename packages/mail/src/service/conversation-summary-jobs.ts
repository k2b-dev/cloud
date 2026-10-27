import { lazySync } from "@k2b/cloud";
import { createRuntimeLifecycle, createRuntimeTaskTracker, logger, stopRuntimeJobs, toPgTextArray } from "@k2b/cloud/services";
import { err, fail, ok, type Result, unwrap } from "@k2b/stdlib";
import type { JobContext, Worker } from "@k2b/sync";
import { sql } from "bun";
import { z } from "zod";
import { consumeAiDailyBudget, releaseAiDailyBudget, reserveAiDailyBudget } from "./ai-daily-budget";
import { durableCredentialSnapshot, type MailRequestContext, userBackedActor } from "./auth";
import { insertActivity, requireConversationCollaborationPermission } from "./collaboration";
import {
  type ConversationContentSummary,
  type ConversationSummaryFailureCode,
  getConversationSummary,
  loadConversationSummary,
  mapConversationSummary,
  type SummaryMetadata,
} from "./conversation-summary";
import { generateConversationSummaryAi, getConversationSummaryAiAvailability } from "./conversation-summary-ai";
import { withLeaseHeartbeat } from "./lease-heartbeat";
import { mailLive } from "./live";

type SqlClient = typeof sql;
export const SUMMARY_QUIET_PERIOD_MS = 60_000;
const CLAIM_MS = 5 * 60_000;
const log = logger("mail:conversation-summary");

export const generateConversationSummarySchema = z
  .object({
    mode: z.enum(["rolling", "replace"]).default("rolling"),
    expectedSummaryRevision: z.number().int().positive(),
  })
  .strict();

type SummarySource = { id: string; name: string; maxAiCallsPerDay?: number | null };
type SummaryRequest = {
  context: MailRequestContext;
  expectedSummaryRevision?: number;
  source: SummarySource | null;
  followup?: { context: MailRequestContext; source: SummarySource; style: SummaryRequest["style"]; mode: SummaryRequest["mode"] };
  style: "short" | "bullets" | "detailed";
  mode: "rolling" | "replace";
};
type SummaryBasis = {
  summaryRevision: number;
  conversationRevision: number;
  throughMessageSeq: string | null;
  messageCount: number;
  previousSummary: string | null;
};
type RequestRow = {
  conversation_id: string;
  mailbox_id: string;
  request_id: string;
  request: SummaryRequest;
  basis: SummaryBasis | null;
  status: ConversationContentSummary["status"];
  due_at: Date;
  claim_id: string | null;
  attempts: number;
};
type Scope = { mailboxId: string; conversationId: string };

const lockScope = async (db: SqlClient, scope: Scope) => {
  await db`SELECT id FROM mail.mailboxes WHERE id = ${scope.mailboxId}::uuid FOR NO KEY UPDATE`;
  return loadConversationSummary({ ...scope, db, lock: true });
};

const requestRow = async (db: SqlClient, scope: Scope) => {
  const [row] = await db<RequestRow[]>`SELECT * FROM mail.conversation_summary_requests
    WHERE conversation_id = ${scope.conversationId}::uuid AND mailbox_id = ${scope.mailboxId}::uuid`;
  return row ?? null;
};

const activity = async (db: SqlClient, scope: Scope, request: SummaryRequest, status: string, metadata: Record<string, unknown> = {}) =>
  insertActivity({
    db,
    ...scope,
    context: request.context,
    action: "conversation.summary_updated",
    targetType: "conversation",
    targetId: scope.conversationId,
    metadata: { reason: "summary", summaryStatus: status, source: request.source, ...metadata },
  });

const release = async (db: SqlClient, row: RequestRow) => {
  if (row.request.source)
    unwrap(await releaseAiDailyBudget({ db, mailboxId: row.mailbox_id, sourceId: row.request.source.id, reservationKey: row.request_id }));
};

const reserve = async (db: SqlClient, scope: Scope, source: SummarySource, key: string) =>
  unwrap(
    await reserveAiDailyBudget({
      db,
      mailboxId: scope.mailboxId,
      sourceId: source.id,
      sourceName: source.name,
      reservationKey: key,
      plannedMaxCalls: 1,
      maxAiCallsPerDay: source.maxAiCallsPerDay,
    }),
  );

/** Trusted source adapter boundary. Authorize the source identity before calling; Mail rechecks the actor's resource permission.
 * Reserve a whole future run separately with reserveAiDailyBudget before any earlier effects.
 * This helper reserves the summary's single call and writes no mail content on denial.
 */
export const scheduleConversationSummary = async (
  params: Scope & {
    context: MailRequestContext;
    source: SummarySource;
    style?: SummaryRequest["style"];
    mode?: SummaryRequest["mode"];
  },
): Promise<Result<{ summaryState: ConversationContentSummary; skipped?: "edited_by_person" }>> => {
  const permission = await requireConversationCollaborationPermission(params.context, params.mailboxId, params.conversationId, "write");
  if (!permission.ok) return permission;
  try {
    const result = await sql.begin(async (db) => {
      const current = await lockScope(db, params);
      if (!current) return fail(err.notFound("Conversation"));
      const state = mapConversationSummary(current);
      if (state.source === "person") return ok({ summaryState: state, skipped: "edited_by_person" as const });
      const pending = await requestRow(db, params);
      if (pending?.status === "writing" || (pending?.status === "pending" && pending.request.source === null)) {
        if (!pending.request.source) {
          const request: SummaryRequest = {
            ...pending.request,
            followup: {
              context: params.context,
              source: params.source,
              style: params.style ?? "bullets",
              mode: params.mode ?? "rolling",
            },
          };
          await db`UPDATE mail.conversation_summary_requests SET request = ${request}::jsonb
            WHERE conversation_id = ${params.conversationId}::uuid`;
        }
        return ok({ summaryState: state });
      }
      const key =
        pending?.status === "pending" && pending.request.source?.id === params.source.id ? pending.request_id : crypto.randomUUID();
      const admission = await reserve(db, params, params.source, key);
      if (admission.status === "limited") {
        // Observational state only: neither summary nor conversation revision changes.
        if (!pending || !["pending", "writing"].includes(pending.status)) {
          const request: SummaryRequest = {
            context: params.context,
            source: params.source,
            style: params.style ?? "bullets",
            mode: params.mode ?? "rolling",
          };
          const limit = {
            scope: admission.scope,
            workflow: { id: params.source.id, name: params.source.name },
            limit: admission.limit,
            resetsAt: admission.resetsAt,
          };
          await db`INSERT INTO mail.conversation_summary_requests
            (conversation_id, mailbox_id, request_id, request, status, due_at, limit_info)
            VALUES (${params.conversationId}::uuid, ${params.mailboxId}::uuid, ${key}::uuid,
              ${request}::jsonb, 'limited', ${admission.resetsAt}::timestamptz, ${limit}::jsonb)
            ON CONFLICT (conversation_id) DO UPDATE SET request_id = EXCLUDED.request_id, request = EXCLUDED.request,
              status = 'limited', due_at = EXCLUDED.due_at, limit_info = EXCLUDED.limit_info, failure = NULL, basis = NULL,
              claim_id = NULL, claimed_at = NULL, updated_at = now()`;
          await activity(db, params, request, "limited", { limit });
        }
        const limited = await loadConversationSummary({ ...params, db });
        return limited ? ok({ summaryState: mapConversationSummary(limited) }) : fail(err.notFound("Conversation"));
      }
      if (pending && pending.request_id !== key) await release(db, pending);
      const request: SummaryRequest = {
        context: params.context,
        source: params.source,
        style: params.style ?? "bullets",
        mode: params.mode ?? "rolling",
      };
      await writePending(db, params, request, key, new Date(Date.now() + SUMMARY_QUIET_PERIOD_MS), "pending");
      const updated = await loadConversationSummary({ ...params, db });
      return updated ? ok({ summaryState: mapConversationSummary(updated) }) : fail(err.notFound("Conversation"));
    });
    mailLive.wake();
    if (result.ok && result.data.summaryState.status === "pending") await submitConversationSummary(params).catch(reportSubmissionFailure);
    return result;
  } catch (error) {
    log.error("Could not schedule a summary", { error });
    return fail(err.internal("Failed to schedule conversation summary"));
  }
};

const writePending = async (
  db: SqlClient,
  scope: Scope,
  request: SummaryRequest,
  key: string,
  due: Date,
  status: "pending" | "writing",
) => {
  await db`INSERT INTO mail.conversation_summary_requests
    (conversation_id, mailbox_id, request_id, request, status, due_at)
    VALUES (${scope.conversationId}::uuid, ${scope.mailboxId}::uuid, ${key}::uuid, ${request}::jsonb, ${status}, ${due})
    ON CONFLICT (conversation_id) DO UPDATE SET request_id = EXCLUDED.request_id, request = EXCLUDED.request,
      status = EXCLUDED.status, due_at = EXCLUDED.due_at, claim_id = NULL, claimed_at = NULL, attempts = 0,
      basis = NULL, failure = NULL, limit_info = NULL, updated_at = now()`;
  await activity(db, scope, request, status);
};

/** Person-requested AI uses the actor's Assistant allowance, independently of automation reservations. */
export const generateConversationSummary = async (
  params: Scope & {
    context: MailRequestContext;
    input: z.infer<typeof generateConversationSummarySchema>;
  },
): Promise<Result<{ summaryState: ConversationContentSummary }>> => {
  const permission = await requireConversationCollaborationPermission(params.context, params.mailboxId, params.conversationId, "write");
  if (!permission.ok) return permission;
  const person = userBackedActor(params.context);
  if (!person) return fail(err.forbidden("Only a person can request an AI summary"));
  try {
    // An in-flight request is returned even if the allowance is now used up.
    const current = await getConversationSummary(params);
    if (!current.ok) return current;
    if (current.data.status === "writing") return ok({ summaryState: current.data });
    const available = await getConversationSummaryAiAvailability({ type: "user", userId: person.id });
    if (
      available.allowance &&
      !available.allowance.unlimited &&
      (available.allowance.usedPercent === null || available.allowance.usedPercent >= 100)
    )
      return fail({
        code: "mail.summary.allowance_exhausted",
        message: "Your AI allowance is used up. Try again after it resets.",
        status: 403,
      });
    if (!available.canGenerate) return fail({ code: "mail.summary.unavailable", message: "AI summaries are unavailable.", status: 400 });
    const result = await sql.begin(async (db) => {
      const summary = await lockScope(db, params);
      if (!summary) return fail(err.notFound("Conversation"));
      const pending = await requestRow(db, params);
      if (pending?.status === "writing") return ok();
      if (Number(summary.summary_revision) !== params.input.expectedSummaryRevision)
        return fail(err.conflict("Conversation summary was changed by another collaborator"));
      if (pending) await release(db, pending);
      await writePending(
        db,
        params,
        {
          context: params.context,
          expectedSummaryRevision: params.input.expectedSummaryRevision,
          source: null,
          style: "bullets",
          mode: params.input.mode,
        },
        crypto.randomUUID(),
        new Date(),
        "writing",
      );
      return ok();
    });
    if (!result.ok) return result;
    mailLive.wake();
    await submitConversationSummary(params).catch(reportSubmissionFailure);
    const state = await getConversationSummary(params);
    return state.ok ? ok({ summaryState: state.data }) : state;
  } catch (error) {
    log.error("Could not request a summary", { error });
    return fail(err.internal("Failed to request conversation summary"));
  }
};

const reportSubmissionFailure = (error: unknown) => log.warn("Summary remains durable; recovery will submit it", { error });
const summaryJobs = lazySync((sync) =>
  sync.job<Scope>({ id: "mail:conversation-summary", delivery: { ackWaitMs: CLAIM_MS, maxAttempts: 3, backoffMs: [5_000, 20_000] } }),
);
const recovery = lazySync((sync) => sync.scheduler({ id: "mail:conversation-summary-recovery" }));
const tasks = createRuntimeTaskTracker();
let worker: Worker | undefined;
let recoveryWorker: Worker | undefined;

export const submitConversationSummary = async (scope: Scope): Promise<void> => {
  await (tasks.run(async () => {
    const row = await requestRow(sql, scope);
    if (!row || !["pending", "writing"].includes(row.status)) return;
    await summaryJobs().submit({
      key: `summary:${scope.conversationId}`,
      coalesce: true,
      input: scope,
      delayMs: Math.max(0, row.due_at.getTime() - Date.now()),
    });
  }) ?? Promise.resolve());
};

const summaryFailureCode = (error: unknown): ConversationSummaryFailureCode => {
  const code = error && typeof error === "object" && "code" in error ? String(error.code).toLowerCase() : "";
  if (code.includes("quota") || code.includes("allowance")) return "allowance_exhausted";
  if (code.includes("timeout") || code.includes("deadline")) return "timeout";
  if (code.includes("size") || code.includes("large")) return "input_too_large";
  if (code.includes("provider") || code.includes("unavailable") || code.includes("model") || code.includes("source_budget"))
    return "provider_unavailable";
  return "internal";
};

const assertRequestCredential = async (context: MailRequestContext, db: SqlClient = sql) => {
  if (context.actor.kind === "user") return;
  const snapshot = durableCredentialSnapshot(context);
  if (!snapshot) throw new Error("Summary request credential expired");
  if (!snapshot.credentialId) return; // Short-lived invocation; its stored expiry is checked above.
  const [credential] = await db<{ active: boolean }[]>`SELECT EXISTS (
    SELECT 1 FROM auth.service_account_credentials c
    WHERE c.id = ${snapshot.credentialId}::uuid AND c.service_account_id = ${context.actor.serviceAccount.id}::uuid
      AND c.status = 'active' AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > now())
      AND c.scopes @> ${toPgTextArray(snapshot.scopes)}::text[] AND c.scopes <@ ${toPgTextArray(snapshot.scopes)}::text[]
  ) AS active`;
  if (!credential?.active) throw new Error("Summary request credential is unavailable");
};

/** One durable worker turn. Inject inference for focused public-service integration tests. */
export const executeConversationSummary = async (
  scope: Scope,
  options: {
    signal?: AbortSignal;
    heartbeat?: () => Promise<void>;
    generate?: typeof generateConversationSummaryAi;
  } = {},
): Promise<{ status: string; delayMs?: number }> => {
  const claimId = crypto.randomUUID();
  const claimed = await sql.begin(async (db) => {
    const summary = await lockScope(db, scope);
    if (!summary) return null;
    const row = await requestRow(db, scope);
    if (!row || !["pending", "writing"].includes(row.status)) return null;
    const [claim] = await db<{ active: boolean }[]>`SELECT claimed_at > now() - (${CLAIM_MS}::int * interval '1 millisecond') AS active
      FROM mail.conversation_summary_requests WHERE conversation_id = ${scope.conversationId}::uuid`;
    if (row.claim_id && claim?.active) return null;
    if (row.due_at.getTime() > Date.now()) return { delayMs: row.due_at.getTime() - Date.now() };
    if (
      (row.request.source && mapConversationSummary(summary).source === "person") ||
      (row.request.expectedSummaryRevision !== undefined && Number(summary.summary_revision) !== row.request.expectedSummaryRevision)
    ) {
      await release(db, row);
      await db`UPDATE mail.conversation_summary_requests SET status = 'idle', claim_id = NULL, claimed_at = NULL
        WHERE conversation_id = ${scope.conversationId}::uuid`;
      await activity(db, scope, row.request, "idle", { skipped: "edited_by_person" });
      return null;
    }
    const basis: SummaryBasis = row.basis ?? {
      summaryRevision: Number(summary.summary_revision),
      conversationRevision: Number(summary.revision),
      throughMessageSeq: summary.last_message_seq,
      messageCount: summary.message_count,
      previousSummary: summary.summary,
    };
    await db`UPDATE mail.conversation_summary_requests SET status = 'writing', claim_id = ${claimId}::uuid,
      claimed_at = now(), attempts = attempts + 1, basis = ${basis}::jsonb
      WHERE conversation_id = ${scope.conversationId}::uuid`;
    await activity(db, scope, row.request, "writing");
    return { row, basis };
  });
  mailLive.wake();
  if (!claimed) return { status: "idle" };
  if ("delayMs" in claimed) return { status: "pending", delayMs: claimed.delayMs };
  const { row, basis } = claimed;
  let inferenceCompleted = false;
  try {
    const context = row.request.context;
    await assertRequestCredential(context);
    unwrap(await requireConversationCollaborationPermission(context, scope.mailboxId, scope.conversationId, "write"));
    const person = userBackedActor(context);
    const output = await withLeaseHeartbeat({
      intervalMs: 30_000,
      heartbeat: async () => {
        if (options.signal?.aborted) throw options.signal.reason;
        await options.heartbeat?.();
        const renewed = await sql`UPDATE mail.conversation_summary_requests SET claimed_at = now()
          WHERE conversation_id = ${scope.conversationId}::uuid AND claim_id = ${claimId}::uuid RETURNING conversation_id`;
        if (!renewed.length) throw new Error("Summary worker lost its claim");
      },
      work: async (_assertLease, signal) =>
        (options.generate ?? generateConversationSummaryAi)({
          ...scope,
          style: row.request.style,
          mode: row.request.mode,
          previousSummary: basis.previousSummary,
          effectKey: row.request_id,
          sourceRevision: String(basis.conversationRevision),
          throughMessageSeq: basis.throughMessageSeq,
          ...(!row.request.source && person ? { usageSubject: { type: "user" as const, userId: person.id } } : {}),
          signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal,
        }),
    });
    inferenceCompleted = true;
    options.signal?.throwIfAborted();
    const settled = await sql.begin(async (db) => {
      const current = await lockScope(db, scope);
      const active = await requestRow(db, scope);
      if (!current || active?.claim_id !== claimId) return "idle";
      await assertRequestCredential(row.request.context, db);
      unwrap(await requireConversationCollaborationPermission(row.request.context, scope.mailboxId, scope.conversationId, "write", db));
      if (row.request.source)
        unwrap(
          await consumeAiDailyBudget({
            db,
            mailboxId: scope.mailboxId,
            sourceId: row.request.source.id,
            reservationKey: row.request_id,
            actualCalls: 1,
          }),
        );
      const unchanged = Number(current.summary_revision) === basis.summaryRevision;
      if (unchanged) {
        const author = row.request.source
          ? { kind: "workflow" as const, id: row.request.source.id, name: row.request.source.name }
          : person
            ? { kind: "user" as const, id: person.id, name: person.displayName }
            : null;
        const metadata: SummaryMetadata = {
          source: row.request.source ? "workflow" : "manual_ai",
          author,
          ai: true,
          generatedAt: new Date().toISOString(),
          coveredMessageCount: output.coveredMessageCount,
          coveredThrough: basis.throughMessageSeq,
          truncated: output.truncated,
          nextStep: output.nextStep,
        };
        await db`UPDATE mail.conversations SET summary = ${output.summary}, summary_revision = summary_revision + 1,
          revision = revision + 1, summary_metadata = ${metadata}::jsonb
          WHERE id = ${scope.conversationId}::uuid AND mailbox_id = ${scope.mailboxId}::uuid`;
      }
      await db`UPDATE mail.conversation_summary_requests SET status = 'idle', failure = NULL, limit_info = NULL,
        claim_id = NULL, claimed_at = NULL, updated_at = now() WHERE conversation_id = ${scope.conversationId}::uuid`;
      await activity(db, scope, row.request, "idle", { applied: unchanged, ...(!unchanged ? { skipped: "edited_by_person" } : {}) });
      let followup: SummaryRequest["followup"] = undefined;
      // A trigger during manual work may request an automatic follow-up, never another personal call.
      if (unchanged && current.last_message_seq !== basis.throughMessageSeq) {
        followup = row.request.source
          ? {
              context: row.request.context,
              source: row.request.source,
              mode: row.request.mode,
              style: row.request.style,
            }
          : active.request.followup;
      }
      if (!followup) return "idle";
      // Commit new work with the result so a crash cannot lose the latest replies.
      const request: SummaryRequest = { ...followup };
      const key = crypto.randomUUID();
      const admission = await reserve(db, scope, followup.source, key);
      if (admission.status === "limited") {
        const limit = {
          scope: admission.scope,
          workflow: { id: followup.source.id, name: followup.source.name },
          limit: admission.limit,
          resetsAt: admission.resetsAt,
        };
        await db`UPDATE mail.conversation_summary_requests SET request_id = ${key}::uuid, request = ${request}::jsonb,
          status = 'limited', due_at = ${admission.resetsAt}::timestamptz, limit_info = ${limit}::jsonb,
          basis = NULL, attempts = 0 WHERE conversation_id = ${scope.conversationId}::uuid`;
        await activity(db, scope, request, "limited", { limit });
        return "limited";
      }
      await writePending(db, scope, request, key, new Date(Date.now() + SUMMARY_QUIET_PERIOD_MS), "pending");
      return "followup";
    });
    mailLive.wake();
    if (settled === "followup") await submitConversationSummary(scope).catch(reportSubmissionFailure);
    return { status: settled };
  } catch (error) {
    if (options.signal?.aborted) {
      // Worker shutdown is recovery, not a failed inference. Keep its reservation and stable task key.
      await sql.begin(async (db) => {
        await lockScope(db, scope);
        const active = await requestRow(db, scope);
        if (active?.claim_id !== claimId) return;
        await db`UPDATE mail.conversation_summary_requests SET status = 'writing', claim_id = NULL,
          claimed_at = NULL, due_at = now(), updated_at = now() WHERE conversation_id = ${scope.conversationId}::uuid`;
        await activity(db, scope, row.request, "writing", { recovery: "worker_stopped" });
      });
      mailLive.wake();
      return { status: "writing" };
    }
    await sql.begin(async (db) => {
      await lockScope(db, scope);
      const active = await requestRow(db, scope);
      if (!active || active.claim_id !== claimId) return;
      if (inferenceCompleted && row.request.source)
        unwrap(
          await consumeAiDailyBudget({
            db,
            mailboxId: scope.mailboxId,
            sourceId: row.request.source.id,
            reservationKey: row.request_id,
            actualCalls: 1,
          }),
        );
      else await release(db, active);
      const failure: NonNullable<ConversationContentSummary["failure"]> = {
        code: summaryFailureCode(error),
        attempts: active.attempts,
        lastAttemptAt: new Date().toISOString(),
        workflow: row.request.source ? { id: row.request.source.id, name: row.request.source.name } : null,
      };
      await db`UPDATE mail.conversation_summary_requests SET status = 'failed', failure = ${failure}::jsonb,
        claim_id = NULL, claimed_at = NULL, updated_at = now() WHERE conversation_id = ${scope.conversationId}::uuid`;
      await activity(db, scope, row.request, "failed", { failure });
    });
    mailLive.wake();
    return { status: "failed" };
  }
};

export const recoverConversationSummaries = async (): Promise<number> => {
  const due = await sql<{ mailbox_id: string; conversation_id: string }[]>`SELECT mailbox_id, conversation_id
    FROM mail.conversation_summary_requests WHERE status IN ('pending','writing') AND due_at <= now()
      AND (claim_id IS NULL OR claimed_at < now() - (${CLAIM_MS}::int * interval '1 millisecond'))
    ORDER BY due_at, conversation_id LIMIT 500`;
  for (const row of due) await submitConversationSummary({ mailboxId: row.mailbox_id, conversationId: row.conversation_id });
  return due.length;
};

export const runConversationSummaryJob = async (ctx: Pick<JobContext<Scope>, "input" | "signal" | "heartbeat" | "resubmit">) => {
  const result = await executeConversationSummary(ctx.input, { signal: ctx.signal, heartbeat: () => ctx.heartbeat() });
  if (result.delayMs !== undefined) ctx.resubmit({ delayMs: result.delayMs });
};

const lifecycle = createRuntimeLifecycle({
  start: async () => {
    tasks.open();
    worker = await summaryJobs().process({}, runConversationSummaryJob);
    recoveryWorker = await recovery().process();
    await recovery().create({
      id: "mail:conversation-summary-recovery",
      cron: "* * * * *",
      misfire: "latest",
      meta: { appId: "mail", label: "Mail summary recovery" },
      process: async () => {
        await recoverConversationSummaries();
      },
    });
    await recoverConversationSummaries();
  },
  stop: async () => {
    await stopRuntimeJobs(
      tasks,
      [worker, recoveryWorker].filter((item): item is Worker => item !== undefined),
    );
    worker = undefined;
    recoveryWorker = undefined;
  },
});
export const startConversationSummaryRuntime = lifecycle.start;
export const stopConversationSummaryRuntime = lifecycle.stop;
