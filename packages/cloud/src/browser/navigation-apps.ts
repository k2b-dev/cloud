import { readShellData } from "../ssr/shell-data";

/** Navigation controls discoverability, never authorization; the target application still checks access. */
export const navigationApps = (): { appIds: ReadonlySet<string>; currentAppId?: string } => {
  const shell = readShellData();
  return { appIds: new Set(shell?.apps.map((app) => app.id) ?? []), currentAppId: shell?.appId };
};
