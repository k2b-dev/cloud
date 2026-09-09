import { type AppRegistryIssue, assessRuntimeCompatibility } from "@k2b/cloud";
import type { AppRegistryEntry } from "@k2b/cloud/contracts";

export type AppRuntimeStatus = {
  status: "ok" | "warn" | "error";
  signals: string[];
};

const setStatus = (current: AppRuntimeStatus, status: AppRuntimeStatus["status"], message: string): void => {
  if (status === "error" || (status === "warn" && current.status === "ok")) current.status = status;
  current.signals.push(message);
};

export const buildAppRuntimeStatuses = (
  apps: readonly AppRegistryEntry[],
  registryIssues: readonly AppRegistryIssue[],
): Map<string, AppRuntimeStatus> => {
  const statuses = new Map<string, AppRuntimeStatus>(apps.map((app) => [app.id, { status: "ok", signals: [] }]));
  const get = (appId: string): AppRuntimeStatus => {
    const existing = statuses.get(appId);
    if (existing) return existing;
    const created: AppRuntimeStatus = { status: "ok", signals: [] };
    statuses.set(appId, created);
    return created;
  };

  for (const issue of registryIssues) {
    const appId = issue.key.startsWith("apps/") ? issue.key.slice("apps/".length) : issue.key;
    setStatus(get(appId), "error", `Registry entry rejected: ${issue.reason}`);
  }
  for (const issue of assessRuntimeCompatibility(apps)) {
    for (const appId of issue.appIds) setStatus(get(appId), issue.severity, issue.message);
  }
  return statuses;
};
