import { expect, spyOn, test } from "bun:test";
import type { AppRegistryEntry } from "../contracts/registry";
import * as registry from "./registry";
import { ensureRuntimeWatcher, registeredCoreRelease, stopRuntimeWatcher } from "./runtime-watcher";

test("Core's release follows registry refreshes and is cleared on stop", async () => {
  const entry = (id: string, release: string): AppRegistryEntry => ({
    id,
    name: id,
    icon: "ti ti-stack",
    description: "Registry version probe",
    baseUrl: `http://${id}:3000`,
    routes: [],
    runtime: { release, syncVersion: "test" },
  });
  let apps = [entry("mail", "sha-mail"), entry("core", "sha-core-before")];
  let onChange: (() => Promise<void>) | undefined;
  const spies = [
    spyOn(registry, "listApps").mockImplementation(async () => apps),
    spyOn(registry, "listCapabilities").mockResolvedValue([]),
    spyOn(registry, "watchAppRegistry").mockImplementation(async (options) => {
      onChange = options.onChange;
      await new Promise<void>((resolve) => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }),
  ];
  try {
    expect(registeredCoreRelease()).toBeUndefined();
    await ensureRuntimeWatcher();
    expect(registeredCoreRelease()).toBe("sha-core-before");
    expect(onChange).toBeDefined();
    apps = [entry("core", "sha-core-after")];
    await onChange!();
    expect(registeredCoreRelease()).toBe("sha-core-after");
    apps = [entry("mail", "sha-mail")];
    await onChange!();
    expect(registeredCoreRelease()).toBeUndefined();
    apps = [entry("core", "sha-core-after")];
    await onChange!();
    await stopRuntimeWatcher();
    expect(registeredCoreRelease()).toBeUndefined();
    await ensureRuntimeWatcher();
    expect(registeredCoreRelease()).toBe("sha-core-after");
  } finally {
    await stopRuntimeWatcher();
    for (const spy of spies.toReversed()) spy.mockRestore();
  }
  expect(registeredCoreRelease()).toBeUndefined();
});
