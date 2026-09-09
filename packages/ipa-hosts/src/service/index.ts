import { ipaHosts } from "../backend";
import { audit, type AuditActor, type AuditTarget } from "@k2b/cloud/services";
import { getFreeIpaConfig } from "@k2b/cloud/services/freeipa-config";
import {
  err,
  fail,
  freeipa,
  ok,
  paginate,
  type PageParams,
  type Paginated,
  type Result,
  type ServiceErrorCode,
} from "@k2b/cloud/server";
import type { IpaHost, IpaHostgroup } from "@/contracts";

type IpaMutationResult = { ok: true } | { ok: false; error: string; status: 400 | 401 | 403 | 404 | 500 };
type IpaHostsActor = { userId: string; uid: string; roles: string[]; provider?: string | null };
type MutationAuditConfig = {
  action: string;
  target: AuditTarget;
  metadata?: Record<string, unknown>;
};

const looksLikeCronValidationError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return ["cron", "expression", "field", "minute", "hour", "day", "month", "weekday"].some((token) => message.includes(token));
};

const toPaginated = <T>(items: T[], total: number, pagination: { page: number; perPage: number }): Paginated<T> => ({
  items,
  page: pagination.page,
  perPage: pagination.perPage,
  total,
  hasNext: pagination.page * pagination.perPage < total,
});

const toErrorCode = (status: 400 | 401 | 403 | 404 | 500): ServiceErrorCode => {
  switch (status) {
    case 400:
      return "BAD_INPUT";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    default:
      return "INTERNAL";
  }
};

const fromIpaMutation = (result: IpaMutationResult): Result<void> => {
  if (result.ok) return ok();
  return fail({
    code: toErrorCode(result.status),
    message: result.error,
    status: result.status,
  });
};

const auditActor = (actor: IpaHostsActor): AuditActor => ({
  userId: actor.userId,
  uid: actor.uid,
  provider: actor.provider,
  roles: actor.roles,
});

const recordMutationResult = (config: {
  actor: IpaHostsActor;
  audit: MutationAuditConfig;
  result: Result<void>;
}): Promise<Result<void>> => {
  const params = {
    action: config.audit.action,
    actor: auditActor(config.actor),
    target: config.audit.target,
    metadata: config.audit.metadata,
    result: config.result,
  };
  return config.result.ok ? audit.recordResultAfterSideEffect(params) : audit.recordResult(params);
};

const getServiceSession = async (): Promise<Result<string>> => {
  const config = await getFreeIpaConfig();
  if (!config.enabled) return fail(err.badInput("FreeIPA is disabled."));
  if (!config.configured)
    return fail(err.badInput(`FreeIPA is enabled but not fully configured. Missing: ${config.missingSettings.join(", ")}.`));
  try {
    return ok(
      await freeipa.session.getServiceSession({
        url: config.url,
        serviceUser: config.serviceUser,
        servicePassword: config.servicePassword,
      }),
    );
  } catch {
    return fail(err.internal("Internal FreeIPA service session unavailable."));
  }
};

const isAdminActor = (actor: IpaHostsActor): boolean => actor.roles.includes("admin");

const getAdminServiceSession = async (actor: IpaHostsActor): Promise<Result<string>> => {
  if (!isAdminActor(actor)) return fail(err.forbidden("Admin access required"));
  return getServiceSession();
};

const runAdminMutation = async (
  actor: IpaHostsActor,
  auditConfig: MutationAuditConfig,
  mutation: (ipaSession: string) => Promise<IpaMutationResult>,
): Promise<Result<void>> => {
  if (!isAdminActor(actor)) {
    return audit.deny<void>({
      action: auditConfig.action,
      actor: auditActor(actor),
      target: auditConfig.target,
      metadata: auditConfig.metadata,
      message: "Admin access required",
    });
  }
  const serviceSession = await getAdminServiceSession(actor);
  if (!serviceSession.ok) {
    return audit.recordResult({
      ...auditConfig,
      actor: auditActor(actor),
      result: fail(serviceSession.error),
    });
  }
  const result = await mutation(serviceSession.data);
  return recordMutationResult({ actor, audit: auditConfig, result: fromIpaMutation(result) });
};

export const ipaHostsService = {
  host: {
    list: async (config: { pagination?: PageParams; filter?: { query?: string } }) => {
      const { page, perPage } = paginate(config.pagination);
      const result = await ipaHosts.hosts.list({
        search: config.filter?.query,
        page,
        perPage,
      });
      return toPaginated<IpaHost>(result.hosts, result.total, { page, perPage });
    },
    listUngrouped: async (config: { pagination?: PageParams; filter?: { query?: string } }) => {
      const { page, perPage } = paginate(config.pagination);
      const result = await ipaHosts.hosts.listUngrouped({
        search: config.filter?.query,
        page,
        perPage,
      });
      return toPaginated<IpaHost>(result.hosts, result.total, { page, perPage });
    },
    update: async (config: {
      actor: IpaHostsActor;
      fqdn: string;
      data: { location?: string; locality?: string; description?: string; macAddress?: string[] };
    }) => {
      return runAdminMutation(
        config.actor,
        {
          action: "ipa_hosts.host.update",
          target: { type: "ipa_host", id: config.fqdn, label: config.fqdn },
          metadata: { fields: Object.keys(config.data) },
        },
        (ipaSession) => ipaHosts.hosts.update(ipaSession, config.fqdn, config.data),
      );
    },
    remove: async (config: { actor: IpaHostsActor; fqdn: string }) => {
      return runAdminMutation(
        config.actor,
        { action: "ipa_hosts.host.delete", target: { type: "ipa_host", id: config.fqdn, label: config.fqdn } },
        (ipaSession) => ipaHosts.hosts.delete(ipaSession, config.fqdn),
      );
    },
    addToGroup: async (config: { actor: IpaHostsActor; fqdn: string; hostgroup: string }) => {
      return runAdminMutation(
        config.actor,
        {
          action: "ipa_hosts.host.add_to_group",
          target: { type: "ipa_host", id: config.fqdn, label: config.fqdn },
          metadata: { hostgroup: config.hostgroup },
        },
        (ipaSession) => ipaHosts.hosts.addToGroup(ipaSession, config.fqdn, config.hostgroup),
      );
    },
    removeFromGroup: async (config: { actor: IpaHostsActor; fqdn: string; hostgroup: string }) => {
      return runAdminMutation(
        config.actor,
        {
          action: "ipa_hosts.host.remove_from_group",
          target: { type: "ipa_host", id: config.fqdn, label: config.fqdn },
          metadata: { hostgroup: config.hostgroup },
        },
        (ipaSession) => ipaHosts.hosts.removeFromGroup(ipaSession, config.fqdn, config.hostgroup),
      );
    },
  },
  hostgroup: {
    list: async (config: { pagination?: PageParams; filter?: { query?: string } }) => {
      const { page, perPage } = paginate(config.pagination);
      const result = await ipaHosts.hostgroups.list({
        search: config.filter?.query,
        page,
        perPage,
      });
      return toPaginated<IpaHostgroup>(result.hostgroups, result.total, { page, perPage });
    },
    listWithHosts: async (config: { pagination?: PageParams; filter?: { query?: string } }) => {
      const { page, perPage } = paginate(config.pagination);
      const result = await ipaHosts.hostgroups.listWithHosts({
        search: config.filter?.query,
        page,
        perPage,
      });
      return {
        items: result.hostgroups,
        page,
        perPage,
        total: result.total,
        hasNext: page * perPage < result.total,
      };
    },
    search: async (config: { query: string; exclude?: string[]; limit?: number }) => {
      return ipaHosts.hostgroups.search({
        query: config.query,
        exclude: config.exclude,
        limit: config.limit,
      });
    },
    create: async (config: { actor: IpaHostsActor; name: string; description?: string }) => {
      return runAdminMutation(
        config.actor,
        { action: "ipa_hosts.hostgroup.create", target: { type: "ipa_hostgroup", id: config.name, label: config.name } },
        (ipaSession) =>
          ipaHosts.hostgroups.create(ipaSession, config.name, {
            description: config.description,
          }),
      );
    },
    update: async (config: { actor: IpaHostsActor; cn: string; data: { description?: string } }) => {
      return runAdminMutation(
        config.actor,
        {
          action: "ipa_hosts.hostgroup.update",
          target: { type: "ipa_hostgroup", id: config.cn, label: config.cn },
          metadata: { fields: Object.keys(config.data) },
        },
        (ipaSession) => ipaHosts.hostgroups.update(ipaSession, config.cn, config.data),
      );
    },
    remove: async (config: { actor: IpaHostsActor; cn: string }) => {
      return runAdminMutation(
        config.actor,
        { action: "ipa_hosts.hostgroup.delete", target: { type: "ipa_hostgroup", id: config.cn, label: config.cn } },
        (ipaSession) => ipaHosts.hostgroups.delete(ipaSession, config.cn),
      );
    },
  },
  sync: {
    getCron: async () => ipaHosts.sync.getCron(),
    getTimezone: async () => ipaHosts.sync.getTimezone(),
    updateCron: async (config: { actor: IpaHostsActor; cron: string }) => {
      try {
        await ipaHosts.sync.updateCron(config.cron);
        return audit.recordResultAfterSideEffect({
          action: "ipa_hosts.sync.update_cron",
          actor: auditActor(config.actor),
          target: { type: "ipa_hosts_sync", id: "schedule", label: "Host sync schedule" },
          metadata: { cron: config.cron },
          result: ok(),
        });
      } catch (error) {
        const isBadInput = looksLikeCronValidationError(error);
        const result = fail({
          code: isBadInput ? "BAD_INPUT" : "INTERNAL",
          message: error instanceof Error ? error.message : "Failed to update sync schedule.",
          status: isBadInput ? 400 : 500,
        });
        return audit.recordResult({
          action: "ipa_hosts.sync.update_cron",
          actor: auditActor(config.actor),
          target: { type: "ipa_hosts_sync", id: "schedule", label: "Host sync schedule" },
          metadata: { cron: config.cron },
          result,
        });
      }
    },
    run: async (config: { actor: IpaHostsActor }) => {
      try {
        await ipaHosts.sync.submit();
        return audit.recordResultAfterSideEffect({
          action: "ipa_hosts.sync.run",
          actor: auditActor(config.actor),
          target: { type: "ipa_hosts_sync", id: "manual", label: "Manual host sync" },
          result: ok(),
        });
      } catch (error) {
        const result = fail(err.internal(error instanceof Error ? error.message : "Failed to start host sync."));
        return audit.recordResult({
          action: "ipa_hosts.sync.run",
          actor: auditActor(config.actor),
          target: { type: "ipa_hosts_sync", id: "manual", label: "Manual host sync" },
          result,
        });
      }
    },
  },
  stats: async () => ipaHosts.stats(),
};

export type IpaHostsService = typeof ipaHostsService;
