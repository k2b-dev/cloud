import { listApps } from "../_internal/registry";
import type { AppMeta } from "../contracts/app";
import type { AppRegistryEntry } from "../contracts/registry";
import type { RequestAuthority } from "../server/middleware/auth";
import { usableAppIds } from "./app-access";

/** Filter before projecting any app-owned names, schemas, or content. */
export const discoverableApps = async <T extends Pick<AppMeta, "id" | "access">>(
  authority: RequestAuthority | null,
  apps: readonly T[],
): Promise<T[]> => {
  const usable = await usableAppIds(authority, apps);
  return apps.filter((app) => usable.has(app.id));
};

/** Capability and widget records carry an app ID; the live registry owns their access declaration. */
export const discoverableAppEntries = async <T extends { appId: string }>(
  authority: RequestAuthority | null,
  entries: readonly T[],
  registry: () => Promise<AppRegistryEntry[]> = listApps,
): Promise<T[]> => {
  if (!entries.length) return [];
  const ids = new Set(entries.map((entry) => entry.appId));
  const apps = (await registry()).filter((app) => ids.has(app.id));
  const usable = await usableAppIds(authority, apps);
  return entries.filter((entry) => usable.has(entry.appId));
};
