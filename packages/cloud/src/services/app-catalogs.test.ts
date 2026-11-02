import { expect, setSystemTime, spyOn, test } from "bun:test";
import * as registry from "../_internal/registry";
import type { AppRegistryEntry } from "../contracts/registry";
import * as store from "./app-catalog-store";
import { APP_CATALOG_RETENTION_MS } from "./app-catalog-store";
import { startAppCatalogMaintenance } from "./app-catalogs";

test("catalog maintenance does no storage work across 60 lease-only rounds and observes removal", async () => {
  const epoch = Date.UTC(2030, 0, 1);
  setSystemTime(new Date(epoch));
  let apps: AppRegistryEntry[] = [
    { id: "inventory", name: "Inventory", icon: "box", description: "", baseUrl: "http://inventory:3000", routes: [] },
  ];
  let change: (() => Promise<void>) | undefined;
  const cleanup = spyOn(store, "cleanupAppCatalogs").mockResolvedValue(null);
  const list = spyOn(registry, "listApps").mockImplementation(async () => apps);
  const watch = spyOn(registry, "watchAppRegistry").mockImplementation(async ({ signal, onChange }) => {
    change = onChange;
    await onChange();
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  const timer = spyOn(globalThis, "setTimeout");
  const stop = startAppCatalogMaintenance();
  try {
    await change!();
    expect(cleanup).toHaveBeenCalledTimes(1);
    for (let minute = 1; minute <= 60; minute++) {
      setSystemTime(new Date(epoch + minute * 60_000));
      await change!();
    }
    expect(cleanup).toHaveBeenCalledTimes(1);
    apps = [];
    const deadline = epoch + 60 * 60_000 + APP_CATALOG_RETENTION_MS;
    cleanup.mockResolvedValue(deadline);
    await change!();
    expect(cleanup).toHaveBeenLastCalledWith([]);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(timer).toHaveBeenLastCalledWith(expect.any(Function), APP_CATALOG_RETENTION_MS);
    const pending = timer.mock.calls.at(-1)?.[0];
    if (typeof pending !== "function") throw new Error("Missing retention wake-up");
    setSystemTime(new Date(deadline));
    cleanup.mockResolvedValue(null);
    pending();
    await change!();
    expect(cleanup).toHaveBeenCalledTimes(3);
  } finally {
    await stop();
    timer.mockRestore();
    watch.mockRestore();
    list.mockRestore();
    cleanup.mockRestore();
    setSystemTime();
  }
});
