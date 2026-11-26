export * as provider from "./provider";
export * as sync from "./sync";

import * as provider from "./provider";
import * as sync from "./sync";

export const ipaHosts = {
  hosts: {
    list: provider.hostList,
    get: provider.hostGet,
    listUngrouped: provider.hostListUngrouped,
    update: provider.hostMod,
    delete: provider.hostDel,
    addToGroup: provider.hostAddToGroup,
    removeFromGroup: provider.hostRemoveFromGroup,
  },
  hostgroups: {
    list: provider.hostgroupList,
    listWithHosts: provider.hostgroupListWithHosts,
    getWithHosts: provider.hostgroupGetWithHosts,
    search: provider.hostgroupSearch,
    create: provider.hostgroupAdd,
    update: provider.hostgroupMod,
    delete: provider.hostgroupDel,
  },
  stats: provider.hostStats,
  sync: {
    start: sync.ipaHostsSyncRuntime.start,
    stop: sync.ipaHostsSyncRuntime.stop,
    submit: sync.ipaHostsSyncRuntime.submitSync,
    getCron: sync.ipaHostsSyncRuntime.getSyncCron,
    getTimezone: sync.ipaHostsSyncRuntime.getTimezone,
    updateCron: sync.ipaHostsSyncRuntime.updateSyncCron,
  },
} as const;
