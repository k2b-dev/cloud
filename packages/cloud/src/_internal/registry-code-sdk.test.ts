import { expect, setSystemTime, test } from "bun:test";
import type { Sync } from "@k2b/sync";
import { sdkFixture } from "../code/sdk.test-fixture";
import type { CapabilityManifest } from "../contracts/capabilities";
import { capabilityHash } from "./capability-schemas";
import { bindProcessSync, unbindProcessSync } from "./process-sync";
import { type CapabilityRegistryRecord, capabilityRegistry } from "./registry";

const record = (manifest: CapabilityManifest): CapabilityRegistryRecord => {
  const { manifestHash: _hash, ...base } = manifest;
  return { appId: manifest.appId, manifest: { ...base, manifestHash: capabilityHash(base) } };
};

async function registration(
  run: (register: (manifest: CapabilityManifest) => Promise<unknown>, stored: Map<string, CapabilityRegistryRecord>) => Promise<void>,
) {
  setSystemTime(new Date("2030-01-01T00:00:00Z"));
  const stored = new Map<string, CapabilityRegistryRecord>();
  let queue: Promise<unknown> = Promise.resolve();
  const sync = {
    ephemeral: () => ({
      upsert: async ({ key, value }: { key: string; value: CapabilityRegistryRecord }) => {
        stored.set(key, value);
        return { key, value };
      },
      snapshot: async () => ({ entries: [...stored].map(([key, value]) => ({ key, value })) }),
    }),
    mutex: () => ({
      withLock: async <T>(input: { resource: string }, fn: (lock: { expiresAt: Date }) => Promise<T>) => {
        expect(input.resource).toBe("default:code-sdk-exports");
        const result = queue.catch(() => {}).then(() => fn({ expiresAt: new Date("2030-01-01T00:01:00Z") }));
        queue = result;
        return result;
      },
    }),
  } as unknown as Sync;
  bindProcessSync(sync);
  try {
    const registry = capabilityRegistry();
    await run((manifest) => registry.upsert({ key: `capabilities/${manifest.appId}`, value: record(manifest) }), stored);
  } finally {
    unbindProcessSync();
    setSystemTime();
  }
}

test("capability registration refuses export collisions before publishing the second app", async () => {
  await registration(async (register, stored) => {
    await register({ ...sdkFixture("first"), sdkExportName: "catalog" });
    await expect(register({ ...sdkFixture("second"), sdkExportName: "catalog" })).rejects.toThrow("SDK export name collision");
    expect([...stored.keys()]).toEqual(["capabilities/first"]);
    // Its own replicas and changed manifests may renew the accepted namespace.
    await register({ ...sdkFixture("first"), sdkExportName: "catalog" });
    await expect(register(sdkFixture("catalog"))).rejects.toThrow("SDK export name collision");
  });
});

test("registration rejects normalized path collisions and leaves the accepted manifest intact", async () => {
  await registration(async (register, stored) => {
    const manifest = sdkFixture("example");
    await register(manifest);
    const query = manifest.queries.find((query) => query.localId === "catalog.list")!;
    const changed = {
      ...manifest,
      queries: [...manifest.queries, { ...query, localId: "stock-list" }, { ...query, localId: "stock_list" }],
    };
    await expect(register(changed)).rejects.toThrow("SDK path collision");
    expect(stored.get("capabilities/example")?.manifest).toEqual(manifest);
    await expect(register({ ...manifest, sdkExportName: "app" })).rejects.toThrow("Reserved SDK export name");
  });
});

test("simultaneous registrations cannot both claim the same SDK export", async () => {
  await registration(async (register, stored) => {
    const results = await Promise.allSettled([
      register(sdkFixture("work-shop")),
      register({ ...sdkFixture("other"), sdkExportName: "work_shop" }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(stored.size).toBe(1);
  });
});

test("registration compares the incoming namespace with readable existing records independently", async () => {
  await registration(async (register, stored) => {
    const future = record(sdkFixture("future"));
    stored.set("capabilities/future", {
      ...future,
      manifest: { ...future.manifest, protocolVersion: 999 },
    } as unknown as CapabilityRegistryRecord);
    stored.set("capabilities/old-one", record({ ...sdkFixture("old-one"), sdkExportName: "shared" }));
    stored.set("capabilities/old-two", record({ ...sdkFixture("old-two"), sdkExportName: "shared" }));
    await register(sdkFixture("unrelated"));
    expect(stored.has("capabilities/unrelated")).toBe(true);
    await expect(register({ ...sdkFixture("claim"), sdkExportName: "shared" })).rejects.toThrow("SDK export name collision");
    await register(sdkFixture("unrelated"));
    expect(stored.has("capabilities/claim")).toBe(false);
  });
});
