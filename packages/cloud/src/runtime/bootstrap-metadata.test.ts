import { expect, test } from "bun:test";
import { createRegistryMembership } from "../_internal/heartbeat";
import type { AppInstanceRecord } from "../_internal/registry";
import type { PlatformBootstrapMetadata } from "./connections";
import { connectionFixture } from "./connections.test-fixture";

const NOW = Date.UTC(2030, 0, 2);
test("each instance publishes credential-free bootstrap metadata in its own field; older instances omit it", async () => {
  const values = connectionFixture();
  const bootstrap: PlatformBootstrapMetadata = {
    keyId: "22222222-2222-4222-8222-222222222222",
    mode: "core",
    sources: values.sources,
    keyFormat: "cloud-app-key-v1",
    protocol: 1,
  };
  const records: AppInstanceRecord[] = [];
  const registry = {
    upsert: async (input: { value: AppInstanceRecord }) => {
      records.push(structuredClone(input.value));
    },
    touch: async () => false,
    delete: async () => {},
    snapshot: async () => ({ entries: [] }),
  };
  const modern = createRegistryMembership("inventory", {
    registry: () => registry,
    lock: () => {
      throw new Error("registration must not take a membership lock");
    },
    instanceId: "modern",
    hostname: "test",
    startedAt: NOW,
    bootstrap,
  });
  const older = createRegistryMembership("inventory", {
    registry: () => registry,
    lock: () => {
      throw new Error("registration must not take a membership lock");
    },
    instanceId: "older",
    hostname: "test",
    startedAt: NOW,
  });
  bootstrap.mode = "env";
  await modern.register();
  await older.register();
  expect(records[0]!.bootstrap).toMatchObject({ mode: "core", keyId: bootstrap.keyId, protocol: 1 });
  expect(records[0]!.entries).toEqual({});
  expect(records[1]!.bootstrap).toBeUndefined();
  const serialized = JSON.stringify(records);
  expect(serialized).not.toContain(values.database.url);
  expect(serialized).not.toContain(values.appSecret.current);
});

test("Core instance membership advertises legacy evidence capability", async () => {
  let published: AppInstanceRecord | undefined;
  const registry = {
    upsert: async (input: { value: AppInstanceRecord }) => {
      published = input.value;
    },
    touch: async () => false,
    delete: async () => {},
    snapshot: async () => ({ entries: [] }),
  };
  await createRegistryMembership("core", {
    registry: () => registry,
    lock: () => {
      throw new Error("Unexpected lock");
    },
    instanceId: "core",
    hostname: "test",
    startedAt: NOW,
  }).register();
  expect(published?.legacyEvidence).toBe(1);
});
