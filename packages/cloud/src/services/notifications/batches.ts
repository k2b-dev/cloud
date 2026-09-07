import { createHash } from "node:crypto";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { Worker } from "@k2b/sync";
import { sql } from "bun";
import { lazySync } from "../../_internal/process-sync";
import { markdown } from "../../shared/markdown";
import { logger, trace } from "../logging";
import { parsePgJsonValue, toPgTextArray, toPgUuidArray } from "../postgres";
import { syncOps } from "../sync-ops";
import { sendEmail } from "./email";

const log = logger("notifications:batches");
const CHUNK_SIZE = 100;
const MAX_PAGE = 10_000;
const MAX_PER_PAGE = 100;

export type NotificationBatchStatus = "draft" | "ready" | "running" | "completed" | "completed_with_errors" | "failed" | "cancelled";
export type NotificationBatchRecipientStatus = "pending" | "sending" | "sent" | "skipped" | "error";

export type NotificationBatchSelection = {
  userIds?: string[];
  groupIds?: string[];
};

export type NotificationBatchPreview = {
  targetCount: number;
  deliverableCount: number;
  skippedNoEmailCount: number;
  duplicateCount: number;
  recipientHash: string;
};

export type NotificationBatch = {
  id: string;
  subject: string;
  bodyMarkdown: string;
  bodyHtml: string;
  selection: NotificationBatchSelection;
  selectionHash: string;
  status: NotificationBatchStatus;
  createdBy: string | null;
  finalizedBy: string | null;
  createdAt: string;
  finalizedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  targetCount: number;
  deliverableCount: number;
  sentCount: number;
  skippedCount: number;
  errorCount: number;
  lastError: string | null;
};

export type NotificationBatchRecipient = {
  batchId: string;
  userId: string;
  recipient: string | null;
  uid: string;
  displayName: string;
  avatarHash: string | null;
  provider: "local" | "ipa";
  profile: "user" | "guest";
  status: NotificationBatchRecipientStatus;
  notificationId: string | null;
  error: string | null;
  attemptCount: number;
  sentAt: string | null;
  updatedAt: string;
};

type RecipientCandidate = {
  id: string;
  uid: string;
  display_name: string;
  mail: string | null;
  provider: "local" | "ipa";
  profile: "user" | "guest";
  source_hits: number;
};

type BatchRow = Record<string, unknown>;

const normalizeIds = (values: string[] | null | undefined): string[] => [...new Set((values ?? []).filter(Boolean))].sort();

const normalizeSelection = (selection: NotificationBatchSelection): NotificationBatchSelection => ({
  userIds: normalizeIds(selection.userIds),
  groupIds: normalizeIds(selection.groupIds),
});

const hasAudience = (selection: NotificationBatchSelection): boolean =>
  (selection.userIds?.length ?? 0) > 0 || (selection.groupIds?.length ?? 0) > 0;

const hasLegacyAudienceSelection = (selection: NotificationBatchSelection): boolean => {
  const raw = selection as NotificationBatchSelection & Record<string, unknown>;
  const mode = typeof raw.mode === "string" ? raw.mode : undefined;
  const rules = Array.isArray(raw.rules) ? raw.rules : [];
  const accountManagers = raw.accountManagers as { mode?: string; groupIds?: unknown } | undefined;
  const managerMode = accountManagers && typeof accountManagers.mode === "string" ? accountManagers.mode : undefined;
  const managerGroupIds = Array.isArray(accountManagers?.groupIds) ? accountManagers.groupIds : [];
  const providers = Array.isArray(raw.providers) ? raw.providers : [];
  const profiles = Array.isArray(raw.profiles) ? raw.profiles : [];
  return (
    (mode !== undefined && mode !== "specific") ||
    rules.length > 0 ||
    raw.all === true ||
    raw.includeGroupMembers === false ||
    (managerMode !== undefined && managerMode !== "none") ||
    managerGroupIds.length > 0 ||
    providers.length > 0 ||
    profiles.length > 0
  );
};

const selectionHash = (selection: NotificationBatchSelection): string =>
  createHash("sha256")
    .update(JSON.stringify(normalizeSelection(selection)))
    .digest("hex");

const recipientHash = (candidates: RecipientCandidate[]): string =>
  createHash("sha256")
    .update(
      JSON.stringify(
        candidates
          .filter((candidate) => candidate.mail)
          .map((candidate) => candidate.id)
          .sort(),
      ),
    )
    .digest("hex");

const mapBatch = (row: BatchRow): NotificationBatch => ({
  id: row.id as string,
  subject: row.subject as string,
  bodyMarkdown: row.body_markdown as string,
  bodyHtml: row.body_html as string,
  selection: (parsePgJsonValue(row.selection) ?? {}) as NotificationBatchSelection,
  selectionHash: row.selection_hash as string,
  status: row.status as NotificationBatchStatus,
  createdBy: row.created_by as string | null,
  finalizedBy: row.finalized_by as string | null,
  createdAt: (row.created_at as Date).toISOString(),
  finalizedAt: row.finalized_at ? (row.finalized_at as Date).toISOString() : null,
  startedAt: row.started_at ? (row.started_at as Date).toISOString() : null,
  completedAt: row.completed_at ? (row.completed_at as Date).toISOString() : null,
  targetCount: Number(row.target_count ?? 0),
  deliverableCount: Number(row.deliverable_count ?? 0),
  sentCount: Number(row.sent_count ?? 0),
  skippedCount: Number(row.skipped_count ?? 0),
  errorCount: Number(row.error_count ?? 0),
  lastError: row.last_error as string | null,
});

const mapRecipient = (row: BatchRow): NotificationBatchRecipient => ({
  batchId: row.batch_id as string,
  userId: row.user_id as string,
  recipient: row.recipient as string | null,
  uid: row.uid as string,
  displayName: row.display_name as string,
  avatarHash: (row.avatar_hash as string | null | undefined) ?? null,
  provider: row.provider as "local" | "ipa",
  profile: row.profile as "user" | "guest",
  status: row.status as NotificationBatchRecipientStatus,
  notificationId: row.notification_id as string | null,
  error: row.error as string | null,
  attemptCount: Number(row.attempt_count ?? 0),
  sentAt: row.sent_at ? (row.sent_at as Date).toISOString() : null,
  updatedAt: (row.updated_at as Date).toISOString(),
});

const resolveCandidates = async (rawSelection: NotificationBatchSelection): Promise<RecipientCandidate[]> => {
  const selection = normalizeSelection(rawSelection);
  const userIds = selection.userIds ?? [];
  const groupIds = selection.groupIds ?? [];

  if (userIds.length === 0 && groupIds.length === 0) return [];

  return await sql<RecipientCandidate[]>`
    WITH RECURSIVE
      selected_users(user_id) AS (
        SELECT unnest(${toPgUuidArray(userIds)}::uuid[])
      ),
      selected_groups(group_id) AS (
        SELECT unnest(${toPgUuidArray(groupIds)}::uuid[])
      ),
      group_tree(group_id) AS (
        SELECT group_id FROM selected_groups
        UNION
        SELECT gg.child_group_id
        FROM auth.group_groups_v2 gg
        JOIN group_tree tree ON tree.group_id = gg.parent_group_id
      ),
      candidates(user_id) AS (
        SELECT user_id FROM selected_users
        UNION ALL
        SELECT ug.user_id
        FROM auth.user_groups_v2 ug
        JOIN group_tree tree ON tree.group_id = ug.group_id
      ),
      candidate_counts AS (
        SELECT user_id, COUNT(*)::int AS source_hits
        FROM candidates
        GROUP BY user_id
      )
    SELECT u.id, u.uid, u.display_name, u.mail, u.provider, u.profile, c.source_hits
    FROM candidate_counts c
    JOIN auth.users u ON u.id = c.user_id
    ORDER BY u.uid
  `;
};

const sendBatchEmail = async (params: {
  recipient: string;
  subject: string;
  rawHtml: string;
  sentBy?: string;
}): Promise<{ id: string; status: "sent" | "error"; error?: string }> => {
  const rows = await sql<BatchRow[]>`
    INSERT INTO notifications.messages (type, recipient, subject, content, sent_by)
    VALUES ('email', ${params.recipient}, ${params.subject}, ${params.rawHtml}, ${params.sentBy ?? null})
    RETURNING id
  `;
  const id = rows[0]!.id as string;
  try {
    await sendEmail(params.recipient, params.subject, { rawHtml: params.rawHtml });
    await sql`UPDATE notifications.messages SET sent_at = now(), error = NULL WHERE id = ${id}::uuid`;
    return { id, status: "sent" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql`UPDATE notifications.messages SET error = ${message} WHERE id = ${id}::uuid`;
    return { id, status: "error", error: message };
  }
};

export const preview = async (selection: NotificationBatchSelection): Promise<NotificationBatchPreview> => {
  const candidates = await resolveCandidates(selection);
  return {
    targetCount: candidates.length,
    deliverableCount: candidates.filter((candidate) => candidate.mail).length,
    skippedNoEmailCount: candidates.filter((candidate) => !candidate.mail).length,
    duplicateCount: candidates.reduce((sum, candidate) => sum + Math.max(0, Number(candidate.source_hits ?? 1) - 1), 0),
    recipientHash: recipientHash(candidates),
  };
};

const refreshBatchCounters = async (batchId: string): Promise<NotificationBatch | null> => {
  const rows = await sql<BatchRow[]>`
    WITH counts AS (
      SELECT
        COUNT(*)::int AS target_count,
        COUNT(*) FILTER (WHERE r.recipient IS NOT NULL)::int AS deliverable_count,
        COUNT(*) FILTER (WHERE r.status = 'sent')::int AS sent_count,
        COUNT(*) FILTER (WHERE r.status = 'skipped')::int AS skipped_count,
        COUNT(*) FILTER (WHERE r.status = 'error')::int AS error_count,
        COUNT(*) FILTER (WHERE r.status IN ('pending', 'sending'))::int AS pending_count,
        MAX(COALESCE(m.error, r.error)) FILTER (WHERE r.status = 'error') AS last_error
      FROM notifications.batch_recipients r
      LEFT JOIN notifications.messages m ON m.id = r.notification_id
      WHERE r.batch_id = ${batchId}::uuid
    )
    UPDATE notifications.batches b
    SET
      target_count = counts.target_count,
      deliverable_count = counts.deliverable_count,
      sent_count = counts.sent_count,
      skipped_count = counts.skipped_count,
      error_count = counts.error_count,
      last_error = counts.last_error,
      status = CASE
        WHEN b.status IN ('draft', 'ready', 'cancelled') THEN b.status
        WHEN counts.pending_count > 0 THEN 'running'
        WHEN counts.error_count > 0 THEN 'completed_with_errors'
        ELSE 'completed'
      END,
      completed_at = CASE
        WHEN b.status IN ('draft', 'ready', 'cancelled') THEN b.completed_at
        WHEN counts.pending_count = 0 AND b.completed_at IS NULL THEN now()
        ELSE b.completed_at
      END
    FROM counts
    WHERE b.id = ${batchId}::uuid
    RETURNING b.*
  `;
  return rows[0] ? mapBatch(rows[0]) : null;
};

const processBatchChunk = async (batchId: string): Promise<{ processed: number; remaining: number }> => {
  await sql`
    UPDATE notifications.batches
    SET status = 'running', started_at = COALESCE(started_at, now())
    WHERE id = ${batchId}::uuid AND status IN ('ready', 'running')
  `;

  const recipients = await sql<BatchRow[]>`
    UPDATE notifications.batch_recipients r
    SET status = 'sending', attempt_count = attempt_count + 1, updated_at = now()
    WHERE (r.batch_id, r.user_id) IN (
      SELECT batch_id, user_id
      FROM notifications.batch_recipients
      WHERE batch_id = ${batchId}::uuid
        AND recipient IS NOT NULL
        AND (
          status = 'pending'
          OR (status = 'sending' AND updated_at < now() - interval '5 minutes')
        )
      ORDER BY updated_at ASC
      LIMIT ${CHUNK_SIZE}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING r.*
  `;

  const [batchRow] = await sql<BatchRow[]>`SELECT * FROM notifications.batches WHERE id = ${batchId}::uuid`;
  if (!batchRow || batchRow.status === "cancelled") return { processed: 0, remaining: 0 };
  const batch = mapBatch(batchRow);

  for (const recipient of recipients) {
    try {
      const result = await sendBatchEmail({
        recipient: recipient.recipient as string,
        subject: batch.subject,
        rawHtml: batch.bodyHtml,
        sentBy: batch.finalizedBy ?? batch.createdBy ?? undefined,
      });
      await sql`
        UPDATE notifications.batch_recipients
        SET
          status = ${result.status === "sent" ? "sent" : "error"},
          notification_id = ${result.id}::uuid,
          error = NULL,
          sent_at = ${result.status === "sent" ? sql`now()` : null},
          updated_at = now()
        WHERE batch_id = ${batchId}::uuid AND user_id = ${recipient.user_id}::uuid
      `;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("Batch recipient send failed", { batchId, userId: recipient.user_id, error: message });
      await sql`
        UPDATE notifications.batch_recipients
        SET status = 'error', error = ${message}, updated_at = now()
        WHERE batch_id = ${batchId}::uuid AND user_id = ${recipient.user_id}::uuid
      `;
    }
  }

  const [pendingRow] = await sql<BatchRow[]>`
    SELECT COUNT(*)::int AS count
    FROM notifications.batch_recipients
    WHERE batch_id = ${batchId}::uuid
      AND recipient IS NOT NULL
      AND status IN ('pending', 'sending')
  `;
  const remaining = Number(pendingRow?.count ?? 0);
  await refreshBatchCounters(batchId);
  return { processed: recipients.length, remaining };
};

const batchJob = lazySync((sync) => {
  const handle = sync.job<{ batchId: string }>({
    id: "notifications:batches",
    owner: "core",
    delivery: { ackWaitMs: 180_000, maxAttempts: 4, backoffMs: [1_000, 2_000, 4_000] },
  });
  syncOps.registerDeadLetters({ name: "notifications:batches", kind: "job", store: handle.deadLetters });
  return handle;
});
let batchWorker: Worker | undefined;
const startBatchWorker = () =>
  batchJob().process(
    {
      onError: async ({ context, error }) => {
        if (context.attempt < 4) return { action: "retry" };
        const message = error instanceof Error ? error.message : String(error);
        log.error("Notification batch job failed", { batchId: context.input.batchId, attempt: context.attempt, error: message });
        await sql`
      UPDATE notifications.batches
      SET status = 'failed', completed_at = now(), last_error = ${message}
      WHERE id = ${context.input.batchId}::uuid AND status IN ('ready', 'running')
    `;
        return { action: "dead_letter", reason: message };
      },
    },
    async (ctx) => {
      if (ctx.signal.aborted) return;
      const result = await trace.withSpan(
        {
          name: "Notification batch delivery",
          source: "notifications:batches",
          appId: "core",
          category: "job",
          kind: "consumer",
          attributes: { "cloud.notification.batch_id": ctx.input.batchId },
        },
        () => processBatchChunk(ctx.input.batchId),
        { summarize: (summary) => summary },
      );
      await ctx.heartbeat();
      if (result.remaining > 0) await ctx.resubmit({ delayMs: result.processed > 0 ? 0 : 60_000 });
    },
  );
const submitBatch = async (batchId: string): Promise<string> =>
  (await batchJob().submit({ key: batchId, input: { batchId }, coalesce: true })).jobId;

export const createDraft = async (params: {
  subject: string;
  bodyMarkdown: string;
  selection: NotificationBatchSelection;
  createdBy: string;
}): Promise<Result<NotificationBatch>> => {
  const subject = params.subject.trim();
  const bodyMarkdown = params.bodyMarkdown.trim();
  if (!subject) return fail(err.badInput("Subject is required"));
  if (!bodyMarkdown) return fail(err.badInput("Message is required"));
  const selection = normalizeSelection(params.selection);
  if (!hasAudience(selection)) {
    return fail(err.badInput("Select at least one user or group."));
  }
  const candidates = await resolveCandidates(selection);
  if (!candidates.some((candidate) => candidate.mail)) {
    return fail(err.badInput("No deliverable recipients match this selection"));
  }
  const hash = selectionHash(selection);
  const bodyHtml = markdown.renderSync(bodyMarkdown);
  const rows = await sql<BatchRow[]>`
    INSERT INTO notifications.batches (subject, body_markdown, body_html, selection, selection_hash, created_by)
    VALUES (${subject}, ${bodyMarkdown}, ${bodyHtml}, ${JSON.stringify(selection)}::jsonb, ${hash}, ${params.createdBy}::uuid)
    RETURNING *
  `;
  return ok(mapBatch(rows[0]!));
};

export const get = async (id: string): Promise<NotificationBatch | null> => {
  const rows = await sql<BatchRow[]>`SELECT * FROM notifications.batches WHERE id = ${id}::uuid`;
  return rows[0] ? mapBatch(rows[0]) : null;
};

export const list = async (params?: {
  page?: number;
  perPage?: number;
  status?: NotificationBatchStatus;
}): Promise<{ items: NotificationBatch[]; total: number; page: number; perPage: number }> => {
  const page = Math.min(Math.max(params?.page ?? 1, 1), MAX_PAGE);
  const perPage = Math.min(Math.max(params?.perPage ?? 50, 1), MAX_PER_PAGE);
  const offset = (page - 1) * perPage;
  const rows = await sql<BatchRow[]>`
    SELECT *, COUNT(*) OVER() AS total
    FROM notifications.batches
    WHERE (${params?.status ?? null}::text IS NULL OR status = ${params?.status ?? null})
    ORDER BY created_at DESC
    LIMIT ${perPage} OFFSET ${offset}
  `;
  return {
    items: rows.map(mapBatch),
    total: Number(rows[0]?.total ?? 0),
    page,
    perPage,
  };
};

export const listRecipients = async (params: {
  batchId: string;
  page?: number;
  perPage?: number;
  status?: NotificationBatchRecipientStatus;
}): Promise<{ items: NotificationBatchRecipient[]; total: number; page: number; perPage: number }> => {
  const page = Math.min(Math.max(params.page ?? 1, 1), MAX_PAGE);
  const perPage = Math.min(Math.max(params.perPage ?? 100, 1), MAX_PER_PAGE);
  const offset = (page - 1) * perPage;
  const rows = await sql<BatchRow[]>`
    SELECT
      r.batch_id,
      r.user_id,
      r.recipient,
      r.uid,
      r.display_name,
      u.avatar_hash,
      r.provider,
      r.profile,
      r.status,
      r.notification_id,
      COALESCE(m.error, r.error) AS error,
      r.attempt_count,
      r.sent_at,
      r.updated_at,
      COUNT(*) OVER() AS total
    FROM notifications.batch_recipients r
    LEFT JOIN notifications.messages m ON m.id = r.notification_id
    LEFT JOIN auth.users u ON u.id = r.user_id
    WHERE r.batch_id = ${params.batchId}::uuid
      AND (${params.status ?? null}::text IS NULL OR r.status = ${params.status ?? null})
    ORDER BY
      CASE r.status WHEN 'error' THEN 0 WHEN 'pending' THEN 1 WHEN 'sending' THEN 2 WHEN 'skipped' THEN 3 ELSE 4 END,
      r.uid
    LIMIT ${perPage} OFFSET ${offset}
  `;
  return {
    items: rows.map(mapRecipient),
    total: Number(rows[0]?.total ?? 0),
    page,
    perPage,
  };
};

export const finalize = async (params: {
  id: string;
  actorUserId: string;
  expectedSelectionHash: string;
  expectedDeliverableCount: number;
  expectedRecipientHash: string;
}): Promise<Result<{ batch: NotificationBatch; jobId: string }>> => {
  const batch = await get(params.id);
  if (!batch) return fail(err.notFound("Notification batch not found"));
  if (hasLegacyAudienceSelection(batch.selection)) {
    return fail(err.badInput("Legacy notification drafts cannot be finalized. Create a new notification batch."));
  }

  const candidates = await resolveCandidates(batch.selection);
  const deliverableCount = candidates.filter((candidate) => candidate.mail).length;
  const currentRecipientHash = recipientHash(candidates);
  if (deliverableCount === 0) {
    return fail(err.badInput("No deliverable recipients match this batch"));
  }
  const result = await sql.begin(async (tx): Promise<Result<NotificationBatch>> => {
    const rows = await tx<BatchRow[]>`
      SELECT * FROM notifications.batches WHERE id = ${params.id}::uuid FOR UPDATE
    `;
    const batchRow = rows[0];
    if (!batchRow) return fail(err.notFound("Notification batch not found"));
    if (batchRow.status !== "draft") return fail(err.conflict("Notification batch has already been finalized"));
    if (batchRow.selection_hash !== params.expectedSelectionHash)
      return fail(err.conflict("Notification selection changed. Refresh the preview."));
    if (deliverableCount !== params.expectedDeliverableCount) {
      return fail(err.conflict("Recipient count changed. Refresh the preview before sending."));
    }
    if (currentRecipientHash !== params.expectedRecipientHash) {
      return fail(err.conflict("Recipient list changed. Refresh the preview before sending."));
    }

    await tx`
      INSERT INTO notifications.batch_recipients (
        batch_id, user_id, recipient, uid, display_name, provider, profile, status, error
      )
      SELECT
        ${params.id}::uuid,
        row.user_id,
        NULLIF(row.recipient, ''),
        row.uid,
        row.display_name,
        row.provider,
        row.profile,
        row.status,
        NULLIF(row.error, '')
      FROM unnest(
        ${toPgUuidArray(candidates.map((candidate) => candidate.id))}::uuid[],
        ${toPgTextArray(candidates.map((candidate) => candidate.mail ?? ""))}::text[],
        ${toPgTextArray(candidates.map((candidate) => candidate.uid))}::text[],
        ${toPgTextArray(candidates.map((candidate) => candidate.display_name ?? ""))}::text[],
        ${toPgTextArray(candidates.map((candidate) => candidate.provider))}::text[],
        ${toPgTextArray(candidates.map((candidate) => candidate.profile))}::text[],
        ${toPgTextArray(candidates.map((candidate) => (candidate.mail ? "pending" : "skipped")))}::text[],
        ${toPgTextArray(candidates.map((candidate) => (candidate.mail ? "" : "User has no email address")))}::text[]
      ) AS row(user_id, recipient, uid, display_name, provider, profile, status, error)
      ON CONFLICT (batch_id, user_id) DO NOTHING
    `;

    const updated = await tx<BatchRow[]>`
      UPDATE notifications.batches
      SET
        status = 'ready',
        finalized_by = ${params.actorUserId}::uuid,
        finalized_at = now(),
        target_count = ${candidates.length},
        deliverable_count = ${deliverableCount},
        skipped_count = ${candidates.length - deliverableCount}
      WHERE id = ${params.id}::uuid
      RETURNING *
    `;
    return ok(mapBatch(updated[0]!));
  });

  if (!result.ok) return result;
  const jobId = await submitBatch(params.id);
  return ok({ batch: result.data, jobId });
};

export const retryFailed = async (params: { id: string }): Promise<Result<{ batch: NotificationBatch; jobId: string }>> => {
  const batch = await get(params.id);
  if (!batch) return fail(err.notFound("Notification batch not found"));
  if (batch.status === "draft" || batch.status === "cancelled") {
    return fail(err.conflict("Only finalized notification batches can retry recipients"));
  }

  const updated = await sql<BatchRow[]>`
    UPDATE notifications.batch_recipients
    SET status = 'pending', error = NULL, notification_id = NULL, sent_at = NULL, updated_at = now()
    WHERE batch_id = ${params.id}::uuid AND status = 'error' AND recipient IS NOT NULL
    RETURNING user_id
  `;
  if (updated.length === 0) {
    return fail(err.conflict("No failed deliverable recipients can be retried"));
  }

  await sql`
    UPDATE notifications.batches
    SET status = 'ready', completed_at = NULL, last_error = NULL
    WHERE id = ${params.id}::uuid AND status IN ('completed_with_errors', 'failed', 'running', 'ready', 'completed')
  `;
  const refreshed = await refreshBatchCounters(params.id);
  // A completing worker may already have sampled zero remaining recipients.
  // Explicit retries need their own wakeup even while that worker holds its key.
  const { jobId } = await batchJob().submit({ key: `${params.id}:retry:${crypto.randomUUID()}`, input: { batchId: params.id } });
  return ok({ batch: refreshed ?? batch, jobId });
};

export const retryRecipient = async (params: {
  id: string;
  userId: string;
}): Promise<Result<{ batch: NotificationBatch; jobId: string }>> => {
  const batch = await get(params.id);
  if (!batch) return fail(err.notFound("Notification batch not found"));
  if (batch.status === "draft" || batch.status === "cancelled") {
    return fail(err.conflict("Only finalized notification batches can retry recipients"));
  }

  const updated = await sql<BatchRow[]>`
    UPDATE notifications.batch_recipients
    SET status = 'pending', error = NULL, notification_id = NULL, sent_at = NULL, updated_at = now()
    WHERE batch_id = ${params.id}::uuid
      AND user_id = ${params.userId}::uuid
      AND status = 'error'
      AND recipient IS NOT NULL
    RETURNING *
  `;
  if (!updated[0]) {
    const existing = await sql<BatchRow[]>`
      SELECT status, recipient
      FROM notifications.batch_recipients
      WHERE batch_id = ${params.id}::uuid AND user_id = ${params.userId}::uuid
    `;
    if (!existing[0]) return fail(err.notFound("Notification recipient not found"));
    return fail(err.conflict("Only failed deliverable recipients can be retried"));
  }

  await sql`
    UPDATE notifications.batches
    SET status = 'ready', completed_at = NULL, last_error = NULL
    WHERE id = ${params.id}::uuid AND status IN ('completed_with_errors', 'failed', 'running', 'ready', 'completed')
  `;
  const refreshed = await refreshBatchCounters(params.id);
  const { jobId } = await batchJob().submit({
    key: `${params.id}:retry:${crypto.randomUUID()}`,
    input: { batchId: params.id },
  });
  return ok({ batch: refreshed ?? batch, jobId });
};

export const removeDraft = async (params: { id: string }): Promise<Result<{ id: string }>> => {
  const rows = await sql<BatchRow[]>`
    DELETE FROM notifications.batches
    WHERE id = ${params.id}::uuid AND status = 'draft'
    RETURNING id
  `;
  if (rows[0]) return ok({ id: rows[0].id as string });

  const batch = await get(params.id);
  if (!batch) return fail(err.notFound("Notification batch not found"));
  return fail(err.conflict("Only draft notification batches can be deleted"));
};

export const start = async (): Promise<void> => {
  if (batchWorker) return;
  batchWorker = await startBatchWorker();
  try {
    // Postgres owns the batch state; recover unfinished work across cutover and
    // restarts with keyset pages rather than an unbounded startup scan.
    let after: string | null = null;
    while (true) {
      const pending: { id: string }[] = await sql`
        SELECT id FROM notifications.batches
        WHERE status IN ('ready', 'running') AND (${after}::uuid IS NULL OR id > ${after}::uuid)
        ORDER BY id LIMIT ${CHUNK_SIZE}
      `;
      for (const batch of pending) await submitBatch(batch.id);
      if (pending.length < CHUNK_SIZE) break;
      after = pending[pending.length - 1]!.id;
    }
  } catch (error) {
    batchWorker.stop();
    await batchWorker.drain();
    batchWorker = undefined;
    throw error;
  }
};

export const stop = async (): Promise<void> => {
  batchWorker?.stop();
  await batchWorker?.drain();
  batchWorker = undefined;
};

export const notificationBatches = {
  createDraft,
  preview,
  get,
  list,
  listRecipients,
  finalize,
  retryFailed,
  retryRecipient,
  removeDraft,
  start,
  stop,
};

export const __notificationBatchTest = {
  normalizeSelection,
  hasLegacyAudienceSelection,
  selectionHash,
  recipientHash,
  resolveCandidates,
};
