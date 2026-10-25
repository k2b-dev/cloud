export type QueryKeys = {
  search: string;
  page: string;
  provider?: string;
  profile?: string;
};

export type GroupQueryKeys = QueryKeys & {
  scope: string;
};

const USERS_QUERY_KEYS: QueryKeys = {
  search: "search",
  page: "page",
  provider: "provider",
  profile: "profile",
};

const GROUPS_QUERY_KEYS: GroupQueryKeys = {
  search: "search",
  page: "page",
  provider: "provider",
  scope: "scope",
};

/**
 * Group list state keys used inside group-detail routes.
 * This keeps list context separate from tab-local query params.
 */
export const GROUPS_CONTEXT_QUERY_KEYS: GroupQueryKeys = {
  search: "list_search",
  page: "list_page",
  provider: "list_provider",
  scope: "list_scope",
};

export type UsersListState = {
  search: string;
  page: number;
  provider: "" | "local" | "ipa";
  profile: "" | "user" | "guest";
};

export type GroupsListState = {
  search: string;
  page: number;
  provider: "" | "local" | "ipa";
  scope: "managed" | "member" | "all";
};

type GroupsStateOptions = {
  defaultScope?: GroupsListState["scope"];
  keys?: GroupQueryKeys;
};

const parsePage = (value: number | string | null | undefined): number => {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
  if (!value) return 1;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};

const normalizeSearch = (value: string | null | undefined): string => (value ?? "").trim();

const toHref = (basePath: string, searchParams: URLSearchParams): string => {
  const query = searchParams.toString();
  return query.length > 0 ? `${basePath}?${query}` : basePath;
};

const writeIfNonDefault = (params: URLSearchParams, key: string, value: string, defaultValue: string): void => {
  if (value === defaultValue) {
    params.delete(key);
    return;
  }
  params.set(key, value);
};

export const parseUsersListState = (input: {
  search?: string | null;
  page?: number | string | null;
  provider?: string | null;
  profile?: string | null;
}): UsersListState => ({
  search: normalizeSearch(input.search),
  page: parsePage(input.page),
  provider: input.provider === "local" || input.provider === "ipa" ? input.provider : "",
  profile: input.profile === "user" || input.profile === "guest" ? input.profile : "",
});

const parseUsersListStateFromParams = (params: URLSearchParams, keys: QueryKeys = USERS_QUERY_KEYS): UsersListState =>
  parseUsersListState({
    search: params.get(keys.search),
    page: params.get(keys.page),
    provider: keys.provider ? params.get(keys.provider) : null,
    profile: keys.profile ? params.get(keys.profile) : null,
  });

const writeUsersListState = (params: URLSearchParams, state: UsersListState, keys: QueryKeys = USERS_QUERY_KEYS): void => {
  writeIfNonDefault(params, keys.search, state.search, "");
  writeIfNonDefault(params, keys.page, String(state.page), "1");
  if (keys.provider) writeIfNonDefault(params, keys.provider, state.provider, "");
  if (keys.profile) writeIfNonDefault(params, keys.profile, state.profile, "");
};

export const buildUsersUrl = (
  state: UsersListState,
  options: {
    basePath?: string;
    keys?: QueryKeys;
  } = {},
): string => {
  const params = new URLSearchParams();
  writeUsersListState(params, state, options.keys ?? USERS_QUERY_KEYS);
  return toHref(options.basePath ?? "/app/accounts/users", params);
};

export const buildUsersPageBaseUrl = (
  state: Pick<UsersListState, "search" | "provider" | "profile">,
  options: {
    basePath?: string;
    keys?: QueryKeys;
  } = {},
): string => {
  const params = new URLSearchParams();
  const keys = options.keys ?? USERS_QUERY_KEYS;
  writeIfNonDefault(params, keys.search, state.search, "");
  if (keys.provider) writeIfNonDefault(params, keys.provider, state.provider, "");
  if (keys.profile) writeIfNonDefault(params, keys.profile, state.profile, "");
  const query = params.toString();
  const basePath = options.basePath ?? "/app/accounts/users";
  return query.length > 0 ? `${basePath}?${query}&${keys.page}=` : `${basePath}?${keys.page}=`;
};

export const buildUserDetailUrl = (
  userId: string,
  state: UsersListState,
  options: {
    basePath?: string;
    keys?: QueryKeys;
  } = {},
): string => {
  const basePath = options.basePath ?? `/app/accounts/users/${userId}`;
  const params = new URLSearchParams();
  writeUsersListState(params, state, options.keys ?? USERS_QUERY_KEYS);
  return toHref(basePath, params);
};

export const parseGroupsListState = (
  input: {
    search?: string | null;
    page?: number | string | null;
    provider?: string | null;
    scope?: string | null;
  },
  options: GroupsStateOptions = {},
): GroupsListState => {
  const defaultScope = options.defaultScope ?? "member";
  const normalizedScope = input.scope === "managed" || input.scope === "member" || input.scope === "all" ? input.scope : defaultScope;

  return {
    search: normalizeSearch(input.search),
    page: parsePage(input.page),
    provider: input.provider === "local" || input.provider === "ipa" ? input.provider : "",
    scope: normalizedScope,
  };
};

const parseGroupsListStateFromParams = (params: URLSearchParams, options: GroupsStateOptions = {}): GroupsListState => {
  const keys = options.keys ?? GROUPS_QUERY_KEYS;

  return parseGroupsListState(
    {
      search: params.get(keys.search),
      page: params.get(keys.page),
      provider: keys.provider ? params.get(keys.provider) : null,
      scope: params.get(keys.scope),
    },
    options,
  );
};

const writeGroupsListState = (params: URLSearchParams, state: GroupsListState, options: GroupsStateOptions = {}): void => {
  const keys = options.keys ?? GROUPS_QUERY_KEYS;
  const defaultScope = options.defaultScope ?? "member";

  writeIfNonDefault(params, keys.search, state.search, "");
  writeIfNonDefault(params, keys.page, String(state.page), "1");
  if (keys.provider) writeIfNonDefault(params, keys.provider, state.provider, "");
  writeIfNonDefault(params, keys.scope, state.scope, defaultScope);
};

export const buildGroupsUrl = (
  state: GroupsListState,
  options: {
    basePath?: string;
  } & GroupsStateOptions = {},
): string => {
  const params = new URLSearchParams();
  writeGroupsListState(params, state, options);
  return toHref(options.basePath ?? "/app/accounts/groups", params);
};

export const buildGroupsPageBaseUrl = (
  state: Pick<GroupsListState, "search" | "provider" | "scope">,
  options: {
    basePath?: string;
  } & GroupsStateOptions = {},
): string => {
  const keys = options.keys ?? GROUPS_QUERY_KEYS;
  const defaultScope = options.defaultScope ?? "member";
  const params = new URLSearchParams();

  writeIfNonDefault(params, keys.search, state.search, "");
  if (keys.provider) writeIfNonDefault(params, keys.provider, state.provider, "");
  writeIfNonDefault(params, keys.scope, state.scope, defaultScope);

  const query = params.toString();
  const basePath = options.basePath ?? "/app/accounts/groups";
  return query.length > 0 ? `${basePath}?${query}&${keys.page}=` : `${basePath}?${keys.page}=`;
};

export const buildGroupDetailUrl = (
  groupId: string,
  state: GroupsListState,
  options: {
    basePath?: string;
  } & GroupsStateOptions = {},
): string => {
  const basePath = options.basePath ?? `/app/accounts/groups/${groupId}`;
  const params = new URLSearchParams();
  writeGroupsListState(params, state, options);
  return toHref(basePath, params);
};
