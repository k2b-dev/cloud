import { accountsAppService as accountsService } from "@k2b/cloud/services";
import { dates } from "@k2b/stdlib";
import { listMessages } from "../list-messages";
import type { DeletedAccountsScreenProps } from "./DeletedAccountsScreen";
import { DELETED_PER_PAGE, deletedHref, deletedQuery, parseDeletedAddress } from "./query";

/** A recorded metadata value as text: plain values as they are, anything else as JSON. */
const metaText = (value: unknown): string =>
  value === null || value === undefined ? "–" : typeof value === "object" ? JSON.stringify(value) : String(value);

/**
 * The deleted accounts' part of the activity page: the reason, the search, the page and the open entry from the
 * address, the accounts through the lifecycle service. Returns the screen's data or a redirect.
 */
export const loadDeleted = async (
  url: URL,
  context: { locale: string; timeZone: string; pendingRequests: number },
): Promise<{ redirect: string } | { props: DeletedAccountsScreenProps }> => {
  const { locale, timeZone } = context;
  const query = deletedQuery(locale);
  const address = parseDeletedAddress(query, url.searchParams);
  // A store that cannot be read fails the list, not the page: the list shows the failure with a way to try again.
  const deleted = await accountsService.lifecycle.deletedAccounts
    .list({
      page: address.page,
      perPage: DELETED_PER_PAGE,
      search: address.state.search,
      reason: address.state.filters.reason,
    })
    .catch(() => null);
  const pages = Math.max(1, Math.ceil((deleted?.total ?? 0) / DELETED_PER_PAGE));
  // A page past the end, from an old link, opens the last page with the same filters.
  if (deleted && address.page > pages) return { redirect: deletedHref(query, address.state, pages) };

  const words = listMessages.resolve([locale]).t;
  const ignored =
    address.issues.length > 0
      ? words.ignoredPartsDetail({
          params: address.issues.map((issue) => (issue.param ? `${issue.param}=${issue.value}` : issue.code)).join(", "),
        })
      : null;
  const items = deleted?.items ?? [];
  const rows = items.map((entry) => ({
    id: entry.id,
    name: entry.displayName || entry.uid,
    uid: entry.uid,
    mail: entry.mail,
    provider: entry.previousProvider,
    profile: entry.previousProfile,
    reason: entry.reason,
    deleted: dates.formatDateTime(entry.deletedAt, { locale, timeZone }),
  }));
  // the open entry is one of this page's rows; an entry from another page or one that is gone opens nothing
  const index = address.entry ? items.findIndex((entry) => entry.id === address.entry) : -1;
  const [row, item] = [rows[index], items[index]];
  const open =
    row && item ? { ...row, meta: Object.entries(item.meta ?? {}).map(([key, value]) => ({ key, value: metaText(value) })) } : null;

  return {
    props: {
      state: address.state,
      page: address.page,
      pages,
      total: deleted?.total ?? 0,
      rows: deleted ? rows : null,
      entry: address.entry,
      open,
      ignored,
      pendingRequests: context.pendingRequests,
    },
  };
};
