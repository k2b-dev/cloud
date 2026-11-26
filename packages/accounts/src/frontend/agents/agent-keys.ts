/** The address of an agent's record: the one account record of every kind. */
export const agentRecordHref = (agentId: string): string => `/app/accounts/users/${agentId}`;

/**
 * Where an agent's page from before the one account record leads: `/app/accounts/agents/:id?…` becomes the record at
 * `/app/accounts/users/:id`. The open key (`key`: a key's id, or `new` for a new key) stays, so an old link still
 * opens it in the record's key section; any other value, `sort`, `page` and the rest fall away, as the section pages
 * and orders its keys itself.
 */
const KEY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const legacyAgentHref = (agentId: string, params: URLSearchParams): string => {
  const key = params.get("key")?.toLowerCase();
  return key === "new" || (key && KEY_ID.test(key)) ? `${agentRecordHref(agentId)}?key=${key}` : agentRecordHref(agentId);
};
