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

/** The address of an agent's page: the sort stays when something opens or closes; the newest first is left out. */
export const agentPageHref = (agentId: string, state: { sort: AgentKeySort; open?: "new" | string }): string => {
  const params = new URLSearchParams();
  if (state.sort !== "created") params.set("sort", state.sort);
  if (state.open) params.set("key", state.open);
  const query = params.toString();
  return `/app/accounts/agents/${agentId}${query ? `?${query}` : ""}`;
};
