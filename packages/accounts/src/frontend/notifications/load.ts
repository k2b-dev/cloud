import { notificationBatches } from "@k2b/cloud/services";
import { formatNumber } from "@k2b/cloud/shared";
import { dates } from "@k2b/stdlib";
import { listMessages } from "../list-messages";
import { accountsMessages } from "../messages";
import type { NotificationsScreenProps } from "./NotificationsScreen";
import { BATCHES_PER_PAGE, batchesHref, batchesQuery, parseListAddress } from "./query";

/**
 * The notification batches' part of the activity page: the status filter, the page and whether the new-batch form is
 * open, read from the address; the batches through the notification service. Returns the screen's data or a redirect.
 */
export const loadNotifications = async (
  url: URL,
  context: { locale: string; timeZone: string; pendingRequests: number },
): Promise<{ redirect: string } | { props: NotificationsScreenProps }> => {
  const { locale, timeZone } = context;
  const { t } = accountsMessages.resolve([locale]);
  const query = batchesQuery(locale);
  const address = parseListAddress(query, url.searchParams);
  const creating = url.searchParams.get("new") === "1";

  const batchesPage = await notificationBatches
    .list({ page: address.page, perPage: BATCHES_PER_PAGE, status: address.state.filters.status })
    .catch(() => null);
  // A page past the end, after deletions or from an old link, opens the last page with the same filter.
  const pages = Math.max(1, Math.ceil((batchesPage?.total ?? 0) / BATCHES_PER_PAGE));
  if (batchesPage && address.page > pages) return { redirect: batchesHref(query, address.state, { page: pages, creating }) };

  const number = (value: number) => formatNumber(value, { locale });
  const rows =
    batchesPage?.items.map((entry) => ({
      id: entry.id,
      subject: entry.subject,
      note: entry.lastError ?? t.emailBatch,
      status: entry.status,
      recipients: t.deliverableRatio({ deliverable: number(entry.deliverableCount), total: number(entry.targetCount) }),
      sent: number(entry.sentCount),
      sentCount: entry.sentCount,
      deliverableCount: entry.deliverableCount,
      deliverable: number(entry.deliverableCount),
      errors: number(entry.errorCount),
      hasErrors: entry.errorCount > 0,
      created: dates.formatDateTime(entry.createdAt, { locale, timeZone }),
    })) ?? null;
  const words = listMessages.resolve([locale]).t;
  const ignored =
    address.issues.length > 0
      ? words.ignoredPartsDetail({
          params: address.issues.map((issue) => (issue.param ? `${issue.param}=${issue.value}` : issue.code)).join(", "),
        })
      : null;

  return {
    props: {
      state: address.state,
      page: address.page,
      pages,
      total: batchesPage?.total ?? 0,
      rows,
      creating,
      ignored,
      pendingRequests: context.pendingRequests,
    },
  };
};
