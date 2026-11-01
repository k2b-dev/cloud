/** An app's domain as `GET /api/admin/apps/:appId/domains` returns it. */
export type AppDomainEntry = {
  host: string;
  redirectTo: string | null;
  createdAt: string;
  active: boolean;
  status: {
    checkedAt: string;
    dns: { ok: boolean; detail: string };
    certificate: { ok: boolean; detail: string } | null;
    reachable: { ok: boolean; detail: string } | null;
  } | null;
};

/** The minimum time between two checks of one domain; the API answers the last result within it. */
export const CHECK_INTERVAL_MS = 60_000;

/** Domains that answer themselves: the targets a redirect may point to. */
export const primaries = (domains: readonly AppDomainEntry[]) => domains.filter((domain) => domain.redirectTo === null);
export const aliasesOf = (domains: readonly AppDomainEntry[], host: string) => domains.filter((domain) => domain.redirectTo === host);

/** All three steps passed; a step not reached yet (`null`) or a failed one is a problem to show. */
export const domainHealthy = (domain: AppDomainEntry) =>
  Boolean(domain.status?.dns.ok && domain.status.certificate?.ok && domain.status.reachable?.ok);

/**
 * The redirect changes that make `host` the primary domain of its group, in an order the API accepts at every step:
 * the new primary stops redirecting, the old primary's other aliases move over, and the old primary redirects last,
 * once nothing points to it any more.
 */
export const makePrimaryPlan = (domains: readonly AppDomainEntry[], host: string): Array<{ host: string; redirectTo: string | null }> => {
  const domain = domains.find((entry) => entry.host === host);
  if (!domain?.redirectTo) return [];
  const old = domain.redirectTo;
  return [
    { host, redirectTo: null },
    ...aliasesOf(domains, old)
      .filter((alias) => alias.host !== host)
      .map((alias) => ({ host: alias.host, redirectTo: host })),
    { host: old, redirectTo: host },
  ];
};

/** When a check may run again: 60 s after the last result. Without a result, now. */
export const nextCheckAt = (domain: AppDomainEntry, clickedAt: number | undefined) =>
  Math.max(domain.status ? Date.parse(domain.status.checkedAt) : 0, clickedAt ?? 0) + CHECK_INTERVAL_MS;
