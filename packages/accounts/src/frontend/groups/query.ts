/**
 * The group list's one declaration: which groups (mine, managed by me, all), who manages them, the search and the
 * page. The SSR page reads and the browser writes the address only through it. Accounts filters on the server
 * (`accountsAppService.group.list`); there are no saved views.
 */
import { defineListQuery, field, type ListQueryIssue, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import type { GroupsListState } from "../lib/url-state";
import { listMessages } from "../list-messages";

export const GROUPS_PAGE_PATH = "/app/accounts/groups";
/** Groups per page, as before v2. */
export const GROUPS_PER_PAGE = 100;
/** Longest free search. A longer text is dropped and reported, never cut silently. */
export const GROUPS_SEARCH_MAX = 200;
/** Last page the list opens. */
export const GROUPS_PAGE_MAX = 1000;

export type GroupScope = GroupsListState["scope"];

/** Builds the declaration in the request's language; `defaultScope` is the person's own start (`getDefaultGroupScope`). */
export const groupsQuery = (locale: string, defaultScope: GroupScope) => {
  const { t } = listMessages.resolve([locale]);
  return defineListQuery({
    key: "accounts.groups",
    fields: {
      scope: field.choice({
        label: t.scope,
        op: t.scopeOp,
        common: true,
        multiple: false,
        options: [
          { value: "member", label: t.myGroups },
          { value: "managed", label: t.managedByMe },
          { value: "all", label: t.allGroups },
        ] satisfies { value: GroupScope; label: string }[],
        required: defaultScope,
      }),
      provider: field.choice({
        label: t.managedBy,
        common: true,
        multiple: false,
        options: [
          { value: "ipa", label: "FreeIPA" },
          { value: "local", label: t.local },
        ],
      }),
    },
    search: { label: t.searchGroups },
    sort: { fixed: { field: "name", direction: "asc", label: t.nameAsc } },
    pageParams: ["page"],
  });
};

export type GroupsQuery = ReturnType<typeof groupsQuery>;
export type GroupsState = ListQueryStateOf<GroupsQuery>;

/** Reads an address with the declaration and holds every value to the list's bounds. Never throws. */
export const parseGroupsAddress = (
  query: GroupsQuery,
  params: URLSearchParams,
): { state: GroupsState; page: number; issues: readonly ListQueryIssue[] } => {
  const parsed = query.parse(params);
  const issues: ListQueryIssue[] = [...parsed.issues];
  let state = parsed.state;
  if (state.search && state.search.length > GROUPS_SEARCH_MAX) {
    issues.push({ code: "invalid", param: "q", value: state.search });
    state = { ...state, search: undefined };
  }
  if (state.view !== undefined) {
    issues.push({ code: "invalid", param: "view", value: state.view });
    state = { ...state, view: undefined };
  }
  const pageRaw = params.get("page");
  const page = pageRaw === null ? 1 : Number(pageRaw);
  const valid = Number.isSafeInteger(page) && page >= 1 && page <= GROUPS_PAGE_MAX;
  if (!valid) issues.push({ code: "invalid", param: "page", value: pageRaw ?? "" });
  return { state, page: valid ? page : 1, issues };
};

/** The address of a state, plus its page. */
export const groupsHref = (query: GroupsQuery, state: GroupsState, page = 1): string => {
  const params = query.serialize(state);
  if (page > 1) params.set("page", String(page));
  const text = params.toString();
  return text ? `${GROUPS_PAGE_PATH}?${text}` : GROUPS_PAGE_PATH;
};

/** The list state as the group pages keep it in their links (`buildGroupDetailUrl`). */
export const groupsListState = (state: GroupsState, page: number): GroupsListState => ({
  search: state.search ?? "",
  page,
  provider: state.filters.provider ?? "",
  scope: state.filters.scope,
});

/**
 * The v2 address for a pre-v2 one (bookmarks, links from other pages), or null when it is already v2: `search`
 * became `q`, and the personal Linux groups filter (`personal`) left the list. Every other parameter stays.
 */
export const legacyGroupsHref = (query: GroupsQuery, params: URLSearchParams): string | null => {
  if (!params.has("search") && !params.has("personal")) return null;
  const next = new URLSearchParams();
  for (const [name, value] of params) if (name !== "search" && name !== "personal") next.append(name, value);
  const search = params.get("search")?.trim();
  if (search && !params.has("q")) next.set("q", search);
  const address = parseGroupsAddress(query, next);
  return groupsHref(query, address.state, address.page);
};
