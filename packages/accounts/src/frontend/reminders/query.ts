/**
 * The reminder history's one declaration, the kind "Erinnerungen" of the activity page: the status filter, the search
 * and the page. The SSR page reads and the browser writes the address only through it. The lifecycle service filters on
 * the server. The former reminder-kind filter left: the lifecycle records one kind (account expiry), and `kind` now
 * names the activity kind.
 */
import { defineListQuery, field, type ListQueryIssue, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import { ACTIVITY_PATH, kindField, legacyListHref } from "../activity/kind";
import { accountsMessages } from "../messages";
import { reminderMessages } from "./messages";

export const REMINDERS_PATH = ACTIVITY_PATH;
/** Entries per page, as before v2. */
export const REMINDERS_PER_PAGE = 100;
/** Longest free search. A longer text is dropped and reported, never cut silently. */
export const REMINDERS_SEARCH_MAX = 200;
/** Last page the list opens. */
export const REMINDERS_PAGE_MAX = 1000;

export type ReminderStatus = "pending" | "sent" | "error";

/** Builds the declaration in the request's language. */
export const remindersQuery = (locale: string) => {
  const { t } = accountsMessages.resolve([locale]);
  const words = reminderMessages.resolve([locale]).t;
  return defineListQuery({
    key: "accounts.reminders",
    fields: {
      kind: kindField(locale),
      status: field.choice({
        label: t.status,
        common: true,
        multiple: false,
        options: [
          { value: "pending", label: t.pending },
          { value: "sent", label: t.sent },
          { value: "error", label: t.error },
        ] satisfies { value: ReminderStatus; label: string }[],
      }),
    },
    search: { label: words.searchLabel },
    sort: { fixed: { field: "created", direction: "desc", label: words.newestFirst } },
    pageParams: ["page"],
  });
};

export type RemindersQuery = ReturnType<typeof remindersQuery>;
export type RemindersState = ListQueryStateOf<RemindersQuery>;

/** Reads an address with the declaration and holds every value to the list's bounds. Never throws. */
export const parseRemindersAddress = (
  query: RemindersQuery,
  params: URLSearchParams,
): { state: RemindersState; page: number; issues: readonly ListQueryIssue[] } => {
  const parsed = query.parse(params);
  const issues: ListQueryIssue[] = [...parsed.issues];
  let state = parsed.state;
  if (state.search && state.search.length > REMINDERS_SEARCH_MAX) {
    issues.push({ code: "invalid", param: "q", value: state.search });
    state = { ...state, search: undefined };
  }
  if (state.view !== undefined) {
    issues.push({ code: "invalid", param: "view", value: state.view });
    state = { ...state, view: undefined };
  }
  const pageRaw = params.get("page");
  const page = pageRaw === null ? 1 : Number(pageRaw);
  const valid = Number.isSafeInteger(page) && page >= 1 && page <= REMINDERS_PAGE_MAX;
  if (!valid) issues.push({ code: "invalid", param: "page", value: pageRaw ?? "" });
  return { state, page: valid ? page : 1, issues };
};

/** The address of a state, plus its page. */
export const remindersHref = (query: RemindersQuery, state: RemindersState, page = 1): string => {
  const params = query.serialize(state);
  if (page > 1) params.set("page", String(page));
  const text = params.toString();
  return text ? `${REMINDERS_PATH}?${text}` : REMINDERS_PATH;
};

/**
 * The activity address for an address of the former reminder history (`/app/accounts/reminders`): `search` became
 * `q`; `status` and `page` keep their names, and the former reminder-kind filter (one kind only) is left out.
 */
export const legacyRemindersHref = (params: URLSearchParams): string => legacyListHref("reminders", params);
