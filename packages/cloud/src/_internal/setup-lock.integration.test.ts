// biome-ignore assist/source/organizeImports: Resolve test targets before any runtime imports.
import { requireDatabaseUrl, requireInfraUrl, suiteFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { SQL } from "bun";

const suite = suiteFor("database", "nats", "valkey");

type ProbeEvent = { event: string; at: number; message?: string; code?: string };
const until = async (condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(`Setup probe timed out: ${label}`);
    await Bun.sleep(Math.min(25, Math.max(1, deadline - Date.now())));
  }
};

suite("application setup across processes", () => {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const schema = `setup_lock_${suffix}`;
  const appId = `setup-lock-${suffix}`;
  const namespace = testSyncNamespace("setup-lock");
  let db: SQL;
  const children = new Set<ReturnType<typeof spawn>>();

  const spawn = (mode = "normal") => {
    const child = Bun.spawn({
      cmd: [process.execPath, "--no-env-file", new URL("./setup-lock.test-fixture.ts", import.meta.url).pathname, appId, schema, mode],
      env: {
        NODE_ENV: "production",
        DATABASE_URL: requireDatabaseUrl(),
        NATS_SERVERS: requireInfraUrl("nats"),
        NATS_CREDS_FILE: process.env.NATS_CREDS_FILE,
        NATS_IGNORE_CLUSTER_UPDATES: process.env.NATS_IGNORE_CLUSTER_UPDATES,
        REDIS_URL: requireInfraUrl("valkey"),
        SYNC_NAMESPACE: namespace,
        SYNC_REPLICAS: "1",
        APP_SECRET: process.env.APP_SECRET,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const events: ProbeEvent[] = [];
    let waiting = false;
    let outputError: unknown;
    const read = (async () => {
      for await (const line of createInterface({ input: Readable.from(child.stdout) })) {
        if (line.includes("waiting for setup on another replica")) waiting = true;
        if (line.startsWith("{")) {
          const event: ProbeEvent = JSON.parse(line);
          events.push(event);
        }
      }
    })().catch((error: unknown) => {
      outputError = error;
    });
    // Drain stderr too, without exposing credentials from arbitrary client diagnostics.
    const stderr = new Response(child.stderr).arrayBuffer();
    let exited = false;
    void child.exited.then(() => {
      exited = true;
    });
    const probe = {
      child,
      events,
      has: (event: string) => events.some((entry) => entry.event === event),
      waiting: () => waiting,
      send: () => {
        child.stdin.write("continue\n");
        child.stdin.flush();
      },
      wait: (event: string, timeoutMs?: number) =>
        until(
          () => {
            if (outputError) throw outputError;
            const failed = events.find((entry) => entry.event === "failed");
            if (failed) throw new Error(`Setup child failed (${failed.code ?? "unknown"}): ${failed.message}`);
            if (probe.has(event)) return true;
            if (exited) throw new Error(`Setup child exited before ${event}`);
            return false;
          },
          event,
          timeoutMs,
        ),
      stop: async () => {
        if (!exited) {
          if (probe.has("ready")) probe.send();
          else child.kill("SIGKILL");
          await until(() => exited, "child shutdown", 10_000).catch(() => {
            child.kill("SIGKILL");
          });
        }
        await child.exited;
        await Promise.all([read, stderr]);
        children.delete(probe);
      },
    };
    children.add(probe);
    return probe;
  };

  beforeAll(() => {
    // A real start loads Core's settings tables; use the Core-bootstrapped test DB,
    // and keep all probe DDL in this suite's throwaway schema.
    db = new SQL(requireDatabaseUrl());
  });
  afterAll(async () => {
    try {
      await Promise.all([...children].map((child) => child.stop()));
    } finally {
      if (db) {
        try {
          await db.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).simple();
        } finally {
          await db.close();
        }
      }
    }
  }, 20_000);

  const releaseDdl = async (a: ReturnType<typeof spawn>, b: ReturnType<typeof spawn>) => {
    await until(async () => {
      for (const probe of [a, b]) {
        const failed = probe.events.find((event) => event.event === "failed");
        if (failed) throw new Error(`Setup failed: ${failed.code}: ${failed.message}`);
      }
      if (!a.has("schema-created") && !b.has("schema-created")) return false;
      if (a.waiting() || b.waiting() || (a.has("schema-created") && b.has("schema-created"))) return true;
      // Negative control: the second CREATE SCHEMA has reached Postgres and is
      // waiting on the first transaction. Releasing it now produces the catalog race.
      const [state] = await db<{ blocked: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = ${`cloud:${appId}`}
          AND wait_event_type = 'Lock' AND query LIKE ${`CREATE SCHEMA IF NOT EXISTS ${schema}%`}) AS blocked`;
      return state?.blocked === true;
    }, "both replicas contending for setup");
    // The second command can be buffered while that child is still waiting for the lease.
    a.send();
    b.send();
  };

  for (const temperature of ["cold", "warm"] as const) {
    for (let round = 1; round <= 10; round++) {
      test(`${temperature} round ${round}: both replicas become ready without overlapping setup`, async () => {
        if (temperature === "cold") await db.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).simple();
        const a = spawn();
        const b = spawn();
        try {
          await Promise.all([a.wait("armed"), b.wait("armed")]);
          a.send();
          b.send();
          await releaseDdl(a, b);
          await Promise.all([a.wait("ready"), b.wait("ready")]);
          const intervals = [a, b]
            .map((probe) => {
              expect(probe.has("failed")).toBe(false);
              const start = probe.events.find((event) => event.event === "setup-start");
              const end = probe.events.find((event) => event.event === "setup-end");
              if (!start || !end) throw new Error("Missing setup interval");
              return { start: start.at, end: end.at };
            })
            .sort((x, y) => x.start - y.start);
          expect(intervals[0]!.end).toBeLessThanOrEqual(intervals[1]!.start);
        } finally {
          await Promise.all([a.stop(), b.stop()]);
        }
        expect(await a.child.exited).toBe(0);
        expect(await b.child.exited).toBe(0);
      }, 60_000);
    }
  }

  test("a killed holder expires and a waiting replica completes the partial schema", async () => {
    await db.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).simple();
    const a = spawn("hold");
    let b: ReturnType<typeof spawn> | undefined;
    try {
      await a.wait("armed");
      a.send();
      await a.wait("partial");
      b = spawn();
      const waiter = b;
      await b.wait("armed");
      b.send();
      await until(() => waiter.waiting(), "waiting log");
      const killedAt = performance.timeOrigin + performance.now();
      a.child.kill("SIGKILL");
      await a.child.exited;
      // Buffer the DDL barrier release; the child is still acquiring the expired lease.
      b.send();
      await b.wait("ready", 100_000);
      const start = b.events.find((event) => event.event === "setup-start");
      expect(start?.at).toBeGreaterThan(killedAt);
      expect(b.waiting()).toBe(true);
      expect(performance.timeOrigin + performance.now() - killedAt).toBeLessThan(100_000);
      const [state] = await db<{ complete: boolean }[]>`
        SELECT to_regclass(${`${schema}.items_value_idx`}) IS NOT NULL
          AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = ${`${schema}.items`}::regclass AND conname = 'value_positive')
          AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = ${`${schema}.items`}::regclass AND tgname = 'check_item') AS complete`;
      expect(state?.complete).toBe(true);
      // The trigger function and check constraint are usable after recovering partial setup.
      await db.unsafe(`INSERT INTO ${schema}.items (id, value) VALUES (1, 1)`).simple();
      // A Bun SQL query runs only once awaited; `expect(query).rejects` never starts it.
      const rejected = await db
        .unsafe(`INSERT INTO ${schema}.items (id, value) VALUES (2, -1)`)
        .simple()
        .then(
          () => null,
          (error: unknown) => error,
        );
      if (!(rejected instanceof SQL.PostgresError)) throw new Error(`Expected a check violation, got ${String(rejected)}`);
      expect(rejected.errno).toBe("23514");
    } finally {
      await Promise.all([a.stop(), b?.stop()]);
    }
    expect(await b?.child.exited).toBe(0);
  }, 130_000);
});
