/**
 * The API key list's one declaration: its type, status and automatic-key filters, the search and the page. The SSR page
 * reads and the browser writes the address only through it. The service filters (`serviceAccountCredentials`); there
 * are no saved views and one fixed order, the newest key first, as the service sorts.
 *
 * The parameters stay those of the list before v2 (`kind`, `status`, `automatic=1`, `page`); only the search moved
 * from `search` to `q`, and an old address is redirected with all its parameters.
 */
import { defineListQuery, field, type ListQueryIssue, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import { accountsMessages } from "../messages";
import { apiKeyMessages } from "./messages";

export const API_KEYS_PATH = "/app/accounts/api-keys";
/** Keys per page, as before v2. */
export const API_KEYS_PER_PAGE = 100;
/** Longest free search; a longer text is dropped and reported, never cut silently. */
export const API_KEYS_SEARCH_MAX = 200;
/** Last page the list opens. */
export const API_KEYS_PAGE_MAX = 1000;

export type ApiKeyKind = "user_delegated" | "resource_bound" | "agent";

/** Builds the declaration in the request's language. */
export const apiKeysQuery = (locale: string) => {
  const { t } = accountsMessages.resolve([locale]);
  const words = apiKeyMessages.resolve([locale]).t;
  return defineListQuery({
    key: "accounts.api-keys",
    fields: {
      kind: field.choice({
        label: words.kind,
        common: true,
        multiple: false,
        options: [
          { value: "user_delegated", label: t.userBound },
          { value: "resource_bound", label: t.resourceBound },
          { value: "agent", label: t.agent },
        ] satisfies { value: ApiKeyKind; label: string }[],
      }),
      status: field.choice({
        label: t.status,
        common: true,
        multiple: false,
        options: [
          { value: "active", label: t.active },
          { value: "revoked", label: t.revoked },
        ],
        required: "active",
      }),
      // `automatic=1`, the address of the list before v2: the keys apps rotate themselves are hidden unless named
      automatic: field.choice({
        label: words.automatic,
        op: words.automaticOp,
        multiple: false,
        options: [{ value: "1", label: words.automaticShown }],
      }),
    },
    search: { label: t.searchServiceAccountsLabel },
    sort: { fixed: { field: "created", direction: "desc", label: words.newestFirst } },
    pageParams: ["page"],
  });
};

export type ApiKeysQuery = ReturnType<typeof apiKeysQuery>;
export type ApiKeysState = ListQueryStateOf<ApiKeysQuery>;

/** Reads an address with the declaration and holds every value to the list's bounds. Never throws. */
export const parseApiKeysAddress = (
  query: ApiKeysQuery,
  params: URLSearchParams,
): { state: ApiKeysState; page: number; issues: readonly ListQueryIssue[] } => {
  const parsed = query.parse(params);
  const issues: ListQueryIssue[] = [...parsed.issues];
  let state = parsed.state;
  if (state.search && state.search.length > API_KEYS_SEARCH_MAX) {
    issues.push({ code: "invalid", param: "q", value: state.search });
    state = { ...state, search: undefined };
  }
  if (state.view !== undefined) {
    issues.push({ code: "invalid", param: "view", value: state.view });
    state = { ...state, view: undefined };
  }
  const pageRaw = params.get("page");
  const page = pageRaw === null ? 1 : Number(pageRaw);
  const valid = Number.isSafeInteger(page) && page >= 1 && page <= API_KEYS_PAGE_MAX;
  if (!valid) issues.push({ code: "invalid", param: "page", value: pageRaw ?? "" });
  return { state, page: valid ? page : 1, issues };
};

/** The address of a state, plus its page. */
export const apiKeysHref = (query: ApiKeysQuery, state: ApiKeysState, page = 1): string => {
  const params = query.serialize(state);
  if (page > 1) params.set("page", String(page));
  const text = params.toString();
  return text ? `${API_KEYS_PATH}?${text}` : API_KEYS_PATH;
};

// As the list's own addresses (`serialize`): `,` `:` `/` and `@` stay readable, every other sign stays encoded.
const readable = (params: URLSearchParams) => params.toString().replace(/%(?:2C|3A|2F|40)/gi, (escape) => decodeURIComponent(escape));

/**
 * The v2 address of this list for a pre-v2 one, or null when it is already v2: `search` became `q`, and the
 * standalone kind of older links is "agent". Every other parameter is carried over. (Used while the list still has
 * its own route; see `legacyApiKeysHref` for where its addresses lead once the account list holds it.)
 */
export const legacyApiKeyListHref = (params: URLSearchParams): string | null => {
  const standalone = params.get("kind") === "standalone";
  if (!params.has("search") && !standalone) return null;
  const next = new URLSearchParams();
  for (const [name, value] of params) {
    if (name === "search") continue;
    next.append(name, name === "kind" && value === "standalone" ? "agent" : value);
  }
  const search = params.get("search")?.trim();
  if (search && !params.has("q")) next.set("q", search);
  const text = readable(next);
  return text ? `${API_KEYS_PATH}?${text}` : API_KEYS_PATH;
};

/** The one account list, which lists people, agents and the other service accounts. */
export const ACCOUNT_LIST_PATH = "/app/accounts/users";

/** The kind codes of the account list for the API key list's `kind`: the kind of the account a key belongs to. */
const ACCOUNT_KINDS: Readonly<Record<string, string>> = {
  user_delegated: "person",
  agent: "agent",
  standalone: "agent",
  resource_bound: "api-key",
};

/**
 * Where an address of the API key list (`/app/accounts/api-keys?…`, and the older `/service-accounts?…`) leads now
 * that the account list lists the accounts and each account's record shows its keys: the account list with the same
 * search and the kind of account the keys belonged to. A key's status and the automatic app keys describe keys, not
 * accounts, so they and the page are left out; an unknown kind is left out rather than guessed.
 */
export const legacyApiKeysHref = (params: URLSearchParams): string => {
  const next = new URLSearchParams();
  const kind = ACCOUNT_KINDS[params.get("kind") ?? ""];
  if (kind) next.set("kind", kind);
  const search = (params.get("q") ?? params.get("search") ?? "").trim();
  if (search) next.set("q", search);
  const text = readable(next);
  return text ? `${ACCOUNT_LIST_PATH}?${text}` : ACCOUNT_LIST_PATH;
};
