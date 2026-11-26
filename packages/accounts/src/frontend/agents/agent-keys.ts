/** The address of an agent's record: the one account record of every kind. */
export const agentRecordHref = (agentId: string): string => `/app/accounts/users/${agentId}`;

/**
 * Where an agent's page from before the one account record leads: `/app/accounts/agents/:id?…` becomes the record at
 * `/app/accounts/users/:id`. Its keys now live in the record's key section, which opens a key and a new key in place
 * and pages through the API itself, so the old `key`, `sort` and `page` parameters (and anything else) fall away.
 */
export const legacyAgentHref = (agentId: string, _params: URLSearchParams): string => agentRecordHref(agentId);
