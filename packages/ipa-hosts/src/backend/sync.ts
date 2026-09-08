import type { Worker } from "@k2b/sync";
import { lazySync } from "@valentinkolb/cloud";
import { freeipa } from "@valentinkolb/cloud/server/services";
import { getFreeIpaConfig, logger, get as settingsGet, set as settingsSet, trace } from "@valentinkolb/cloud/services";
import { sql } from "bun";

type DbRow = Record<string, unknown>;

const syncLog = logger("ipa-hosts:sync");
const schedulerLog = logger("ipa-hosts:scheduler");

const DEFAULT_SYNC_CRON = "*/5 * * * *";
// Intentionally app-owned: managed from the ipa-hosts UI and not exposed in the global settings app.
const SYNC_CRON_KEY = "ipa-hosts.sync_cron";

type SyncHost = {
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

type SyncHostgroup = {
  cn: string;
  description: string | null;
  hosts: string[];
  hostgroups: string[];
};

type IpaCallResponse = Awaited<ReturnType<typeof freeipa.client.call>>;

/**
 * FreeIPA could not deliver a usable snapshot (unreachable, misconfigured,
 * rejected call, or an empty list that must not wipe the mirror). The run's
 * trace span records it; the next cron slot retries. Not a dead-letter case.
 */
export class IpaHostsSyncError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IpaHostsSyncError";
  }
}

type SyncSummary = {
  durationMs: number;
  remoteHostsFetched: number;
  remoteHostgroupsFetched: number;
  hostsSynced: number;
  deletedHosts: number;
  hostgroupsSynced: number;
  deletedHostgroups: number;
  localHostsBefore: number;
  localHostgroupsBefore: number;
};

const transformSyncHost = (raw: Record<string, unknown>, excludedGroupsSet: Set<string>): SyncHost => ({
  fqdn: freeipa.util.str(raw.fqdn),
  description: freeipa.util.str(raw.description) || null,
  location: freeipa.util.str(raw.nshostlocation) || null,
  locality: freeipa.util.str(raw.l) || null,
  memberofHostgroup: ((raw.memberof_hostgroup as string[]) ?? []).filter((g) => !excludedGroupsSet.has(g)),
  macAddress: Array.isArray(raw.macaddress) ? raw.macaddress : [],
  platform: freeipa.util.str(raw.nshardwareplatform) || null,
  osVersion: freeipa.util.str(raw.nsosversion) || null,
  sshFingerprints: Array.isArray(raw.sshpubkeyfp) ? raw.sshpubkeyfp : [],
});

const transformSyncHostgroup = (raw: Record<string, unknown>, excludedGroupsSet: Set<string>): SyncHostgroup => ({
  cn: freeipa.util.str(raw.cn),
  description: freeipa.util.str(raw.description) || null,
  hosts: (raw.member_host as string[]) ?? [],
  hostgroups: ((raw.member_hostgroup as string[]) ?? []).filter((g) => !excludedGroupsSet.has(g)),
});

const readIpaList = (config: { response: IpaCallResponse; entity: string }): Record<string, unknown>[] => {
  if (config.response.error) {
    throw new IpaHostsSyncError(`IPA ${config.entity} fetch failed: ${config.response.error.message}`);
  }
  const records = config.response.result?.result;
  if (!Array.isArray(records)) {
    throw new IpaHostsSyncError(`IPA ${config.entity} fetch returned invalid list payload`);
  }
  return records as Record<string, unknown>[];
};

const getSyncCron = async (): Promise<string> => {
  const value = String((await settingsGet<string>(SYNC_CRON_KEY)) || "").trim();
  return value.length > 0 ? value : DEFAULT_SYNC_CRON;
};

const getTimezone = async (): Promise<string> => {
  const value = String((await settingsGet<string>("app.timezone")) || "").trim();
  return value.length > 0 ? value : "Europe/Berlin";
};

const fetchIpaSnapshot = async (config: {
  url: string;
  serviceUser: string;
  servicePassword: string;
}): Promise<[IpaCallResponse, IpaCallResponse]> => {
  try {
    const ipaSession = await freeipa.session.getServiceSession({
      url: config.url,
      serviceUser: config.serviceUser,
      servicePassword: config.servicePassword,
    });
    return await Promise.all([
      freeipa.client.call({ url: config.url, ipaSession, method: "host_find", args: [], options: { sizelimit: 0, all: true } }),
      freeipa.client.call({
        url: config.url,
        ipaSession,
        method: "hostgroup_find",
        args: [],
        options: { sizelimit: 0, no_members: false, all: true },
      }),
    ]);
  } catch (error) {
    throw new IpaHostsSyncError(`FreeIPA request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
};

export const syncFromIpaHosts = async (): Promise<SyncSummary> => {
  const config = await getFreeIpaConfig();
  if (!config.enabled) {
    const summary: SyncSummary = {
      durationMs: 0,
      remoteHostsFetched: 0,
      remoteHostgroupsFetched: 0,
      hostsSynced: 0,
      deletedHosts: 0,
      hostgroupsSynced: 0,
      deletedHostgroups: 0,
      localHostsBefore: 0,
      localHostgroupsBefore: 0,
    };
    syncLog.info("Sync skipped", { reason: "freeipa_disabled" });
    return summary;
  }
  if (!config.configured) {
    throw new IpaHostsSyncError(`FreeIPA is enabled but not fully configured. Missing: ${config.missingSettings.join(", ")}.`);
  }

  const startedAt = Date.now();
  const [hostsRes, hostgroupsRes] = await fetchIpaSnapshot(config);

  const excludedGroupsSet = freeipa.util.toExcludedGroupsSet(config.groupsExcluded);
  const allRawHosts = readIpaList({ response: hostsRes, entity: "hosts" });
  const hosts = allRawHosts.map((raw) => transformSyncHost(raw, excludedGroupsSet));
  const allRawHostgroups = readIpaList({ response: hostgroupsRes, entity: "hostgroups" });
  const hostgroups = allRawHostgroups.map((raw) => transformSyncHostgroup(raw, excludedGroupsSet));

  const hostFqdns = hosts.map((host) => host.fqdn);
  const hostgroupCns = new Set(hostgroups.map((hostgroup) => hostgroup.cn));

  const [localCountsRow] = await sql<DbRow[]>`
    SELECT
      (SELECT COUNT(*)::int FROM ipa_hosts.hosts) AS hosts,
      (SELECT COUNT(*)::int FROM ipa_hosts.hostgroups) AS hostgroups
  `;

  const localHosts = Number(localCountsRow?.hosts ?? 0);
  const localHostgroups = Number(localCountsRow?.hostgroups ?? 0);

  if (hostFqdns.length === 0 && localHosts > 0) {
    throw new IpaHostsSyncError(`Refusing IPA host sync: remote hosts list is empty while local mirror has ${localHosts} hosts`);
  }
  if (hostgroupCns.size === 0 && localHostgroups > 0) {
    throw new IpaHostsSyncError(
      `Refusing IPA host sync: remote hostgroups list is empty while local mirror has ${localHostgroups} hostgroups`,
    );
  }

  let deletedHosts = 0;
  let deletedHostgroups = 0;

  await sql.begin(async (tx) => {
    for (const host of hosts) {
      await tx`
        INSERT INTO ipa_hosts.hosts (fqdn, description, location, locality, mac_address, platform, os_version, ssh_fingerprints, synced_at)
        VALUES (
          ${host.fqdn}, ${host.description}, ${host.location}, ${host.locality},
          ${freeipa.util.toPgTextArray(host.macAddress)}::text[], ${host.platform}, ${host.osVersion},
          ${freeipa.util.toPgTextArray(host.sshFingerprints)}::text[], now()
        )
        ON CONFLICT (fqdn) DO UPDATE SET
          description = EXCLUDED.description,
          location = EXCLUDED.location,
          locality = EXCLUDED.locality,
          mac_address = EXCLUDED.mac_address,
          platform = EXCLUDED.platform,
          os_version = EXCLUDED.os_version,
          ssh_fingerprints = EXCLUDED.ssh_fingerprints,
          synced_at = now()
      `;
    }

    if (hostFqdns.length > 0) {
      const deleted = await tx<DbRow[]>`
        DELETE FROM ipa_hosts.hosts
        WHERE fqdn <> ALL(${freeipa.util.toPgTextArray(hostFqdns)}::text[])
        RETURNING fqdn
      `;
      deletedHosts = deleted.length;
    }

    for (const hostgroup of hostgroups) {
      await tx`
        INSERT INTO ipa_hosts.hostgroups (cn, description, synced_at)
        VALUES (${hostgroup.cn}, ${hostgroup.description}, now())
        ON CONFLICT (cn) DO UPDATE SET
          description = EXCLUDED.description,
          synced_at = now()
      `;
    }

    const hostgroupCnArray = [...hostgroupCns];
    if (hostgroupCnArray.length > 0) {
      const deleted = await tx<DbRow[]>`
        DELETE FROM ipa_hosts.hostgroups
        WHERE cn <> ALL(${freeipa.util.toPgTextArray(hostgroupCnArray)}::text[])
        RETURNING cn
      `;
      deletedHostgroups = deleted.length;
    }

    await tx`TRUNCATE ipa_hosts.host_hostgroups, ipa_hosts.hostgroup_hostgroups`;

    for (const host of hosts) {
      for (const hostgroupCn of host.memberofHostgroup) {
        if (hostgroupCns.has(hostgroupCn)) {
          await tx`
            INSERT INTO ipa_hosts.host_hostgroups (host_fqdn, hostgroup_cn)
            VALUES (${host.fqdn}, ${hostgroupCn})
            ON CONFLICT DO NOTHING
          `;
        }
      }
    }

    for (const hostgroup of hostgroups) {
      for (const childCn of hostgroup.hostgroups) {
        if (hostgroupCns.has(childCn)) {
          await tx`
            INSERT INTO ipa_hosts.hostgroup_hostgroups (parent_cn, child_cn)
            VALUES (${hostgroup.cn}, ${childCn})
            ON CONFLICT DO NOTHING
          `;
        }
      }
    }
  });

  const summary: SyncSummary = {
    durationMs: Date.now() - startedAt,
    remoteHostsFetched: allRawHosts.length,
    remoteHostgroupsFetched: allRawHostgroups.length,
    hostsSynced: hosts.length,
    deletedHosts,
    hostgroupsSynced: hostgroups.length,
    deletedHostgroups,
    localHostsBefore: localHosts,
    localHostgroupsBefore: localHostgroups,
  };

  syncLog.info("Sync complete", summary);
  return summary;
};

const syncJob = lazySync((sync) =>
  sync.job<void>({
    id: "ipa-hosts:sync",
    delivery: { ackWaitMs: 180_000, maxAttempts: 3, backoffMs: [1_000, 2_000] },
  }),
);
const syncScheduler = lazySync((sync) => sync.scheduler({ id: "ipa-hosts" }));
let syncWorker: Worker | undefined;
let schedulerWorker: Worker | undefined;

// App lifecycle hooks call start/stop sequentially, so lightweight module state is sufficient here.
let started = false;
let registered = false;
let registerPromise: Promise<void> | null = null;

const createSchedule = async (cron: string, tz: string): Promise<void> => {
  await syncScheduler().create({
    id: "ipa-hosts:sync",
    cron,
    timezone: tz,
    misfire: "latest",
    meta: {
      appId: "ipa-hosts",
      family: "ipa-hosts:sync",
      label: "IPA hosts sync",
      source: "ipa-hosts:sync",
    },
    process: async (context) => {
      await syncJob().submit({ key: `slot:${context.slot.getTime()}`, input: undefined });
    },
  });
};

const registerSchedule = async (cron?: string): Promise<void> => {
  const [tz, resolvedCron] = await Promise.all([getTimezone(), cron ? Promise.resolve(cron) : getSyncCron()]);
  try {
    await createSchedule(resolvedCron, tz);
    registered = true;
  } catch (error) {
    if (!cron && resolvedCron !== DEFAULT_SYNC_CRON) {
      schedulerLog.warn("Invalid configured sync cron, falling back to default", {
        key: SYNC_CRON_KEY,
        configuredCron: resolvedCron,
        fallbackCron: DEFAULT_SYNC_CRON,
        timezone: tz,
        error: error instanceof Error ? error.message : String(error),
      });
      await createSchedule(DEFAULT_SYNC_CRON, tz);
      registered = true;
      return;
    }
    throw error;
  }
};

const ensureRegistered = async (): Promise<void> => {
  if (registered) return;
  if (!registerPromise) {
    registerPromise = registerSchedule().finally(() => {
      registerPromise = null;
    });
  }
  await registerPromise;
};

const startWorkers = async (): Promise<void> => {
  if (started) return;
  syncWorker = await syncJob().process({}, async (context) => {
    context.signal.throwIfAborted();
    await trace
      .withSpan(
        {
          spanKey: trace.syncSpanKey("job", "ipa-hosts:sync", context.jobId),
          name: "IPA hosts sync",
          source: "ipa-hosts:sync",
          appId: "ipa-hosts",
          category: "job",
        },
        syncFromIpaHosts,
        { summarize: (result) => result },
      )
      .catch((error: unknown) => {
        // FreeIPA being down or refusing the snapshot is a routine outcome: the span carries
        // it and the next cron slot retries. Only infrastructure failures (database) retry
        // and reach the dead-letter store.
        if (!(error instanceof IpaHostsSyncError)) throw error;
        syncLog.error("Sync failed", { error: error.message });
      });
  });
  schedulerWorker = await syncScheduler().process();
  started = true;
};

export const ipaHostsSyncRuntime = {
  start: async (): Promise<void> => {
    await startWorkers();
    await ensureRegistered();
  },
  stop: async (): Promise<void> => {
    if (!started) return;
    await schedulerWorker?.drain();
    await syncWorker?.drain();
    schedulerWorker = undefined;
    syncWorker = undefined;
    started = false;
    registered = false;
    registerPromise = null;
  },
  submitSync: () => syncJob().submit({ key: `manual:${crypto.randomUUID()}`, input: undefined }),
  getSyncCron: async (): Promise<string> => getSyncCron(),
  getTimezone: async (): Promise<string> => getTimezone(),
  updateSyncCron: async (cron: string): Promise<void> => {
    const normalized = cron.trim();
    if (!normalized) throw new Error("Sync cron must not be empty.");
    await startWorkers();
    await registerSchedule(normalized);
    await settingsSet(SYNC_CRON_KEY, normalized);
  },
};
