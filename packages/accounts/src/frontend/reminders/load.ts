import { accountsAppService as accountsService } from "@k2b/cloud/services";
import { dates } from "@k2b/stdlib";
import { listMessages } from "../list-messages";
import { parseRemindersAddress, REMINDERS_PER_PAGE, remindersHref, remindersQuery } from "./query";
import type { RemindersScreenProps } from "./RemindersScreen";

/**
 * The reminder history's part of the activity page: the status, the search and the page from the address, the
 * reminders through the lifecycle service. Returns the screen's data or a redirect.
 */
export const loadReminders = async (
  url: URL,
  context: { locale: string; timeZone: string; pendingRequests: number },
): Promise<{ redirect: string } | { props: RemindersScreenProps }> => {
  const { locale, timeZone } = context;
  const query = remindersQuery(locale);
  const address = parseRemindersAddress(query, url.searchParams);
  const reminders = await accountsService.lifecycle.reminders.list({
    page: address.page,
    perPage: REMINDERS_PER_PAGE,
    search: address.state.search,
    status: address.state.filters.status,
  });
  const pages = Math.max(1, Math.ceil(reminders.total / REMINDERS_PER_PAGE));
  // A page past the end, from an old link, opens the last page with the same filters.
  if (address.page > pages) return { redirect: remindersHref(query, address.state, pages) };

  const words = listMessages.resolve([locale]).t;
  const ignored =
    address.issues.length > 0
      ? words.ignoredPartsDetail({
          params: address.issues.map((issue) => (issue.param ? `${issue.param}=${issue.value}` : issue.code)).join(", "),
        })
      : null;
  const rows = reminders.items.map((entry) => ({
    id: entry.id,
    name: entry.displayName || entry.uid || null,
    image:
      entry.userId && entry.avatarHash
        ? `/api/accounts/users/${encodeURIComponent(entry.userId)}/avatar?rev=${encodeURIComponent(entry.avatarHash)}`
        : undefined,
    status: entry.status,
    target: dates.formatDateTime(entry.targetExpiryAt, { locale, timeZone }),
    days: entry.thresholdDays,
    attempts: entry.attemptCount,
    lastAttempt: entry.lastAttemptAt ? dates.formatDateTime(entry.lastAttemptAt, { locale, timeZone }) : null,
    error: entry.lastError,
  }));

  return {
    props: {
      state: address.state,
      page: address.page,
      pages,
      total: reminders.total,
      rows,
      ignored,
      pendingRequests: context.pendingRequests,
    },
  };
};
