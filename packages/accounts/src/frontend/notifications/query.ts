/**
 * The declarations of the notification lists: the batches with their status (the kind "Benachrichtigungen" of the
 * activity page), and a batch's recipients with theirs (on the batch's record). The SSR pages read and the browser
 * writes the address only through them. The batch list keeps its former `status`; a batch's recipient filter is
 * `status` on its record too (the former `recipient_status`: a list query names its parameters without `_`).
 * Accounts filters on the server (`notificationBatches`).
 */
import type { NotificationBatch, NotificationBatchRecipientStatus } from "@k2b/cloud/services";
import { defineListQuery, field, type ListQueryIssue, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import { ACTIVITY_PATH, BATCH_PATH, kindField, legacyListHref } from "../activity/kind";
import { type AccountsMessages, accountsMessages } from "../messages";

export const NOTIFICATIONS_PAGE_PATH = ACTIVITY_PATH;
/** Batches per page and recipients per page, as before v2. */
export const BATCHES_PER_PAGE = 50;
export const RECIPIENTS_PER_PAGE = 100;
/** Last page the lists open, as the service pages. */
export const NOTIFICATIONS_PAGE_MAX = 10_000;

export const batchStatusLabel = (t: AccountsMessages, status: NotificationBatch["status"]): string =>
  ({
    draft: t.draft,
    ready: t.ready,
    running: t.running,
    completed: t.completed,
    completed_with_errors: t.withErrors,
    failed: t.failed,
    cancelled: t.cancelled,
  })[status];

export const recipientStatusLabel = (t: AccountsMessages, status: NotificationBatchRecipientStatus): string =>
  ({ pending: t.pending, sending: t.sending, sent: t.sent, skipped: t.skipped, error: t.error })[status];

const BATCH_STATUSES = [
  "draft",
  "ready",
  "running",
  "completed",
  "completed_with_errors",
  "failed",
  "cancelled",
] as const satisfies readonly NotificationBatch["status"][];
const RECIPIENT_STATUSES = [
  "pending",
  "sending",
  "sent",
  "skipped",
  "error",
] as const satisfies readonly NotificationBatchRecipientStatus[];

/** The batch list: one status at a time, as the service filters; `new` opens the form for a new batch beside it. */
export const batchesQuery = (locale: string) => {
  const { t } = accountsMessages.resolve([locale]);
  return defineListQuery({
    key: "accounts.notifications",
    fields: {
      kind: kindField(locale),
      status: field.choice({
        label: t.status,
        common: true,
        multiple: false,
        options: BATCH_STATUSES.map((status) => ({ value: status, label: batchStatusLabel(t, status) })),
      }),
    },
    sort: { fixed: { field: "created", direction: "desc", label: t.created } },
    pageParams: ["page", "new"],
  });
};

/** A batch's recipients: one recipient status at a time, as the service filters. */
export const recipientsQuery = (locale: string) => {
  const { t } = accountsMessages.resolve([locale]);
  return defineListQuery({
    key: "accounts.notification-recipients",
    fields: {
      status: field.choice({
        label: t.recipientStatus,
        common: true,
        multiple: false,
        options: RECIPIENT_STATUSES.map((status) => ({ value: status, label: recipientStatusLabel(t, status) })),
      }),
    },
    sort: { fixed: { field: "recipient", direction: "asc", label: t.recipients } },
    pageParams: ["page"],
  });
};

export type BatchesQuery = ReturnType<typeof batchesQuery>;
export type BatchesState = ListQueryStateOf<BatchesQuery>;
export type RecipientsQuery = ReturnType<typeof recipientsQuery>;
export type RecipientsState = ListQueryStateOf<RecipientsQuery>;

/** Reads a list address and its page; a page out of bounds opens the first page and is reported. Never throws. */
export const parseListAddress = <S extends { view?: string }>(
  query: { parse: (params: URLSearchParams) => { state: S; issues: readonly ListQueryIssue[] } },
  params: URLSearchParams,
): { state: S; page: number; issues: readonly ListQueryIssue[] } => {
  const parsed = query.parse(params);
  const issues: ListQueryIssue[] = [...parsed.issues];
  let state = parsed.state;
  if (state.view !== undefined) {
    issues.push({ code: "invalid", param: "view", value: state.view });
    state = { ...state, view: undefined };
  }
  const pageRaw = params.get("page");
  const page = pageRaw === null ? 1 : Number(pageRaw);
  const valid = Number.isSafeInteger(page) && page >= 1 && page <= NOTIFICATIONS_PAGE_MAX;
  if (!valid) issues.push({ code: "invalid", param: "page", value: pageRaw ?? "" });
  return { state, page: valid ? page : 1, issues };
};

/** The batch list's address, with its page and the form for a new batch open or not. */
export const batchesHref = (query: BatchesQuery, state: BatchesState, extra: { page?: number; creating?: boolean } = {}): string => {
  const params = query.serialize(state);
  if (extra.page && extra.page > 1) params.set("page", String(extra.page));
  if (extra.creating) params.set("new", "1");
  const text = params.toString();
  return text ? `${NOTIFICATIONS_PAGE_PATH}?${text}` : NOTIFICATIONS_PAGE_PATH;
};

/** A batch's address, with its recipient filter and page. */
export const batchHref = (query: RecipientsQuery, id: string, state: RecipientsState, page = 1): string => {
  const params = query.serialize(state);
  if (page > 1) params.set("page", String(page));
  const text = params.toString();
  return text ? `${BATCH_PATH}/${id}?${text}` : `${BATCH_PATH}/${id}`;
};

/** The activity address for an address of the former notification list (`/app/accounts/notifications`). */
export const legacyNotificationsHref = (params: URLSearchParams): string => legacyListHref("notifications", params);

/**
 * A batch's record for an address of the former batch page (`/app/accounts/notifications/:id`): the recipient filter
 * `recipient_status` became `status`; every other parameter is kept, and a `status` that is already there wins.
 */
export const legacyBatchHref = (id: string, params: URLSearchParams): string => {
  const next = new URLSearchParams();
  for (const [name, value] of params) if (name !== "recipient_status") next.append(name, value);
  const status = params.get("recipient_status");
  if (status && !params.has("status")) next.set("status", status);
  const text = next.toString();
  return text ? `${BATCH_PATH}/${encodeURIComponent(id)}?${text}` : `${BATCH_PATH}/${encodeURIComponent(id)}`;
};
