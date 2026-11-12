import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import type { SecretRotationMetadata } from "../contracts/app-migration";
import { createRegistryMembership } from "./heartbeat";
import type { AppInstanceRecord } from "./registry";

const epoch = Date.parse("2030-01-02T00:00:00Z");
beforeEach(() => setSystemTime(epoch));
afterEach(() => setSystemTime());
const fixture = () => {
  const rows = new Map<string, AppInstanceRecord>();
  let secrets: SecretRotationMetadata = {
    current: "A".repeat(16),
    previous: null,
    next: null,
    changedAt: new Date(epoch).toISOString(),
    owners: [],
  };
  const registry = {
    upsert: async ({ key, value }: { key: string; value: AppInstanceRecord }) => {
      rows.set(key, structuredClone(value));
    },
    touch: async () => {
      throw new Error("Metadata renewals must publish fresh checks");
    },
    delete: async ({ key }: { key: string }) => rows.delete(key),
    snapshot: async () => ({ entries: [...rows].map(([key, value]) => ({ key, value })) }),
  };
  const membership = createRegistryMembership("mail", {
    instanceId: "one",
    hostname: "fixture",
    startedAt: epoch,
    registry: () => registry,
    lock: () => ({ withLock: async (_input, run) => run({ expiresAt: new Date(epoch + 10_000) }) }),
    secrets: () => secrets,
  });
  return {
    rows,
    registry,
    membership,
    setSecrets: (value: SecretRotationMetadata) => {
      secrets = value;
    },
  };
};

test("each membership renewal publishes the latest owner completion metadata", async () => {
  const f = fixture();
  await f.membership.register();
  expect([...f.rows.values()][0]?.secrets?.owners).toEqual([]);
  const owners = [{ id: "credentials", rows: 5, previousOnly: 0, unreadable: 0, checkedAt: new Date(epoch + 1_000).toISOString() }];
  f.setSecrets({ current: "A".repeat(16), previous: null, next: null, changedAt: new Date(epoch).toISOString(), owners });
  await f.membership.renew();
  expect([...f.rows.values()][0]?.secrets?.owners).toEqual(owners);
  await f.membership.leave();
  expect(f.rows.size).toBe(0);
});

test("a metadata renewal that completes after leave cannot resurrect a stopped instance", async () => {
  const f = fixture();
  await f.membership.register();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const upsert = f.registry.upsert;
  f.registry.upsert = async (input) => {
    entered.resolve();
    await release.promise;
    await upsert(input);
  };
  const renewing = f.membership.renew();
  await entered.promise;
  try {
    await f.membership.leave();
  } finally {
    release.resolve();
  }
  await renewing;
  expect(f.rows.size).toBe(0);
});
