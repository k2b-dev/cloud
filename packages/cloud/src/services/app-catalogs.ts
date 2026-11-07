import { listApps, watchAppRegistry } from "../_internal/registry";
import { APP_CATALOG_RETENTION_MS, type AppCatalogTable, cleanupAppCatalogs } from "./app-catalog-store";
import { logger } from "./logging";
import { superviseRuntimeTask } from "./runtime-lifecycle";

/**
 * Core owns catalog retention. Registry changes and pending removals wake it, and a daily pass reconciles catalogs that
 * a failed startup published without ever changing the registry.
 */
export const startAppCatalogMaintenance = (tables?: readonly AppCatalogTable[]): (() => Promise<void>) => {
  const controller = new AbortController();
  const log = logger("app-catalogs");
  let state: string | undefined;
  let next: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let dirty = false;
  let forced = false;
  const refresh = (force = false): Promise<void> => {
    dirty = true;
    forced ||= force;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      while (dirty && !controller.signal.aborted) {
        dirty = false;
        const runForced = forced;
        forced = false;
        const apps = await listApps();
        const current = JSON.stringify(apps.map((app) => [app.id, app.help?.manifestHash, app.skills?.manifestHash]).sort());
        if (!runForced && state === current && (next === null || next > Date.now())) continue;
        clearTimeout(timer);
        next = tables ? await cleanupAppCatalogs(apps, undefined, undefined, tables) : await cleanupAppCatalogs(apps);
        state = current;
        if (!controller.signal.aborted) {
          timer = setTimeout(() => void retry(), next === null ? APP_CATALOG_RETENTION_MS : Math.max(1, next - Date.now()));
        }
      }
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
  const retry = async () => {
    try {
      await refresh(true);
    } catch (error) {
      log.error("App catalog cleanup failed; retrying", { error: String(error) });
      if (!controller.signal.aborted) timer = setTimeout(() => void retry(), 60_000);
    }
  };
  const task = superviseRuntimeTask({
    name: "App catalog maintenance",
    signal: controller.signal,
    run: (signal) => watchAppRegistry({ signal, onChange: refresh }),
    onError: ({ error, retryInMs }) => log.error("App catalog registry watch failed; retrying", { error: String(error), retryInMs }),
  });
  return async () => {
    controller.abort();
    clearTimeout(timer);
    const results = await Promise.allSettled([task, inFlight]);
    for (const result of results) {
      if (result.status === "rejected") log.error("App catalog maintenance stopped after a failure", { error: String(result.reason) });
    }
  };
};
