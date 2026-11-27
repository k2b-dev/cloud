import type { ProxyAuthClient } from "@/contracts";

/**
 * Whether a client matches a search: its name, its client ID, its description or the name of one of its groups, case
 * ignored. The service's list and every page that lists clients search with this one rule.
 */
export const matchesClientSearch = (client: ProxyAuthClient, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [client.name, client.clientId, client.description ?? "", ...client.allowedGroups.map((group) => group.name)].some((value) =>
    value.toLowerCase().includes(needle),
  );
};
