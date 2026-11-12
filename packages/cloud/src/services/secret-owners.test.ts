import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { APP_REGISTRY_TTL_MS } from "../_internal/registry";
import { connectionFixture, stubConnections } from "../runtime/connections.test-fixture";
import * as logging from "./logging";
import { createSecretMaintenance, type SecretOwner, type SecretOwnerRow } from "./secret-owners";
import { evaluateSecretRotation } from "./secret-status";
import { decryptSecretBytes, encryptSecretBytes } from "./settings/crypto";

const A = "ab".repeat(32),
  B = "cd".repeat(32);
const changedAt = Date.parse("2030-01-02T00:00:00Z");
let snapshot: ReturnType<typeof stubConnections>;
beforeEach(() => {
  setSystemTime(changedAt + 1_000);
  snapshot = stubConnections({ appSecret: { current: A } });
});
afterEach(() => {
  snapshot.mockRestore();
  setSystemTime();
});
const rotate = () => snapshot.mockReturnValue(connectionFixture({ appSecret: { current: B, previous: A } }));

const memoryOwner = (rows: SecretOwnerRow[]) => {
  const stored = new Map(rows.map((row) => [row.key.join("/"), structuredClone(row)]));
  const invalidated: string[] = [];
  const owner: SecretOwner = {
    id: "credentials",
    scan: async (after, limit) =>
      [...stored.values()]
        .sort((left, right) => left.key.join("/").localeCompare(right.key.join("/")))
        .filter((row) => !after || row.key.join("/") > after.join("/"))
        .slice(0, limit)
        .map((row) => structuredClone(row)),
    compareAndSwap: async (row, values) => {
      const current = stored.get(row.key.join("/"));
      if (!current || JSON.stringify(current.values) !== JSON.stringify(row.values)) return false;
      stored.set(row.key.join("/"), { key: row.key, values });
      return true;
    },
    invalidate: async (row) => {
      invalidated.push(row.key.join("/"));
    },
  };
  return { stored, invalidated, owner };
};

test("rewrap preserves raw plaintext and all columns without reserializing domain JSON", async () => {
  const raw = ' { "number": 1.00, "array": [3,2,1] }\n';
  const { stored, owner } = memoryOwner([
    {
      key: ["one"],
      values: { access: await encryptSecretBytes(raw), password: await encryptSecretBytes("raw\n"), cleared: null, sentinel: "" },
    },
  ]);
  rotate();
  const maintenance = createSecretMaintenance([owner], changedAt);
  await maintenance.tick();
  const row = stored.get("one")!;
  expect(await decryptSecretBytes(row.values.access!, B)).toBe(raw);
  expect(await decryptSecretBytes(row.values.password!, B)).toBe("raw\n");
  expect(row.values.cleared).toBeNull();
  expect(row.values.sentinel).toBe("");
  expect(maintenance.metadata().owners).toEqual([
    {
      id: "credentials",
      rows: 1,
      previousOnly: 0,
      unreadable: 0,
      startedAt: new Date().toISOString(),
      checkedAt: new Date().toISOString(),
    },
  ]);
  await maintenance.stop();
});

test("a concurrent user write wins the CAS and is certified only by the next pass", async () => {
  const fixture = memoryOwner([{ key: ["one"], values: { secret: await encryptSecretBytes("old") } }]);
  rotate();
  const userWrite = await encryptSecretBytes("user write");
  const original = fixture.owner.compareAndSwap;
  fixture.owner.compareAndSwap = async (row, values) => {
    fixture.stored.set("one", { key: ["one"], values: { secret: userWrite } });
    return original(row, values);
  };
  const maintenance = createSecretMaintenance([fixture.owner], changedAt);
  await maintenance.tick();
  expect(fixture.stored.get("one")!.values.secret).toBe(userWrite);
  expect(maintenance.metadata().owners?.[0]?.previousOnly).toBe(1);
  await maintenance.tick();
  expect(maintenance.metadata().owners?.[0]?.previousOnly).toBe(0);
  await maintenance.stop();
});

test("a crash after commit and before invalidation repairs the cache on the next pass", async () => {
  const fixture = memoryOwner([{ key: ["one"], values: { secret: await encryptSecretBytes("unchanged") } }]);
  rotate();
  let calls = 0;
  fixture.owner.invalidate = async () => {
    if (++calls === 1) throw new Error("cache unavailable");
  };
  const maintenance = createSecretMaintenance([fixture.owner], changedAt);
  await expect(maintenance.tick()).rejects.toThrow("cache unavailable");
  expect(await decryptSecretBytes(fixture.stored.get("one")!.values.secret!, B)).toBe("unchanged");
  expect(maintenance.metadata().owners?.[0]?.checkedAt).toBeNull();
  await maintenance.tick();
  expect(calls).toBe(2);
  expect(maintenance.metadata().owners?.[0]).toMatchObject({
    rows: 1,
    previousOnly: 0,
    unreadable: 0,
    checkedAt: new Date().toISOString(),
  });
  await maintenance.stop();
});

test("unreadable values are counted and a multi-column row is never partially overwritten", async () => {
  const original = { key: ["one"], values: { valid: await encryptSecretBytes("value"), broken: "corrupt" } };
  const fixture = memoryOwner([original]);
  rotate();
  const maintenance = createSecretMaintenance([fixture.owner], changedAt);
  await maintenance.tick();
  expect(fixture.stored.get("one")).toEqual(original);
  expect(maintenance.metadata().owners?.[0]).toMatchObject({ rows: 1, previousOnly: 1, unreadable: 1 });
  await maintenance.stop();
});

test("NEXT permits reads but never starts rewrap; omitted owners remain unknown", async () => {
  const encrypted = await encryptSecretBytes("A");
  snapshot.mockReturnValue(connectionFixture({ appSecret: { current: B } }));
  const future = await encryptSecretBytes("B");
  snapshot.mockReturnValue(connectionFixture({ appSecret: { current: A, next: B } }));
  const fixture = memoryOwner([{ key: ["one"], values: { current: encrypted, future } }]);
  const maintenance = createSecretMaintenance([fixture.owner], changedAt);
  await maintenance.tick();
  expect(fixture.stored.get("one")!.values).toEqual({ current: encrypted, future });
  expect(fixture.invalidated).toEqual([]);
  expect(createSecretMaintenance(undefined, changedAt).metadata().owners).toBeUndefined();
  expect(createSecretMaintenance([], changedAt).metadata().owners).toEqual([]);
  await maintenance.stop();
});

test("bounded pages resume and stop drains the accepted page without starting more work", async () => {
  const encrypted = await encryptSecretBytes("A");
  const fixture = memoryOwner(
    Array.from({ length: 250 }, (_, index) => ({ key: [String(index).padStart(3, "0")], values: { secret: encrypted } })),
  );
  rotate();
  const maintenance = createSecretMaintenance([fixture.owner], changedAt);
  const first = maintenance.tick();
  expect(maintenance.tick()).toBe(first);
  await first;
  expect(maintenance.metadata().owners?.[0]?.checkedAt).toBeNull();
  for (let pass = 0; pass < 3; pass++) await maintenance.tick();
  expect(maintenance.metadata().owners?.[0]).toMatchObject({ rows: 250, previousOnly: 0, unreadable: 0 });
  await maintenance.stop();
  const invalidated = fixture.invalidated.length;
  await maintenance.tick();
  expect(fixture.invalidated.length).toBe(invalidated);
});

test("shutdown waits for an in-flight CAS and invalidation without accepting the next row", async () => {
  const encrypted = await encryptSecretBytes("A");
  const fixture = memoryOwner(["one", "two"].map((key) => ({ key: [key], values: { secret: encrypted } })));
  rotate();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const compareAndSwap = fixture.owner.compareAndSwap;
  fixture.owner.compareAndSwap = async (row, values) => {
    entered.resolve();
    await release.promise;
    return compareAndSwap(row, values);
  };
  const maintenance = createSecretMaintenance([fixture.owner], changedAt);
  const working = maintenance.tick();
  await entered.promise;
  let drained = false;
  const stopping = maintenance.stop().then(() => {
    drained = true;
  });
  expect(drained).toBe(false);
  release.resolve();
  await Promise.all([working, stopping]);
  expect(drained).toBe(true);
  expect(await decryptSecretBytes(fixture.stored.get("one")!.values.secret!, B)).toBe("A");
  expect(fixture.stored.get("two")!.values.secret).toBe(encrypted);
  expect(fixture.invalidated).toEqual(["one"]);
  expect(maintenance.metadata().owners?.[0]?.checkedAt).toBeNull();
});

test("a pass crossing another writer's ring change cannot certify an old-root row inserted behind its cursor", async () => {
  const encrypted = await encryptSecretBytes("retained");
  const fixture = memoryOwner(Array.from({ length: 120 }, (_, index) => ({ key: [String(index + 100)], values: { secret: encrypted } })));
  rotate();
  const maintenance = createSecretMaintenance([fixture.owner], changedAt);
  const firstStart = new Date().toISOString();
  const writerChange = changedAt + 10_000;
  const status = () => {
    const metadata = maintenance.metadata();
    return evaluateSecretRotation({
      registeredApps: ["core", "mail"],
      expect: [],
      now: new Date(),
      instances: [
        { appId: "core", instanceId: "core-one", secrets: metadata },
        { appId: "mail", instanceId: "mail-one", secrets: { ...metadata, changedAt: new Date(writerChange).toISOString(), owners: [] } },
        { appId: "gateway", instanceId: "gateway-one", secrets: { ...metadata, owners: [] } },
      ],
    });
  };
  try {
    await maintenance.tick();
    // Another process still writing A inserts a row behind Core's keyset cursor.
    // It then restarts with B, before Core's old pass finishes.
    fixture.stored.set("000", { key: ["000"], values: { secret: encrypted } });
    setSystemTime(writerChange + APP_REGISTRY_TTL_MS + 1);
    await maintenance.tick();
    expect(maintenance.metadata().owners?.[0]).toMatchObject({ rows: 120, previousOnly: 0, startedAt: firstStart });
    await expect(decryptSecretBytes(fixture.stored.get("000")!.values.secret!, B)).rejects.toThrow();
    expect(status().apps.find((app) => app.appId === "core")?.reasons).toContain("stale_owner_check:credentials");
    expect(status().ready).toBe(false);

    // Only a new complete pass after the writer's ring change and lease drain
    // can find the late insert and certify the table.
    const nextStart = new Date().toISOString();
    await maintenance.tick();
    setSystemTime(Date.now() + 1);
    await maintenance.tick();
    expect(await decryptSecretBytes(fixture.stored.get("000")!.values.secret!, B)).toBe("retained");
    expect(maintenance.metadata().owners?.[0]).toMatchObject({ rows: 121, previousOnly: 0, startedAt: nextStart });
    expect(status().ready).toBe(true);
  } finally {
    await maintenance.stop();
  }
});

test("a persistently failing owner does not block later owners and logs only its identity", async () => {
  const healthy = memoryOwner([{ key: ["one"], values: { secret: await encryptSecretBytes("retained") } }]);
  const failures: { message: string; metadata?: Record<string, unknown> }[] = [];
  const original = logging.logger;
  const logger = spyOn(logging, "logger").mockImplementation((source) => ({
    ...original(source),
    error: (message, metadata) => failures.push({ message, metadata }),
  }));
  let failedScans = 0;
  const failing: SecretOwner = {
    id: "unavailable",
    scan: async () => {
      failedScans++;
      throw new Error("fixture store unavailable");
    },
    compareAndSwap: async () => false,
  };
  rotate();
  const maintenance = createSecretMaintenance([failing, healthy.owner], changedAt);
  try {
    for (let round = 0; round < 2; round++) {
      await expect(maintenance.tick()).rejects.toThrow("fixture store unavailable");
      await maintenance.tick();
      expect(maintenance.metadata().owners?.[1]?.checkedAt).toBe(new Date().toISOString());
    }
    expect(failedScans).toBe(2);
    expect(maintenance.metadata().owners?.[0]?.checkedAt).toBeNull();
    expect(healthy.invalidated).toEqual(["one", "one"]);
    expect(failures).toHaveLength(2);
    expect(failures.map((failure) => failure.metadata)).toEqual([{ ownerId: "unavailable" }, { ownerId: "unavailable" }]);
    expect(JSON.stringify(failures)).not.toContain("fixture store unavailable");
  } finally {
    await maintenance.stop();
    logger.mockRestore();
  }
});
