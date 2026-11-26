/**
 * Where the addresses of the former API key list lead. The list is gone: the account list (`/app/accounts/users`) lists
 * people, agents and the other service accounts, and each account's record shows its keys.
 */

/** The one account list, which lists people, agents and the other service accounts. */
export const ACCOUNT_LIST_PATH = "/app/accounts/users";

/**
 * The kind codes of the account list for the API key list's `kind`, the kind of the account a key belonged to: a
 * personal key belongs to a person, an agent's (and a legacy standalone account's) to an agent, and a resource-bound
 * key to an API key account.
 */
const ACCOUNT_KINDS: Readonly<Record<string, string>> = {
  user_delegated: "person",
  agent: "agent",
  standalone: "agent",
  resource_bound: "api-key",
};

// As the list's own addresses: `,` `:` `/` and `@` stay readable, every other sign stays encoded.
const readable = (params: URLSearchParams) => params.toString().replace(/%(?:2C|3A|2F|40)/gi, (escape) => decodeURIComponent(escape));

/**
 * Where an address of the API key list (`/app/accounts/api-keys?…`, and the older `/service-accounts?…`) leads: the
 * account list with the same search and the kind of account the keys belonged to. A key's status and the automatic app
 * keys describe keys, not accounts, so they and the page are left out; an unknown kind is left out rather than guessed.
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
