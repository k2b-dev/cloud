/** Run against the isolated NATS test account; never an application namespace. */
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createSync } from "@k2b/sync";
import { z } from "zod";
import { connectTestNats } from "../../../scripts/fixtures/test-nats";
import { deleteTestNamespace } from "../../../scripts/fixtures/test-sync";
import { compileCapabilities } from "../src/_internal/capabilities";
import { bindProcessSync, unbindProcessSync } from "../src/_internal/process-sync";
import { APP_REGISTRY_CONFIG, appRegistry, CAPABILITY_REGISTRY_CONFIG, capabilityRegistry } from "../src/_internal/registry";
import { validateAppRegistryEntry } from "../src/_internal/registry-validation";
import { defineCapabilities } from "../src/contracts/capabilities";
import type { AppRegistryEntry } from "../src/contracts/registry";

if (Bun.argv.includes("--help")) {
  console.log(
    "Usage: CLOUD_TEST_NATS_SERVERS=... CLOUD_TEST_NATS_CREDS_FILE=... bun --no-env-file packages/cloud/bench/registry.ts\n27 apps, capability records up to 270 KB, 20 concurrent page-like reads. Uses and deletes its own test namespace.",
  );
  process.exit(0);
}
const nc = await connectTestNats({ name: "registry-benchmark", ignoreClusterUpdates: true });
const namespace = `test-registry-bench-${crypto.randomUUID().slice(0, 8)}`;
const sync = createSync({ connection: nc, namespace, application: "registry-benchmark", defaults: { replicas: 1 } });
bindProcessSync(sync);
const { getApp, listApps } = await import("../src/_internal/registry");
const apps = appRegistry();
const capabilities = capabilityRegistry();
const sample = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    n: values.length,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    max: sorted.at(-1),
  };
};
const measure = async (name: string, fn: () => Promise<unknown>, concurrent = 1, rounds = 10) => {
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  await Bun.sleep(10);
  const before = nc.stats();
  const cpu = process.cpuUsage();
  const elapsed: number[] = [];
  for (let round = 0; round < rounds; round++) {
    await Promise.all(
      Array.from({ length: concurrent }, async () => {
        const start = performance.now();
        await fn();
        elapsed.push(performance.now() - start);
      }),
    );
    await Bun.sleep(0);
  }
  await Bun.sleep(10);
  delay.disable();
  const after = nc.stats();
  console.log(
    JSON.stringify({
      name,
      ms: sample(elapsed),
      eventLoopMaxMs: delay.max / 1e6,
      cpuMs: Object.values(process.cpuUsage(cpu)).reduce((a, b) => a + b, 0) / 1000,
      natsInMsgs: after.inMsgs - before.inMsgs,
      natsInBytes: after.inBytes - before.inBytes,
      natsOutMsgs: after.outMsgs - before.outMsgs,
    }),
  );
};
try {
  await sync.ready();
  const entries: AppRegistryEntry[] = [];
  const capabilitySizes: number[] = [];
  for (let i = 0; i < 27; i++) {
    const id = i === 0 ? "core" : `bench-${i}`;
    const compiled = compileCapabilities(
      id,
      defineCapabilities({
        protocolVersion: 2,
        queries: {
          read: {
            title: "Read",
            description: "Reads a resource.",
            input: z.object({ id: z.string().describe("Resource schema documentation. ".repeat(i === 0 ? 8300 : 30 + i * 50)) }).strict(),
            data: z.string(),
            openWorld: false,
            run: async () => {
              throw new Error("not executed");
            },
          },
        },
      }),
    );
    const entry: AppRegistryEntry = {
      id,
      name: id,
      icon: "box",
      description: "Benchmark app",
      baseUrl: `http://${id}:3000`,
      routes: [`/app/${id}`],
      capabilities: { protocolVersion: 2, manifestHash: compiled.manifest.manifestHash },
    };
    if (validateAppRegistryEntry(entry)) throw new Error("invalid fixture");
    entries.push(entry);
    await apps.upsert({ key: `apps/${id}`, value: entry });
    const record = { appId: id, manifest: compiled.manifest, presentation: compiled.presentation };
    capabilitySizes.push(Buffer.byteLength(JSON.stringify(record)));
    await capabilities.upsert({ key: `capabilities/${id}`, value: record });
  }
  console.log(
    JSON.stringify({
      fixture: { apps: entries.length, appBytes: entries.map((e) => Buffer.byteLength(JSON.stringify(e))), capabilitySizes },
      config: { apps: APP_REGISTRY_CONFIG.maxValueBytes, capabilities: CAPABILITY_REGISTRY_CONFIG.maxValueBytes },
    }),
  );
  const validationTimes = Array.from({ length: 1000 }, () => {
    const start = performance.now();
    for (const e of entries) validateAppRegistryEntry(e);
    return performance.now() - start;
  });
  console.log(JSON.stringify({ name: "validate-27-apps", ms: sample(validationTimes) }));
  await measure("snapshot-one-app", () => apps.snapshot({ prefix: "apps/core" }));
  await measure("snapshot-all-apps", () => apps.snapshot({ prefix: "apps/" }));
  await measure("snapshot-capability-core", () => capabilities.snapshot({ prefix: "capabilities/core" }));
  await getApp("core"); // initialize a local view, when present
  await measure("getApp-20", () => getApp("core"), 20, 20);
  await measure(
    "page-20",
    async () => {
      await Promise.all([getApp("core"), getApp("bench-1"), listApps(), listApps()]);
    },
    20,
    20,
  );
} finally {
  unbindProcessSync();
  await sync.drain();
  await nc.close();
  await deleteTestNamespace(namespace);
}
