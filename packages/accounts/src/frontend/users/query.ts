/**
 * The user list's one declaration: its filters, sorts, grouping and address. The SSR page, the users API and the
 * browser read and write the address only through it, so reload, back and a shared link show the same users.
 *
 * Accounts filters on the server (`accountsAppService.user.directory`); the declaration only names fields, values and
 * bounds. There are no saved views: the views live in code (`USER_VIEWS`), as the approved filter concept says.
 */
import type { UserDirectoryRole, UserDirectoryStatus } from "@k2b/cloud/contracts";
import { dates } from "@k2b/stdlib";
import {
  defineListQuery,
  field,
  type ListQueryIssue,
  type ListQueryStateOf,
  type LookupItem,
  type LookupLoadResult,
  type PeriodValue,
} from "@k2b/ui/v2/list-query";
import { listMessages } from "../list-messages";

export const USERS_PAGE_PATH = "/app/accounts/users";
/** Users per page, as before v2. */
export const USERS_PER_PAGE = 100;
/** Longest free search, as the service allows it. A longer text is dropped and reported, never cut silently. */
export const USERS_SEARCH_MAX = 200;
/** Most groups one filter names, as the service allows it. */
export const USERS_GROUPS_MAX = 20;
/** Last page the list opens. */
export const USERS_PAGE_MAX = 1000;

const ROLES = ["admin", "member", "guest"] as const satisfies readonly UserDirectoryRole[];
const STATUSES = ["active", "invited", "expired"] as const satisfies readonly UserDirectoryStatus[];
export type LoginPreset = "last-7d" | "last-30d" | "older-90d" | "never";
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How the browser searches and names groups; the server names chosen groups itself and passes them as `names`. */
export type GroupLookup = {
  load: (query: string, context: { signal: AbortSignal; limit: number }) => Promise<LookupLoadResult>;
  resolve: (values: readonly string[], context: { signal: AbortSignal }) => Promise<readonly LookupItem[]>;
};

/** Builds the declaration in the request's language. `groups` searches groups in the browser. */
export const usersQuery = (locale: string, groups?: GroupLookup) => {
  const { t } = listMessages.resolve([locale]);
  return defineListQuery({
    key: "accounts.users",
    fields: {
      role: field.choice({
        label: t.role,
        common: true,
        options: [
          { value: "admin", label: t.admin },
          { value: "member", label: t.member },
          { value: "guest", label: t.guest },
        ] satisfies { value: (typeof ROLES)[number]; label: string }[],
      }),
      "member-of": field.lookup({
        label: t.group,
        common: true,
        limit: 8,
        load: async (query, context) => (groups ? groups.load(query, context) : { items: [] }),
        resolve: async (values, context) => (groups ? groups.resolve(values, context) : []),
      }),
      status: field.choice({
        label: t.status,
        common: true,
        options: [
          { value: "active", label: t.active },
          { value: "invited", label: t.invited },
          { value: "expired", label: t.expired },
        ] satisfies { value: (typeof STATUSES)[number]; label: string }[],
      }),
      login: field.dateRange({
        label: t.lastLogin,
        common: true,
        presets: [
          { value: "last-7d", label: t.last7d },
          { value: "last-30d", label: t.last30d },
          { value: "older-90d", label: t.older90d },
          { value: "never", label: t.never },
        ] satisfies { value: LoginPreset; label: string }[],
      }),
      passkey: field.bool({ label: t.passkey, common: true, labels: { yes: t.passkeyYes, no: t.passkeyNo } }),
      provider: field.choice({
        label: t.managedBy,
        multiple: false,
        options: [
          { value: "ipa", label: "FreeIPA" },
          { value: "local", label: t.local },
        ],
      }),
    },
    search: { label: t.searchUsers },
    sort: {
      options: {
        name: { label: t.name, directions: ["asc", "desc"] },
        login: { label: t.lastActive, directions: ["desc", "asc"] },
      },
      default: { field: "name", direction: "asc" },
    },
    group: { "member-of": { label: t.byGroup } },
    pageParams: ["page"],
  });
};

export type UsersQuery = ReturnType<typeof usersQuery>;
export type UsersState = ListQueryStateOf<UsersQuery>;

/** The views in code beside "All": their key in the address and their state. */
export const USER_VIEWS = {
  "no-passkey": (query: UsersQuery): UsersState => view(query, "no-passkey", { status: ["active"], passkey: false }),
  invited: (query: UsersQuery): UsersState => view(query, "invited", { status: ["invited"] }),
  expired: (query: UsersQuery): UsersState => view(query, "expired", { status: ["expired"] }),
  "inactive-admins": (query: UsersQuery): UsersState =>
    view(query, "inactive-admins", { role: ["admin"], login: { kind: "preset", preset: "older-90d" } }),
};
export type UserView = keyof typeof USER_VIEWS;
export const USER_VIEW_KEYS = Object.keys(USER_VIEWS) as UserView[];
export const isUserView = (key: string | undefined): key is UserView => key !== undefined && Object.hasOwn(USER_VIEWS, key);

function view(query: UsersQuery, key: UserView, filters: UsersState["filters"]): UsersState {
  return { ...query.reset(), filters, view: key };
}

/** What the page and the API read from an address: the list state, the page and what was dropped. */
export type UsersAddress = { state: UsersState; page: number; issues: readonly ListQueryIssue[] };

/** Reads an address with the declaration and holds every value to the list's bounds. Never throws. */
export const parseUsersAddress = (query: UsersQuery, params: URLSearchParams): UsersAddress => {
  const parsed = query.parse(params);
  const issues: ListQueryIssue[] = [...parsed.issues];
  let state = parsed.state;
  if (state.search && state.search.length > USERS_SEARCH_MAX) {
    issues.push({ code: "invalid", param: "q", value: state.search });
    state = { ...state, search: undefined };
  }
  const groups = state.filters["member-of"];
  if (groups && (groups.length > USERS_GROUPS_MAX || !groups.every((id) => UUID.test(id)))) {
    issues.push({ code: "invalid", param: "member-of", value: groups.join(",") });
    state = query.clear(state, "member-of");
  }
  if (state.view !== undefined && !isUserView(state.view)) {
    issues.push({ code: "invalid", param: "view", value: state.view });
    state = { ...state, view: undefined };
  }
  const pageRaw = params.get("page");
  const page = pageRaw === null ? 1 : Number(pageRaw);
  const valid = Number.isSafeInteger(page) && page >= 1 && page <= USERS_PAGE_MAX;
  if (!valid) issues.push({ code: "invalid", param: "page", value: pageRaw ?? "" });
  return { state, page: valid ? page : 1, issues };
};

const dayStart = (day: string, timeZone: string): Date =>
  new Date(dates.zonedDateTimeToInstant(`${day}T00:00`, timeZone, { disambiguation: "compatible" }));
const nextDay = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

/** The last-sign-in window a period asks for, in the person's time zone: `since` inclusive, `until` exclusive. */
export const loginWindow = (
  period: PeriodValue<LoginPreset>,
  timeZone: string,
  now: Date = new Date(),
): { since?: Date; until?: Date } | "never" => {
  if (period.kind === "preset") {
    if (period.preset === "never") return "never";
    if (period.preset === "older-90d") return { until: new Date(now.getTime() - 90 * DAY_MS) };
    return { since: new Date(now.getTime() - (period.preset === "last-7d" ? 7 : 30) * DAY_MS) };
  }
  return {
    ...(period.from ? { since: dayStart(period.from, timeZone) } : {}),
    ...(period.to ? { until: dayStart(nextDay(period.to), timeZone) } : {}),
  };
};

/** The service query a list state asks for. */
export const directoryQueryOf = (state: UsersState, timeZone: string, now: Date = new Date()) => ({
  search: state.search,
  roles: state.filters.role,
  groupIds: state.filters["member-of"],
  statuses: state.filters.status,
  lastLogin: state.filters.login ? loginWindow(state.filters.login, timeZone, now) : undefined,
  passkey: state.filters.passkey,
  provider: state.filters.provider,
  sort: { field: state.sort.field === "login" ? ("lastLogin" as const) : ("name" as const), direction: state.sort.direction },
});

/** The address of a state, plus its page. */
export const usersHref = (query: UsersQuery, state: UsersState, page = 1): string => {
  const params = query.serialize(state);
  if (page > 1) params.set("page", String(page));
  const text = params.toString();
  return text ? `${USERS_PAGE_PATH}?${text}` : USERS_PAGE_PATH;
};

// As the list's own addresses (`serialize`): `,` `:` `/` and `@` stay readable, every other sign stays encoded.
const readable = (params: URLSearchParams) => params.toString().replace(/%(?:2C|3A|2F|40)/gi, (escape) => decodeURIComponent(escape));

/**
 * The v2 parameters for pre-v2 ones, or null when there are none: `search` became `q`, and `profile` (full or guest
 * account) became the role. Every other parameter is carried over; a v2 name that is already there wins.
 */
export const legacyUsersParams = (params: URLSearchParams): URLSearchParams | null => {
  if (!params.has("search") && !params.has("profile")) return null;
  const next = new URLSearchParams();
  for (const [name, value] of params) if (name !== "search" && name !== "profile") next.append(name, value);
  const search = params.get("search")?.trim();
  if (search && !params.has("q")) next.set("q", search);
  const profile = params.get("profile");
  if (!params.has("role") && profile === "user") next.set("role", "admin,member");
  if (!params.has("role") && profile === "guest") next.set("role", "guest");
  return next;
};

/** The v2 address for a pre-v2 one (bookmarks, old links), or null when the address is already v2. */
export const legacyUsersHref = (params: URLSearchParams): string | null => {
  const next = legacyUsersParams(params);
  if (!next) return null;
  const text = readable(next);
  return text ? `${USERS_PAGE_PATH}?${text}` : USERS_PAGE_PATH;
};

/**
 * The list a user's page leads back to, as the list's search text ("" for the plain list). A row carries the list's
 * whole address in one `list` parameter; an old link carries the pre-v2 names beside the page's own. Both pass the
 * declaration, so only an address of this list comes back.
 */
export const usersListContext = (query: UsersQuery, params: URLSearchParams): string => {
  const list = params.get("list");
  const source = list !== null ? new URLSearchParams(list) : (legacyUsersParams(params) ?? params);
  const address = parseUsersAddress(query, source);
  const href = usersHref(query, address.state, address.page);
  return href.slice(USERS_PAGE_PATH.length).replace(/^\?/, "");
};

/** The list address for a list context from `usersListContext`. */
export const usersListHref = (context: string): string => (context ? `${USERS_PAGE_PATH}?${context}` : USERS_PAGE_PATH);

/** A user's page, carrying the list context it was opened from. */
export const userDetailHref = (id: string, context: string): string =>
  context ? `${USERS_PAGE_PATH}/${id}?${new URLSearchParams({ list: context })}` : `${USERS_PAGE_PATH}/${id}`;
