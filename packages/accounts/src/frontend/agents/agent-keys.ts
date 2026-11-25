/** What an agent's page shows of one API key; never the token, which exists only in the answer that created it. */
export type AgentKey = {
  id: string;
  name: string;
  tokenPrefix: string;
  access: "full" | "models" | "legacy";
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
};

export const AGENT_KEY_SORTS = ["created", "name", "used"] as const;
export type AgentKeySort = (typeof AGENT_KEY_SORTS)[number];

/** The sort named in the address (`?sort=`), or the newest first. */
export const agentKeySortFrom = (value: string | undefined): AgentKeySort => AGENT_KEY_SORTS.find((sort) => sort === value) ?? "created";

/** A key past its end works no more, although its status still says active. */
export const isAgentKeyExpired = (key: Pick<AgentKey, "expiresAt">, now: Date): boolean =>
  key.expiresAt !== null && new Date(key.expiresAt).getTime() <= now.getTime();

const byNewest = (a: string, b: string) => b.localeCompare(a);

/**
 * The keys in the chosen order: newest first; by name (A–Z, then newest); or by last use (most recent first, never used
 * at the end, then newest). The order is total, so a reload shows the same list.
 */
export const sortAgentKeys = (keys: readonly AgentKey[], sort: AgentKeySort, locale: string): AgentKey[] => {
  const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
  const tie = (a: AgentKey, b: AgentKey) => byNewest(a.createdAt, b.createdAt) || a.id.localeCompare(b.id);
  const compare: Record<AgentKeySort, (a: AgentKey, b: AgentKey) => number> = {
    created: tie,
    name: (a, b) => collator.compare(a.name, b.name) || tie(a, b),
    used: (a, b) =>
      a.lastUsedAt === b.lastUsedAt
        ? tie(a, b)
        : a.lastUsedAt === null
          ? 1
          : b.lastUsedAt === null
            ? -1
            : byNewest(a.lastUsedAt, b.lastUsedAt) || tie(a, b),
  };
  return [...keys].sort(compare[sort]);
};

/** What an agent's page has open, from its address: nothing, the form for a new key, or one key. */
export type AgentKeyOpen = { kind: "none" } | { kind: "new" } | { kind: "key"; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const agentKeyOpenFrom = (value: string | undefined): AgentKeyOpen =>
  value === "new" ? { kind: "new" } : value && UUID.test(value) ? { kind: "key", id: value.toLowerCase() } : { kind: "none" };

/** Keys one page of an agent's record lists: one page of the service, so the page stays light at any count. */
export const AGENT_KEYS_PER_PAGE = 100;

/** The page named in the address (`?page=`), 1 when it names none or nonsense. */
export const agentKeyPageFrom = (value: string | undefined): number => {
  const page = Number(value);
  return Number.isInteger(page) && page > 1 && page <= 100_000 ? page : 1;
};

/** The address of an agent's record (the one account record of every kind): the sort stays when something opens or
 * closes; the newest first is left out. */
export const agentPageHref = (agentId: string, state: { sort: AgentKeySort; open?: "new" | string; page?: number }): string => {
  const params = new URLSearchParams();
  if (state.page && state.page > 1) params.set("page", String(state.page));
  if (state.sort !== "created") params.set("sort", state.sort);
  if (state.open) params.set("key", state.open);
  const query = params.toString();
  return `/app/accounts/users/${agentId}${query ? `?${query}` : ""}`;
};

/**
 * Where an agent's page from before the one account record leads: `/app/accounts/agents/:id?…` becomes the record at
 * `/app/accounts/users/:id` with the same sort and open key; parameters the record does not read are dropped.
 */
export const legacyAgentHref = (agentId: string, params: URLSearchParams): string => {
  const open = params.get("key") ?? undefined;
  const key = agentKeyOpenFrom(open);
  return agentPageHref(agentId, {
    sort: agentKeySortFrom(params.get("sort") ?? undefined),
    open: key.kind === "new" ? "new" : key.kind === "key" ? key.id : undefined,
  });
};
