import { sql } from "bun";
import type { ZodType } from "zod";
import type { BoundNotificationDefinition, NotificationRecipientKind, NotificationSendInput } from "../../contracts/notification-types";
import type { PaginationParams } from "../../contracts/shared";
import { logger } from "../logging";
import { escapeLikePattern } from "../postgres";
import { sendEmail } from "./email";
import "./browser";
import { notificationLive } from "./live";
import { notificationObservability } from "./observability";
import { sendTypedNotification, type TypedNotificationSendResult } from "./platform";
import { userNotifications } from "./user";

const log = logger("notifications");

export type NotificationType = "email";
export type NotificationStatus = "sent" | "pending" | "error";
export type NotificationStatusSummary = Record<NotificationStatus, number>;
export type NotificationSearchSummary = NotificationStatusSummary & {
  total: number;
  system: number;
  latestCreatedAt: Date | null;
};

/**
 * Computes notification delivery status from sent/error timestamps.
 */
const determineStatus = (sentAt: Date | null, error: string | null): NotificationStatus => {
  if (sentAt) return "sent";
  if (error) return "error";
  return "pending";
};

/** @deprecated Declare a typed app notification and call `notifications.send(definition, input)`. */
export type SendNotificationParams = {
  type: NotificationType;
  recipient: string;
  subject: string;
  content?: string;
  rawHtml?: string;
  autoSend?: boolean; // default true - when false, only store in DB without sending
  sentBy?: string; // user ID of sender
};

/** @deprecated Return type of the legacy email-only send API. */
export type SendNotificationResult = {
  id: string;
  status: NotificationStatus;
  error?: string;
};

/** @deprecated Declare a typed user notification and call `notifications.send(definition, input)`. */
export type SendToUserParams = {
  userId: string;
  subject: string;
  content?: string;
  rawHtml?: string;
  sentBy?: string; // user ID of sender
};

export type NotificationMessage = {
  id: string;
  type: NotificationType;
  recipient: string;
  subject: string;
  content: string;
  sentAt: Date | null;
  error: string | null;
  createdAt: Date;
  sentBy: string | null;
  sentByName: string | null;
  status: NotificationStatus;
};

const emptyStatusSummary = (): NotificationStatusSummary => ({
  sent: 0,
  pending: 0,
  error: 0,
});

const emptySearchSummary = (): NotificationSearchSummary => ({
  total: 0,
  sent: 0,
  pending: 0,
  error: 0,
  system: 0,
  latestCreatedAt: null,
});

const warnDeprecatedSendApi = (api: "notifications.send" | "notifications.sendToUser"): void => {
  log.warn("Deprecated notification send API used", {
    api,
    deprecated: true,
    replacement: "defineApp({ notifications }) and notifications.send(definition, input)",
  });
};

type DbNotificationRow = {
  id: string;
  type: NotificationType;
  recipient: string;
  subject: string;
  content: string;
  sent_at: Date | null;
  error: string | null;
  created_at: Date;
  sent_by: string | null;
  sent_by_name: string | null;
};

/**
 * Send a notification. Persists to DB, attempts delivery (if autoSend=true), updates sent_at/error.
 */
const sendLegacy = async (params: SendNotificationParams): Promise<SendNotificationResult> => {
  const { type, recipient, subject, content, rawHtml, autoSend = true, sentBy } = params;

  // Persist to DB
  const dbContent = rawHtml ?? content ?? "";
  const rows = await sql`
    INSERT INTO notifications.messages (type, recipient, subject, content, sent_by)
    VALUES (${type}, ${recipient}, ${subject}, ${dbContent}, ${sentBy ?? null})
    RETURNING id
  `;
  const id = rows[0]!.id as string;

  // Skip delivery if autoSend is false
  if (!autoSend) {
    log.info("Stored notification", { type, recipient });
    return { id, status: "pending" };
  }

  // Attempt delivery
  try {
    if (type === "email") {
      await sendEmail(recipient, subject, { content, rawHtml });
    }
    await sql`UPDATE notifications.messages SET sent_at = now(), error = NULL WHERE id = ${id}`;
    return { id, status: "sent" };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log.error("Failed to send", { type, recipient, error });
    await sql`UPDATE notifications.messages SET error = ${error} WHERE id = ${id}`;
    return { id, status: "error", error };
  }
};

export function send<AppId extends string, Key extends string, R extends NotificationRecipientKind, S extends ZodType>(
  definition: BoundNotificationDefinition<AppId, Key, R, S>,
  input: NotificationSendInput<BoundNotificationDefinition<AppId, Key, R, S>>,
): Promise<TypedNotificationSendResult>;
/** @deprecated Declare a typed app notification and call the definition overload. */
export function send(params: SendNotificationParams): Promise<SendNotificationResult>;
export function send<AppId extends string, Key extends string, R extends NotificationRecipientKind, S extends ZodType>(
  definitionOrParams: SendNotificationParams | BoundNotificationDefinition<AppId, Key, R, S>,
  input?: NotificationSendInput<BoundNotificationDefinition<AppId, Key, R, S>>,
): Promise<SendNotificationResult | TypedNotificationSendResult> {
  if ("type" in definitionOrParams) {
    warnDeprecatedSendApi("notifications.send");
    return sendLegacy(definitionOrParams);
  }
  if (!input) throw new Error("Typed notification send input is required");
  return sendTypedNotification(definitionOrParams, input);
}

/**
 * Send a notification to a user by their database ID.
 * Looks up the user's preferred notification method (currently email only).
 */
export const sendToUser = async (params: SendToUserParams): Promise<{ ok: true; id: string } | { ok: false; error: string }> => {
  warnDeprecatedSendApi("notifications.sendToUser");
  const { userId, subject, content, rawHtml, sentBy } = params;

  // Get user's email from database
  const rows = await sql`SELECT mail FROM auth.users WHERE id = ${userId}`;
  if (rows.length === 0) {
    return { ok: false, error: "User not found" };
  }

  const email = rows[0]!.mail as string | null;
  if (!email) {
    return { ok: false, error: "User has no email address" };
  }

  // For now, always use email. Later this can be extended to support other notification types
  // based on user preferences stored in the database.
  const result = await sendLegacy({
    type: "email",
    recipient: email,
    subject,
    content,
    rawHtml,
    sentBy,
  });

  if (result.status === "error") {
    return { ok: false, error: result.error ?? "Email delivery failed" };
  }

  return { ok: true, id: result.id };
};

/**
 * List notifications with pagination and optional search.
 * Admins see all, regular users see only their own sent notifications.
 */
export const list = async (
  pagination: PaginationParams,
  options?: { sentBy?: string; isAdmin?: boolean; search?: string; status?: NotificationStatus },
): Promise<{ notifications: NotificationMessage[]; total: number }> => {
  const { offset, perPage } = pagination;
  const { sentBy, isAdmin, search, status } = options ?? {};

  // Build query based on permissions
  let countRows: Array<{ count: number | string }> = [];
  let dataRows: DbNotificationRow[] = [];

  const searchPattern = search ? `%${escapeLikePattern(search)}%` : null;
  const statusFilter = status ?? null;

  if (isAdmin) {
    // Admins see all notifications
    if (searchPattern) {
      countRows = await sql`
        SELECT COUNT(*)::int as count FROM notifications.messages
        WHERE
          (${statusFilter}::text IS NULL OR CASE WHEN sent_at IS NOT NULL THEN 'sent' WHEN error IS NOT NULL THEN 'error' ELSE 'pending' END = ${statusFilter})
          AND (subject ILIKE ${searchPattern} ESCAPE '\' OR content ILIKE ${searchPattern} ESCAPE '\' OR recipient ILIKE ${searchPattern} ESCAPE '\')
      `;
      dataRows = await sql`
        SELECT
          m.id, m.type, m.recipient, m.subject, m.content,
          m.sent_at, m.error, m.created_at, m.sent_by,
          u.display_name as sent_by_name
        FROM notifications.messages m
        LEFT JOIN auth.users u ON m.sent_by = u.id
        WHERE
          (${statusFilter}::text IS NULL OR CASE WHEN m.sent_at IS NOT NULL THEN 'sent' WHEN m.error IS NOT NULL THEN 'error' ELSE 'pending' END = ${statusFilter})
          AND (m.subject ILIKE ${searchPattern} ESCAPE '\' OR m.content ILIKE ${searchPattern} ESCAPE '\' OR m.recipient ILIKE ${searchPattern} ESCAPE '\')
        ORDER BY m.created_at DESC
        LIMIT ${perPage} OFFSET ${offset}
      `;
    } else {
      countRows = await sql`
        SELECT COUNT(*)::int as count FROM notifications.messages
        WHERE ${statusFilter}::text IS NULL OR CASE WHEN sent_at IS NOT NULL THEN 'sent' WHEN error IS NOT NULL THEN 'error' ELSE 'pending' END = ${statusFilter}
      `;
      dataRows = await sql`
        SELECT
          m.id, m.type, m.recipient, m.subject, m.content,
          m.sent_at, m.error, m.created_at, m.sent_by,
          u.display_name as sent_by_name
        FROM notifications.messages m
        LEFT JOIN auth.users u ON m.sent_by = u.id
        WHERE ${statusFilter}::text IS NULL OR CASE WHEN m.sent_at IS NOT NULL THEN 'sent' WHEN m.error IS NOT NULL THEN 'error' ELSE 'pending' END = ${statusFilter}
        ORDER BY m.created_at DESC
        LIMIT ${perPage} OFFSET ${offset}
      `;
    }
  } else if (sentBy) {
    // Regular users see only their own sent notifications
    if (searchPattern) {
      countRows = await sql`
        SELECT COUNT(*)::int as count FROM notifications.messages
        WHERE
          sent_by = ${sentBy}
          AND (${statusFilter}::text IS NULL OR CASE WHEN sent_at IS NOT NULL THEN 'sent' WHEN error IS NOT NULL THEN 'error' ELSE 'pending' END = ${statusFilter})
          AND (subject ILIKE ${searchPattern} ESCAPE '\' OR content ILIKE ${searchPattern} ESCAPE '\' OR recipient ILIKE ${searchPattern} ESCAPE '\')
      `;
      dataRows = await sql`
        SELECT
          m.id, m.type, m.recipient, m.subject, m.content,
          m.sent_at, m.error, m.created_at, m.sent_by,
          u.display_name as sent_by_name
        FROM notifications.messages m
        LEFT JOIN auth.users u ON m.sent_by = u.id
        WHERE
          m.sent_by = ${sentBy}
          AND (${statusFilter}::text IS NULL OR CASE WHEN m.sent_at IS NOT NULL THEN 'sent' WHEN m.error IS NOT NULL THEN 'error' ELSE 'pending' END = ${statusFilter})
          AND (m.subject ILIKE ${searchPattern} ESCAPE '\' OR m.content ILIKE ${searchPattern} ESCAPE '\' OR m.recipient ILIKE ${searchPattern} ESCAPE '\')
        ORDER BY m.created_at DESC
        LIMIT ${perPage} OFFSET ${offset}
      `;
    } else {
      countRows = await sql`
        SELECT COUNT(*)::int as count FROM notifications.messages
        WHERE
          sent_by = ${sentBy}
          AND (${statusFilter}::text IS NULL OR CASE WHEN sent_at IS NOT NULL THEN 'sent' WHEN error IS NOT NULL THEN 'error' ELSE 'pending' END = ${statusFilter})
      `;
      dataRows = await sql`
        SELECT
          m.id, m.type, m.recipient, m.subject, m.content,
          m.sent_at, m.error, m.created_at, m.sent_by,
          u.display_name as sent_by_name
        FROM notifications.messages m
        LEFT JOIN auth.users u ON m.sent_by = u.id
        WHERE
          m.sent_by = ${sentBy}
          AND (${statusFilter}::text IS NULL OR CASE WHEN m.sent_at IS NOT NULL THEN 'sent' WHEN m.error IS NOT NULL THEN 'error' ELSE 'pending' END = ${statusFilter})
        ORDER BY m.created_at DESC
        LIMIT ${perPage} OFFSET ${offset}
      `;
    }
  } else {
    return { notifications: [], total: 0 };
  }

  const rawTotal = countRows[0]?.count ?? 0;
  const total = typeof rawTotal === "string" ? Number.parseInt(rawTotal, 10) : rawTotal;

  const notifications: NotificationMessage[] = dataRows.map((row: DbNotificationRow) => {
    const sentAt = row.sent_at as Date | null;
    const error = row.error as string | null;

    return {
      id: row.id,
      type: row.type,
      recipient: row.recipient,
      subject: row.subject,
      content: row.content,
      sentAt,
      error,
      createdAt: row.created_at,
      sentBy: row.sent_by,
      sentByName: row.sent_by_name,
      status: determineStatus(sentAt, error),
    };
  });

  return { notifications, total };
};

/**
 * Count current notification statuses for recent entries.
 */
export const getStatusSummary = async (options?: {
  sentBy?: string;
  isAdmin?: boolean;
  days?: number;
}): Promise<NotificationStatusSummary> => {
  const { sentBy, isAdmin, days = 7 } = options ?? {};
  const windowDays = Math.max(1, Math.floor(days));
  const summary = emptyStatusSummary();

  let rows: Array<{ status: NotificationStatus; count: number | string }> = [];
  if (isAdmin) {
    rows = await sql`
      SELECT
        CASE WHEN sent_at IS NOT NULL THEN 'sent' WHEN error IS NOT NULL THEN 'error' ELSE 'pending' END as status,
        COUNT(*)::int as count
      FROM notifications.messages
      WHERE created_at >= now() - (${windowDays}::int * interval '1 day')
      GROUP BY status
    `;
  } else if (sentBy) {
    rows = await sql`
      SELECT
        CASE WHEN sent_at IS NOT NULL THEN 'sent' WHEN error IS NOT NULL THEN 'error' ELSE 'pending' END as status,
        COUNT(*)::int as count
      FROM notifications.messages
      WHERE sent_by = ${sentBy} AND created_at >= now() - (${windowDays}::int * interval '1 day')
      GROUP BY status
    `;
  }

  for (const row of rows) {
    const count = typeof row.count === "string" ? Number.parseInt(row.count, 10) : row.count;
    summary[row.status] = Number.isFinite(count) ? count : 0;
  }

  return summary;
};

/**
 * Count statuses across all entries matching a search term in the current access scope.
 */
export const getSearchSummary = async (options: {
  search: string;
  sentBy?: string;
  isAdmin?: boolean;
}): Promise<NotificationSearchSummary> => {
  const { sentBy, isAdmin } = options;
  const search = options.search.trim();
  if (!search) return emptySearchSummary();

  const searchPattern = `%${escapeLikePattern(search)}%`;
  let rows: Array<{
    total: number | string;
    sent: number | string;
    pending: number | string;
    error: number | string;
    system: number | string;
    latest_created_at: Date | null;
  }> = [];

  if (isAdmin) {
    rows = await sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE sent_at IS NOT NULL)::int AS sent,
        COUNT(*) FILTER (WHERE sent_at IS NULL AND error IS NULL)::int AS pending,
        COUNT(*) FILTER (WHERE sent_at IS NULL AND error IS NOT NULL)::int AS error,
        COUNT(*) FILTER (WHERE sent_by IS NULL)::int AS system,
        MAX(created_at) AS latest_created_at
      FROM notifications.messages
      WHERE subject ILIKE ${searchPattern} ESCAPE '\'
        OR content ILIKE ${searchPattern} ESCAPE '\'
        OR recipient ILIKE ${searchPattern} ESCAPE '\'
    `;
  } else if (sentBy) {
    rows = await sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE sent_at IS NOT NULL)::int AS sent,
        COUNT(*) FILTER (WHERE sent_at IS NULL AND error IS NULL)::int AS pending,
        COUNT(*) FILTER (WHERE sent_at IS NULL AND error IS NOT NULL)::int AS error,
        COUNT(*) FILTER (WHERE sent_by IS NULL)::int AS system,
        MAX(created_at) AS latest_created_at
      FROM notifications.messages
      WHERE sent_by = ${sentBy}
        AND (
          subject ILIKE ${searchPattern} ESCAPE '\'
          OR content ILIKE ${searchPattern} ESCAPE '\'
          OR recipient ILIKE ${searchPattern} ESCAPE '\'
        )
    `;
  }

  const row = rows[0];
  if (!row) return emptySearchSummary();

  const toNumber = (value: number | string) => {
    const parsed = typeof value === "string" ? Number.parseInt(value, 10) : value;
    return Number.isFinite(parsed) ? parsed : 0;
  };

  return {
    total: toNumber(row.total),
    sent: toNumber(row.sent),
    pending: toNumber(row.pending),
    error: toNumber(row.error),
    system: toNumber(row.system),
    latestCreatedAt: row.latest_created_at,
  };
};

/**
 * Get a single notification by ID.
 */
export const getById = async (id: string): Promise<NotificationMessage | null> => {
  const rows = await sql`
    SELECT
      m.id, m.type, m.recipient, m.subject, m.content,
      m.sent_at, m.error, m.created_at, m.sent_by,
      u.display_name as sent_by_name
    FROM notifications.messages m
    LEFT JOIN auth.users u ON m.sent_by = u.id
    WHERE m.id = ${id}
  `;

  if (rows.length === 0) return null;

  const row = rows[0]!;
  const sentAt = row.sent_at as Date | null;
  const error = row.error as string | null;

  return {
    id: row.id as string,
    type: row.type as NotificationType,
    recipient: row.recipient as string,
    subject: row.subject as string,
    content: row.content as string,
    sentAt,
    error,
    createdAt: row.created_at as Date,
    sentBy: row.sent_by as string | null,
    sentByName: row.sent_by_name as string | null,
    status: determineStatus(sentAt, error),
  };
};

/**
 * Resend a notification (retry delivery).
 */
export const resend = async (id: string): Promise<{ ok: true } | { ok: false; code: "not_found" | "delivery_failed"; error: string }> => {
  const notification = await getById(id);
  if (!notification) {
    return { ok: false, code: "not_found", error: "Notification not found" };
  }

  try {
    if (notification.type === "email") {
      await sendEmail(notification.recipient, notification.subject, {
        rawHtml: notification.content,
      });
    }
    await sql`UPDATE notifications.messages SET sent_at = now(), error = NULL WHERE id = ${id}`;
    return { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await sql`UPDATE notifications.messages SET error = ${error} WHERE id = ${id}`;
    return { ok: false, code: "delivery_failed", error };
  }
};

/**
 * Update a notification.
 * Non-admins can only edit pending/error notifications.
 * Admins can edit any notification (including sent ones).
 */
export const update = async (
  id: string,
  data: { subject?: string; content?: string; recipient?: string },
  options?: { isAdmin?: boolean },
): Promise<{ ok: true } | { ok: false; code: "not_found" | "invalid_state"; error: string }> => {
  const notification = await getById(id);
  if (!notification) {
    return { ok: false, code: "not_found", error: "Notification not found" };
  }

  // Non-admins cannot edit sent notifications
  if (!options?.isAdmin && notification.status === "sent") {
    return { ok: false, code: "invalid_state", error: "Cannot edit a sent notification" };
  }

  if (data.subject === undefined && data.content === undefined && data.recipient === undefined) {
    return { ok: true };
  }

  // Clear error when editing (only for non-sent notifications)
  const clearError = notification.status !== "sent";

  await sql`
    UPDATE notifications.messages
    SET
      subject = COALESCE(${data.subject ?? null}, subject),
      content = COALESCE(${data.content ?? null}, content),
      recipient = COALESCE(${data.recipient ?? null}, recipient),
      error = CASE WHEN ${clearError} THEN NULL ELSE error END
    WHERE id = ${id}
  `;

  return { ok: true };
};

/**
 * Get count of pending system notifications (sent_by IS NULL).
 */
export const getPendingSystemCount = async (): Promise<number> => {
  const rows = await sql`
    SELECT COUNT(*)::int as count FROM notifications.messages
    WHERE sent_at IS NULL AND error IS NULL AND sent_by IS NULL
  `;
  return rows[0]?.count ?? 0;
};

/**
 * Send all pending system notifications (sent_by IS NULL).
 * Returns the count of successfully sent and failed notifications.
 */
export const sendAllPendingSystem = async (): Promise<{
  sent: number;
  failed: number;
  errors: { id: string; recipient: string; error: string }[];
}> => {
  // Get all pending system notifications
  const rows = await sql`
    SELECT id, type, recipient, subject, content
    FROM notifications.messages
    WHERE sent_at IS NULL AND error IS NULL AND sent_by IS NULL
    ORDER BY created_at ASC
  `;

  let sent = 0;
  let failed = 0;
  const errors: { id: string; recipient: string; error: string }[] = [];

  for (const row of rows) {
    const id = row.id as string;
    const type = row.type as NotificationType;
    const recipient = row.recipient as string;
    const subject = row.subject as string;
    const content = row.content as string;

    try {
      if (type === "email") {
        await sendEmail(recipient, subject, { rawHtml: content });
      }
      await sql`UPDATE notifications.messages SET sent_at = now(), error = NULL WHERE id = ${id}`;
      sent++;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await sql`UPDATE notifications.messages SET error = ${error} WHERE id = ${id}`;
      failed++;
      errors.push({ id, recipient, error });
    }
  }

  return { sent, failed, errors };
};

export const notifications = {
  send,
  sendToUser,
  list,
  getById,
  resend,
  update,
  getPendingSystemCount,
  sendAllPendingSystem,
  getStatusSummary,
  getSearchSummary,
  live: notificationLive,
  observability: notificationObservability,
  user: userNotifications,
};

export type {
  NotificationBatch,
  NotificationBatchPreview,
  NotificationBatchRecipient,
  NotificationBatchRecipientStatus,
  NotificationBatchSelection,
  NotificationBatchStatus,
} from "./batches";
export { notificationBatches } from "./batches";
export {
  type NotificationDefinitionObservabilityItem,
  type NotificationDeliveryObservabilityItem,
  type NotificationDeliveryTimeseriesPoint,
  notificationObservability,
} from "./observability";
export { userNotifications } from "./user";
