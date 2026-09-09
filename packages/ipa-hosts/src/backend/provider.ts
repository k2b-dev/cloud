import { sql } from "bun";
import { freeipa } from "@k2b/cloud/server/services";
import { getFreeIpaConfig } from "@k2b/cloud/services";

type DbRow = Record<string, unknown>;
const disabledResult = (): IpaHostsMutationResult => ({ ok: false, error: "FreeIPA is disabled.", status: 500 });
const getIpaUrl = async (): Promise<string | null> => {
  const config = await getFreeIpaConfig();
  return config.enabled ? config.url : null;
};

export type IpaHostsMutationResult = { ok: true } | { ok: false; error: string; status: 400 | 401 | 403 | 404 | 500 };

export type IpaHostRecord = {
  fqdn: string;
  description: string | null;
  location: string | null;
  locality: string | null;
  memberofHostgroup: string[];
  macAddress: string[];
  platform: string | null;
  osVersion: string | null;
  sshFingerprints: string[];
};

export type IpaHostgroupRecord = {
  cn: string;
  description: string | null;
  hosts: string[];
  hostgroups: string[];
};

export type IpaHostgroupWithHostsRecord = IpaHostgroupRecord & {
  hostDetails: IpaHostRecord[];
};

const toHost = (row: DbRow): IpaHostRecord => ({
  fqdn: row.fqdn as string,
  description: (row.description as string) ?? null,
  location: (row.location as string) ?? null,
  locality: (row.locality as string) ?? null,
  memberofHostgroup: (row.hostgroups as string[]) ?? [],
  macAddress: (row.mac_address as string[]) ?? [],
  platform: (row.platform as string) ?? null,
  osVersion: (row.os_version as string) ?? null,
  sshFingerprints: (row.ssh_fingerprints as string[]) ?? [],
});

const toHostgroup = (row: DbRow): IpaHostgroupRecord => ({
  cn: row.cn as string,
  description: (row.description as string) ?? null,
  hosts: (row.member_hosts as string[]) ?? [],
  hostgroups: (row.member_hostgroups as string[]) ?? [],
});

const toHostFromPayload = (value: unknown): IpaHostRecord => {
  const record = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    fqdn: String(record.fqdn ?? ""),
    description: typeof record.description === "string" ? record.description : null,
    location: typeof record.location === "string" ? record.location : null,
    locality: typeof record.locality === "string" ? record.locality : null,
    memberofHostgroup: Array.isArray(record.hostgroups) ? record.hostgroups.map(String) : [],
    macAddress: Array.isArray(record.mac_address) ? record.mac_address.map(String) : [],
    platform: typeof record.platform === "string" ? record.platform : null,
    osVersion: typeof record.os_version === "string" ? record.os_version : null,
    sshFingerprints: Array.isArray(record.ssh_fingerprints) ? record.ssh_fingerprints.map(String) : [],
  };
};

const toHostgroupWithHosts = (row: DbRow): IpaHostgroupWithHostsRecord => ({
  ...toHostgroup(row),
  hostDetails: Array.isArray(row.host_details) ? row.host_details.map(toHostFromPayload) : [],
});

const toLike = (value?: string): string | null => {
  const normalized = value?.trim().toLowerCase();
  return normalized ? `%${freeipa.util.escapeLike(normalized)}%` : null;
};

export const hostList = async (params: {
  search?: string;
  page?: number;
  perPage?: number;
}): Promise<{ hosts: IpaHostRecord[]; total: number }> => {
  const page = params.page ?? 1;
  const perPage = params.perPage ?? 100;
  const offset = (page - 1) * perPage;
  const search = toLike(params.search);

  const [countRows, rows] = await Promise.all([
    search
      ? sql<DbRow[]>`
          SELECT COUNT(*)::int AS count
          FROM ipa_hosts.hosts h
          WHERE LOWER(h.fqdn) LIKE ${search} ESCAPE '\\'
             OR LOWER(COALESCE(h.description, '')) LIKE ${search} ESCAPE '\\'
             OR LOWER(COALESCE(h.locality, '')) LIKE ${search} ESCAPE '\\'
             OR LOWER(COALESCE(h.location, '')) LIKE ${search} ESCAPE '\\'
        `
      : sql<DbRow[]>`SELECT COUNT(*)::int AS count FROM ipa_hosts.hosts`,
    search
      ? sql<DbRow[]>`
          SELECT h.*,
            COALESCE(ARRAY(SELECT hostgroup_cn FROM ipa_hosts.host_hostgroups WHERE host_fqdn = h.fqdn), '{}') AS hostgroups
          FROM ipa_hosts.hosts h
          WHERE LOWER(h.fqdn) LIKE ${search} ESCAPE '\\'
             OR LOWER(COALESCE(h.description, '')) LIKE ${search} ESCAPE '\\'
             OR LOWER(COALESCE(h.locality, '')) LIKE ${search} ESCAPE '\\'
             OR LOWER(COALESCE(h.location, '')) LIKE ${search} ESCAPE '\\'
          ORDER BY h.fqdn
          LIMIT ${perPage} OFFSET ${offset}
        `
      : sql<DbRow[]>`
          SELECT h.*,
            COALESCE(ARRAY(SELECT hostgroup_cn FROM ipa_hosts.host_hostgroups WHERE host_fqdn = h.fqdn), '{}') AS hostgroups
          FROM ipa_hosts.hosts h
          ORDER BY h.fqdn
          LIMIT ${perPage} OFFSET ${offset}
        `,
  ]);

  return {
    hosts: rows.map(toHost),
    total: Number(countRows[0]?.count ?? 0),
  };
};

export const hostListUngrouped = async (params: {
  search?: string;
  page?: number;
  perPage?: number;
}): Promise<{ hosts: IpaHostRecord[]; total: number }> => {
  const page = params.page ?? 1;
  const perPage = params.perPage ?? 100;
  const offset = (page - 1) * perPage;
  const search = toLike(params.search);

  const searchFilter = search
    ? sql`
        AND (
          LOWER(h.fqdn) LIKE ${search} ESCAPE '\\'
          OR LOWER(COALESCE(h.description, '')) LIKE ${search} ESCAPE '\\'
          OR LOWER(COALESCE(h.locality, '')) LIKE ${search} ESCAPE '\\'
          OR LOWER(COALESCE(h.location, '')) LIKE ${search} ESCAPE '\\'
        )
      `
    : sql``;

  const [countRows, rows] = await Promise.all([
    sql<DbRow[]>`
      SELECT COUNT(*)::int AS count
      FROM ipa_hosts.hosts h
      WHERE NOT EXISTS (
        SELECT 1
        FROM ipa_hosts.host_hostgroups hh
        WHERE hh.host_fqdn = h.fqdn
      )
      ${searchFilter}
    `,
    sql<DbRow[]>`
      SELECT h.*, '{}'::text[] AS hostgroups
      FROM ipa_hosts.hosts h
      WHERE NOT EXISTS (
        SELECT 1
        FROM ipa_hosts.host_hostgroups hh
        WHERE hh.host_fqdn = h.fqdn
      )
      ${searchFilter}
      ORDER BY h.fqdn
      LIMIT ${perPage} OFFSET ${offset}
    `,
  ]);

  return {
    hosts: rows.map(toHost),
    total: Number(countRows[0]?.count ?? 0),
  };
};

/**
 * Aggregated dashboard stats — single SQL roundtrip across the mirror tables.
 * Counts are over the full DB, NOT the visible page. `hostsInGroups` counts
 * distinct hosts that have at least one group membership (semantic match for
 * "X out of Y hosts are assigned").
 */
export const hostStats = async (): Promise<{
  hostsTotal: number;
  hostsInGroups: number;
  hostsUngrouped: number;
  hostgroupsTotal: number;
}> => {
  const [row] = await sql<
    {
      hosts_total: number;
      hosts_in_groups: number;
      hosts_ungrouped: number;
      hostgroups_total: number;
    }[]
  >`
    SELECT
      (SELECT COUNT(*)::int FROM ipa_hosts.hosts)                                                  AS hosts_total,
      (SELECT COUNT(DISTINCT host_fqdn)::int FROM ipa_hosts.host_hostgroups)                       AS hosts_in_groups,
      (SELECT COUNT(*)::int FROM ipa_hosts.hosts h
        WHERE NOT EXISTS (SELECT 1 FROM ipa_hosts.host_hostgroups hh WHERE hh.host_fqdn = h.fqdn)) AS hosts_ungrouped,
      (SELECT COUNT(*)::int FROM ipa_hosts.hostgroups)                                             AS hostgroups_total
  `;
  return {
    hostsTotal: row?.hosts_total ?? 0,
    hostsInGroups: row?.hosts_in_groups ?? 0,
    hostsUngrouped: row?.hosts_ungrouped ?? 0,
    hostgroupsTotal: row?.hostgroups_total ?? 0,
  };
};

export const hostMod = async (
  ipaSession: string,
  fqdn: string,
  opts: { location?: string; locality?: string; description?: string; macAddress?: string[] },
): Promise<IpaHostsMutationResult> => {
  const ipaOpts: Record<string, unknown> = {};
  if (opts.location !== undefined) ipaOpts.nshostlocation = opts.location;
  if (opts.locality !== undefined) ipaOpts.l = opts.locality;
  if (opts.description !== undefined) ipaOpts.description = opts.description;
  if (opts.macAddress !== undefined) ipaOpts.macaddress = opts.macAddress;
  if (Object.keys(ipaOpts).length === 0) return { ok: true };

  const url = await getIpaUrl();
  if (!url) return disabledResult();
  const response = await freeipa.client.call({ url, ipaSession, method: "host_mod", args: [fqdn], options: ipaOpts });
  if (response.error) {
    return { ok: false, error: response.error.message, status: freeipa.util.mapIpaErrorCode(response.error.code) };
  }

  await sql.begin(async (tx) => {
    if (opts.description !== undefined) {
      await tx`UPDATE ipa_hosts.hosts SET description = ${opts.description} WHERE fqdn = ${fqdn}`;
    }
    if (opts.location !== undefined) {
      await tx`UPDATE ipa_hosts.hosts SET location = ${opts.location} WHERE fqdn = ${fqdn}`;
    }
    if (opts.locality !== undefined) {
      await tx`UPDATE ipa_hosts.hosts SET locality = ${opts.locality} WHERE fqdn = ${fqdn}`;
    }
    if (opts.macAddress !== undefined) {
      await tx`UPDATE ipa_hosts.hosts SET mac_address = ${freeipa.util.toPgTextArray(opts.macAddress)}::text[] WHERE fqdn = ${fqdn}`;
    }
    await tx`UPDATE ipa_hosts.hosts SET synced_at = now() WHERE fqdn = ${fqdn}`;
  });

  return { ok: true };
};

export const hostDel = async (ipaSession: string, fqdn: string): Promise<IpaHostsMutationResult> => {
  const url = await getIpaUrl();
  if (!url) return disabledResult();
  const response = await freeipa.client.call({ url, ipaSession, method: "host_del", args: [fqdn], options: {} });
  if (response.error) {
    return { ok: false, error: response.error.message, status: freeipa.util.mapIpaErrorCode(response.error.code) };
  }

  await sql`DELETE FROM ipa_hosts.hosts WHERE fqdn = ${fqdn}`;
  return { ok: true };
};

export const hostAddToGroup = async (ipaSession: string, fqdn: string, hostgroupCn: string): Promise<IpaHostsMutationResult> => {
  const url = await getIpaUrl();
  if (!url) return disabledResult();
  const response = await freeipa.client.call({
    url,
    ipaSession,
    method: "hostgroup_add_member",
    args: [hostgroupCn],
    options: { host: fqdn },
  });
  if (response.error) {
    return { ok: false, error: response.error.message, status: freeipa.util.mapIpaErrorCode(response.error.code) };
  }

  await sql`
    INSERT INTO ipa_hosts.host_hostgroups (host_fqdn, hostgroup_cn)
    VALUES (${fqdn}, ${hostgroupCn})
    ON CONFLICT DO NOTHING
  `;
  return { ok: true };
};

export const hostRemoveFromGroup = async (ipaSession: string, fqdn: string, hostgroupCn: string): Promise<IpaHostsMutationResult> => {
  const url = await getIpaUrl();
  if (!url) return disabledResult();
  const response = await freeipa.client.call({
    url,
    ipaSession,
    method: "hostgroup_remove_member",
    args: [hostgroupCn],
    options: { host: fqdn },
  });
  if (response.error) {
    return { ok: false, error: response.error.message, status: freeipa.util.mapIpaErrorCode(response.error.code) };
  }

  await sql`DELETE FROM ipa_hosts.host_hostgroups WHERE host_fqdn = ${fqdn} AND hostgroup_cn = ${hostgroupCn}`;
  return { ok: true };
};

export const hostgroupList = async (params: {
  search?: string;
  page?: number;
  perPage?: number;
}): Promise<{ hostgroups: IpaHostgroupRecord[]; total: number }> => {
  const page = params.page ?? 1;
  const perPage = params.perPage ?? 100;
  const offset = (page - 1) * perPage;
  const search = toLike(params.search);

  const [countRows, rows] = await Promise.all([
    search
      ? sql<DbRow[]>`
          SELECT COUNT(*)::int AS count
          FROM ipa_hosts.hostgroups hg
          WHERE LOWER(hg.cn) LIKE ${search} ESCAPE '\\'
             OR LOWER(COALESCE(hg.description, '')) LIKE ${search} ESCAPE '\\'
        `
      : sql<DbRow[]>`SELECT COUNT(*)::int AS count FROM ipa_hosts.hostgroups`,
    search
      ? sql<DbRow[]>`
          SELECT hg.*,
            COALESCE(ARRAY(SELECT host_fqdn FROM ipa_hosts.host_hostgroups WHERE hostgroup_cn = hg.cn), '{}') AS member_hosts,
            COALESCE(ARRAY(SELECT child_cn FROM ipa_hosts.hostgroup_hostgroups WHERE parent_cn = hg.cn), '{}') AS member_hostgroups
          FROM ipa_hosts.hostgroups hg
          WHERE LOWER(hg.cn) LIKE ${search} ESCAPE '\\'
             OR LOWER(COALESCE(hg.description, '')) LIKE ${search} ESCAPE '\\'
          ORDER BY hg.cn
          LIMIT ${perPage} OFFSET ${offset}
        `
      : sql<DbRow[]>`
          SELECT hg.*,
            COALESCE(ARRAY(SELECT host_fqdn FROM ipa_hosts.host_hostgroups WHERE hostgroup_cn = hg.cn), '{}') AS member_hosts,
            COALESCE(ARRAY(SELECT child_cn FROM ipa_hosts.hostgroup_hostgroups WHERE parent_cn = hg.cn), '{}') AS member_hostgroups
          FROM ipa_hosts.hostgroups hg
          ORDER BY hg.cn
          LIMIT ${perPage} OFFSET ${offset}
        `,
  ]);

  return {
    hostgroups: rows.map(toHostgroup),
    total: Number(countRows[0]?.count ?? 0),
  };
};

export const hostgroupListWithHosts = async (params: {
  search?: string;
  page?: number;
  perPage?: number;
}): Promise<{ hostgroups: IpaHostgroupWithHostsRecord[]; total: number }> => {
  const page = params.page ?? 1;
  const perPage = params.perPage ?? 100;
  const offset = (page - 1) * perPage;
  const search = toLike(params.search);

  const [countRows, rows] = await Promise.all([
    search
      ? sql<DbRow[]>`
          SELECT COUNT(*)::int AS count
          FROM ipa_hosts.hostgroups hg
          WHERE LOWER(hg.cn) LIKE ${search} ESCAPE '\\'
             OR LOWER(COALESCE(hg.description, '')) LIKE ${search} ESCAPE '\\'
        `
      : sql<DbRow[]>`SELECT COUNT(*)::int AS count FROM ipa_hosts.hostgroups`,
    search
      ? sql<DbRow[]>`
          WITH paged_hostgroups AS (
            SELECT hg.cn, hg.description
            FROM ipa_hosts.hostgroups hg
            WHERE LOWER(hg.cn) LIKE ${search} ESCAPE '\\'
               OR LOWER(COALESCE(hg.description, '')) LIKE ${search} ESCAPE '\\'
            ORDER BY hg.cn
            LIMIT ${perPage} OFFSET ${offset}
          )
          SELECT phg.*,
            COALESCE(ARRAY(SELECT hh.host_fqdn FROM ipa_hosts.host_hostgroups hh WHERE hh.hostgroup_cn = phg.cn ORDER BY hh.host_fqdn), '{}') AS member_hosts,
            COALESCE(ARRAY(SELECT hgh.child_cn FROM ipa_hosts.hostgroup_hostgroups hgh WHERE hgh.parent_cn = phg.cn ORDER BY hgh.child_cn), '{}') AS member_hostgroups,
            COALESCE((
              SELECT jsonb_agg(
                jsonb_build_object(
                  'fqdn', h.fqdn,
                  'description', h.description,
                  'location', h.location,
                  'locality', h.locality,
                  'hostgroups', COALESCE((SELECT array_agg(hh2.hostgroup_cn ORDER BY hh2.hostgroup_cn) FROM ipa_hosts.host_hostgroups hh2 WHERE hh2.host_fqdn = h.fqdn), '{}'::text[]),
                  'mac_address', h.mac_address,
                  'platform', h.platform,
                  'os_version', h.os_version,
                  'ssh_fingerprints', h.ssh_fingerprints
                )
                ORDER BY h.fqdn
              )
              FROM ipa_hosts.host_hostgroups hh
              JOIN ipa_hosts.hosts h ON h.fqdn = hh.host_fqdn
              WHERE hh.hostgroup_cn = phg.cn
            ), '[]'::jsonb) AS host_details
          FROM paged_hostgroups phg
          ORDER BY phg.cn
        `
      : sql<DbRow[]>`
          WITH paged_hostgroups AS (
            SELECT hg.cn, hg.description
            FROM ipa_hosts.hostgroups hg
            ORDER BY hg.cn
            LIMIT ${perPage} OFFSET ${offset}
          )
          SELECT phg.*,
            COALESCE(ARRAY(SELECT hh.host_fqdn FROM ipa_hosts.host_hostgroups hh WHERE hh.hostgroup_cn = phg.cn ORDER BY hh.host_fqdn), '{}') AS member_hosts,
            COALESCE(ARRAY(SELECT hgh.child_cn FROM ipa_hosts.hostgroup_hostgroups hgh WHERE hgh.parent_cn = phg.cn ORDER BY hgh.child_cn), '{}') AS member_hostgroups,
            COALESCE((
              SELECT jsonb_agg(
                jsonb_build_object(
                  'fqdn', h.fqdn,
                  'description', h.description,
                  'location', h.location,
                  'locality', h.locality,
                  'hostgroups', COALESCE((SELECT array_agg(hh2.hostgroup_cn ORDER BY hh2.hostgroup_cn) FROM ipa_hosts.host_hostgroups hh2 WHERE hh2.host_fqdn = h.fqdn), '{}'::text[]),
                  'mac_address', h.mac_address,
                  'platform', h.platform,
                  'os_version', h.os_version,
                  'ssh_fingerprints', h.ssh_fingerprints
                )
                ORDER BY h.fqdn
              )
              FROM ipa_hosts.host_hostgroups hh
              JOIN ipa_hosts.hosts h ON h.fqdn = hh.host_fqdn
              WHERE hh.hostgroup_cn = phg.cn
            ), '[]'::jsonb) AS host_details
          FROM paged_hostgroups phg
          ORDER BY phg.cn
        `,
  ]);

  return {
    hostgroups: rows.map(toHostgroupWithHosts),
    total: Number(countRows[0]?.count ?? 0),
  };
};

export const hostgroupSearch = async (params: { query: string; exclude?: string[]; limit?: number }): Promise<IpaHostgroupRecord[]> => {
  const search = toLike(params.query);
  if (!search) return [];

  const exclude = (params.exclude ?? []).filter(Boolean);
  const limit = params.limit ?? 10;

  const rows =
    exclude.length > 0
      ? await sql<DbRow[]>`
          SELECT hg.*,
            COALESCE(ARRAY(SELECT host_fqdn FROM ipa_hosts.host_hostgroups WHERE hostgroup_cn = hg.cn), '{}') AS member_hosts,
            COALESCE(ARRAY(SELECT child_cn FROM ipa_hosts.hostgroup_hostgroups WHERE parent_cn = hg.cn), '{}') AS member_hostgroups
          FROM ipa_hosts.hostgroups hg
          WHERE (LOWER(hg.cn) LIKE ${search} ESCAPE '\\'
             OR LOWER(COALESCE(hg.description, '')) LIKE ${search} ESCAPE '\\')
            AND hg.cn <> ALL(${freeipa.util.toPgTextArray(exclude)}::text[])
          ORDER BY hg.cn
          LIMIT ${limit}
        `
      : await sql<DbRow[]>`
          SELECT hg.*,
            COALESCE(ARRAY(SELECT host_fqdn FROM ipa_hosts.host_hostgroups WHERE hostgroup_cn = hg.cn), '{}') AS member_hosts,
            COALESCE(ARRAY(SELECT child_cn FROM ipa_hosts.hostgroup_hostgroups WHERE parent_cn = hg.cn), '{}') AS member_hostgroups
          FROM ipa_hosts.hostgroups hg
          WHERE LOWER(hg.cn) LIKE ${search} ESCAPE '\\'
             OR LOWER(COALESCE(hg.description, '')) LIKE ${search} ESCAPE '\\'
          ORDER BY hg.cn
          LIMIT ${limit}
        `;

  return rows.map(toHostgroup);
};

export const hostgroupAdd = async (ipaSession: string, cn: string, opts?: { description?: string }): Promise<IpaHostsMutationResult> => {
  const ipaOpts: Record<string, unknown> = {};
  if (opts?.description !== undefined) ipaOpts.description = opts.description;

  const url = await getIpaUrl();
  if (!url) return disabledResult();
  const response = await freeipa.client.call({ url, ipaSession, method: "hostgroup_add", args: [cn], options: ipaOpts });
  if (response.error) {
    return { ok: false, error: response.error.message, status: freeipa.util.mapIpaErrorCode(response.error.code) };
  }

  await sql`
    INSERT INTO ipa_hosts.hostgroups (cn, description, synced_at)
    VALUES (${cn}, ${opts?.description ?? null}, now())
    ON CONFLICT (cn) DO UPDATE SET description = EXCLUDED.description, synced_at = now()
  `;

  return { ok: true };
};

export const hostgroupMod = async (ipaSession: string, cn: string, opts: { description?: string }): Promise<IpaHostsMutationResult> => {
  const ipaOpts: Record<string, unknown> = {};
  if (opts.description !== undefined) ipaOpts.description = opts.description;
  if (Object.keys(ipaOpts).length === 0) return { ok: true };

  const url = await getIpaUrl();
  if (!url) return disabledResult();
  const response = await freeipa.client.call({ url, ipaSession, method: "hostgroup_mod", args: [cn], options: ipaOpts });
  if (response.error) {
    return { ok: false, error: response.error.message, status: freeipa.util.mapIpaErrorCode(response.error.code) };
  }

  await sql.begin(async (tx) => {
    if (opts.description !== undefined) {
      await tx`UPDATE ipa_hosts.hostgroups SET description = ${opts.description} WHERE cn = ${cn}`;
    }
    await tx`UPDATE ipa_hosts.hostgroups SET synced_at = now() WHERE cn = ${cn}`;
  });

  return { ok: true };
};

export const hostgroupDel = async (ipaSession: string, cn: string): Promise<IpaHostsMutationResult> => {
  const url = await getIpaUrl();
  if (!url) return disabledResult();
  const response = await freeipa.client.call({ url, ipaSession, method: "hostgroup_del", args: [cn], options: {} });
  if (response.error) {
    return { ok: false, error: response.error.message, status: freeipa.util.mapIpaErrorCode(response.error.code) };
  }

  await sql`DELETE FROM ipa_hosts.hostgroups WHERE cn = ${cn}`;
  return { ok: true };
};
