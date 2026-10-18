import { afterAll, afterEach, beforeEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redis } from "bun";
import { buildRuntimeFromRegistry } from "../../packages/cloud/src/_internal/runtime-context";
import * as runtime from "../../packages/cloud/src/_internal/runtime-watcher";
import * as snapshot from "../../packages/cloud/src/services/settings/snapshot";
import * as settings from "../../packages/cloud/src/services/settings/store";
import { createConfig } from "../../packages/ssr/src";

/** Compile real routers/SSR routes; stub infrastructure reads only during each test. */
export const prepareNoTransformRouterTest = () => {
  const root = mkdtempSync(join(tmpdir(), "compression-router-"));
  const { plugin } = createConfig({ dev: true, rootDir: root });
  Bun.plugin(plugin());
  const install = () => [
    spyOn(runtime, "ensureRuntimeWatcher").mockResolvedValue(undefined),
    spyOn(runtime, "getCurrentRuntime").mockReturnValue(buildRuntimeFromRegistry([])),
    spyOn(snapshot, "loadSnapshot").mockResolvedValue({}),
    spyOn(settings, "readKey").mockImplementation(async (key) => {
      if (key === "security.rate_limit_per_second") return 100;
      throw new Error(`Unexpected setting read in router guard: ${key}`);
    }),
    spyOn(redis, "send").mockImplementation(async (command, args) => {
      if (command === "EVAL" && args[2]?.startsWith("cloud:rate-limit:")) return [1, 0, "1"];
      throw new Error(`Unexpected Redis command in router guard: ${command}`);
    }),
  ];
  let spies: ReturnType<typeof install> = [];
  beforeEach(() => {
    spies = install();
  });
  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
};
