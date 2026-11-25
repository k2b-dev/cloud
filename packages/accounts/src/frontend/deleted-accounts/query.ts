/**
 * The deleted-accounts list's one declaration, the kind "Gelöschte Konten" of the activity page: the reason filter, the search, the page and the open entry. The SSR page
 * reads and the browser writes the address only through it. The lifecycle service filters on the server.
 */
import { defineListQuery, field, type ListQueryIssue, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import { ACTIVITY_PATH, kindField, legacyListHref } from "../activity/kind";
import { accountsMessages } from "../messages";
import { deletedMessages } from "./messages";

export const DELETED_PATH = ACTIVITY_PATH;
/** Entries per page, as before v2. */
export const DELETED_PER_PAGE = 100;
/** Longest free search. A longer text is dropped and reported, never cut silently. */
export const DELETED_SEARCH_MAX = 200;
/** Last page the list opens. */
export const DELETED_PAGE_MAX = 1000;

/** The reasons the lifecycle records, in the order the filter offers them. */
export const DELETED_REASONS = [
  "ipa_expired_demoted",
  "ipa_expired_deleted",
  "sync_out_of_scope_demoted",
  "sync_out_of_scope_deleted",
  "guest_expired_deleted",
  "local_user_expired_deleted",
  "manual_demote",
  "manual_delete",
] as const;
export type DeletedReason = (typeof DELETED_REASONS)[number];

/** Builds the declaration in the request's language. */
export const deletedQuery = (locale: string) => {
  const { t } = accountsMessages.resolve([locale]);
  const words = deletedMessages.resolve([locale]).t;
  const label: Record<DeletedReason, string> = {
    ipa_expired_demoted: t.reasonIpaExpired,
    ipa_expired_deleted: t.reasonIpaExpiredDelete,
    sync_out_of_scope_demoted: t.reasonSyncOutOfScope,
    sync_out_of_scope_deleted: t.reasonSyncDelete,
    guest_expired_deleted: t.reasonGuestExpired,
    local_user_expired_deleted: t.reasonLocalExpired,
    manual_demote: t.reasonManualDemote,
    manual_delete: t.reasonManualDelete,
  };
  return defineListQuery({
    key: "accounts.deleted",
    fields: {
      kind: kindField(locale),
      reason: field.choice({
        label: t.reason,
        common: true,
        multiple: false,
        options: DELETED_REASONS.map((value) => ({ value, label: label[value] })),
      }),
    },
    search: { label: words.searchLabel },
    sort: { fixed: { field: "deleted", direction: "desc", label: words.newestFirst } },
    pageParams: ["page", "entry"],
  });
};

export type DeletedQuery = ReturnType<typeof deletedQuery>;
export type DeletedState = ListQueryStateOf<DeletedQuery>;

/** What the page reads from an address: the list state, the page, the open entry and what was dropped. */
export type DeletedAddress = { state: DeletedState; page: number; entry: string | null; issues: readonly ListQueryIssue[] };

/** Reads an address with the declaration and holds every value to the list's bounds. Never throws. */
export const parseDeletedAddress = (query: DeletedQuery, params: URLSearchParams): DeletedAddress => {
  const parsed = query.parse(params);
  const issues: ListQueryIssue[] = [...parsed.issues];
  let state = parsed.state;
  if (state.search && state.search.length > DELETED_SEARCH_MAX) {
    issues.push({ code: "invalid", param: "q", value: state.search });
    state = { ...state, search: undefined };
  }
  if (state.view !== undefined) {
    issues.push({ code: "invalid", param: "view", value: state.view });
    state = { ...state, view: undefined };
  }
  const pageRaw = params.get("page");
  const page = pageRaw === null ? 1 : Number(pageRaw);
  const valid = Number.isSafeInteger(page) && page >= 1 && page <= DELETED_PAGE_MAX;
  if (!valid) issues.push({ code: "invalid", param: "page", value: pageRaw ?? "" });
  return { state, page: valid ? page : 1, entry: params.get("entry") || null, issues };
};

/** The address of a state, its page and the open entry. */
export const deletedHref = (query: DeletedQuery, state: DeletedState, page = 1, entry?: string): string => {
  const params = query.serialize(state);
  if (page > 1) params.set("page", String(page));
  if (entry) params.set("entry", entry);
  const text = params.toString();
  return text ? `${DELETED_PATH}?${text}` : DELETED_PATH;
};

/**
 * The activity address for an address of the former deleted-accounts page (`/app/accounts/deleted-accounts`):
 * `search` became `q`; `reason`, `page` and `entry` keep their names.
 */
export const legacyDeletedHref = (params: URLSearchParams): string => legacyListHref("deleted", params);
