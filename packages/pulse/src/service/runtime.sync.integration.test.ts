import { expect } from "bun:test";
import { sql } from "bun";
import { testFor } from "../../../../scripts/fixtures/test-infra";

const syncTest = testFor("database", "nats");
syncTest(
  "scrape jobs retry a rolled-back write, hourly jobs catch up, and runtime drains an active scrape",
  async () => {
    const { migrate: auth } = await import("../../../core/src/migrate/core/auth");
    const { migrate: logging } = await import("../../../core/src/migrate/core/logging");
    await auth();
    await logging();
    const { createSync } = await import("@k2b/sync");
    const { connect } = await import("@nats-io/transport-node");
    const { bindProcessSync, unbindProcessSync } = await import("@k2b/cloud");
    const { pulseRuntime } = await import("./runtime");
    const { ingestBatch } = await import("./ingest-writer");
    const { newShortId } = await import("../lib/short-id");
    const { initializeSchema } = await import("../schema");
    await initializeSchema();
    const connection = await connect({
      servers: process.env.NATS_SERVERS ?? "nats://localhost:4222",
      ignoreClusterUpdates: true,
    });
    const namespace = `pulse-runtime-test-${crypto.randomUUID()}`;
    const sync = createSync({
      connection,
      namespace,
      application: "pulse",
      defaults: { replicas: 1 },
    });
    const baseId = crypto.randomUUID(),
      sourceId = crypto.randomUUID(),
      baseShort = newShortId(),
      sourceShort = newShortId();
    const suffix = baseId.replaceAll("-", ""),
      sequence = `pulse.probe_seq_${suffix}`,
      fn = `pulse.probe_fn_${suffix}`,
      trigger = `probe_${suffix}`;
    let calls = 0,
      hold = false;
    const fetchedAt: number[] = [];
    let entered: () => void = () => {},
      release: () => void = () => {};
    const response = "# TYPE probe gauge\nprobe 42\n";
    const exporter = Bun.serve({
      port: 0,
      fetch: async () => {
        calls++;
        fetchedAt.push(performance.now());
        if (hold) {
          entered();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return new Response(response);
      },
    });
    const until = async (check: () => Promise<boolean>, timeoutMs: number) => {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        if (await check()) return;
        await Bun.sleep(50);
      }
      throw Error("Runtime proof timed out");
    };
    bindProcessSync(sync);
    try {
      await sql`INSERT INTO pulse.bases(id,short_id,name) VALUES(${baseId}::uuid,${baseShort},'Runtime proof')`;
      await sql`INSERT INTO pulse.sources(id,short_id,base_id,kind,name,endpoint_url,scrape_interval_seconds)
    VALUES(${sourceId}::uuid,${sourceShort},${baseId}::uuid,'metrics','Exporter',${`http://127.0.0.1:${exporter.port}`},NULL)`;
      // Sequences survive rollback: exactly the first sample write fails at the real DB seam.
      await sql.unsafe(`CREATE SEQUENCE ${sequence}`);
      await sql.unsafe(
        `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF nextval('${sequence}')=1 THEN RAISE EXCEPTION 'intentional first-write failure'; END IF; RETURN NEW; END $$`,
      );
      await sql.unsafe(
        `CREATE TRIGGER ${trigger} BEFORE INSERT ON pulse.metric_samples FOR EACH ROW WHEN (NEW.base_id='${baseId}'::uuid) EXECUTE FUNCTION ${fn}()`,
      );
      await pulseRuntime.start();
      const scheduler = sync.scheduler({
        id: "pulse",
        delivery: { maxAttempts: 3, backoffMs: [60000, 120000] },
      });
      for (const id of ["pulse:metrics:scrape-due", "pulse:rollup:hourly", "pulse:retention"]) await scheduler.pause({ id });
      const job = sync.job<{
        baseId: string;
        publicBaseId: string;
        sourceId: string;
        publicSourceId: string;
        slotTs: number;
      }>({
        id: "pulse:metrics:scrape",
        delivery: {
          ackWaitMs: 60000,
          maxAttempts: 3,
          backoffMs: [30000, 60000],
        },
      });
      const input = {
        baseId,
        publicBaseId: baseShort,
        sourceId,
        publicSourceId: sourceShort,
        slotTs: Date.now(),
      };
      await job.submit({ key: `retry:${sourceId}`, input });
      await until(async () => {
        const [row] = await sql`SELECT count(*)::int AS count FROM pulse.metric_samples WHERE base_id=${baseId}::uuid`;
        return row?.count === 1;
      }, 45000);
      expect(calls).toBe(2);
      expect(fetchedAt[1]! - fetchedAt[0]!).toBeGreaterThanOrEqual(29000);
      const [success] = await sql`SELECT count(*)::int AS count FROM pulse.source_scrapes WHERE base_id=${baseId}::uuid AND success`;
      expect(success?.count).toBe(1);
      await sql.unsafe(`DROP TRIGGER ${trigger} ON pulse.metric_samples`);
      const old = new Date(Math.floor(Date.now() / 3600000) * 3600000 - 72 * 3600000).toISOString();
      expect(
        (
          await ingestBatch({
            baseId,
            sourceId,
            batch: {
              metrics: [0, 1, 2].map((offset) => ({
                name: "history",
                value: 7,
                ts: new Date(Date.parse(old) + offset * 3600000).toISOString(),
              })),
            },
          })
        ).ok,
      ).toBe(true);
      const rollup = sync.job<void>({
        id: "pulse:rollup:hourly",
        delivery: {
          ackWaitMs: 300000,
          maxAttempts: 3,
          backoffMs: [60000, 120000],
        },
      });
      await rollup.submit({ key: `catchup:${baseId}`, input: undefined });
      await until(async () => {
        const [row] =
          await sql`SELECT count(*)::int AS count FROM pulse.metric_hours WHERE base_id=${baseId}::uuid AND hour>=${old}::timestamptz AND hour<${new Date(Date.parse(old) + 3 * 3600000)} AND state='clean'`;
        return row?.count === 3;
      }, 10000);
      hold = true;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      await job.submit({
        key: `drain:${sourceId}`,
        input: { ...input, slotTs: input.slotTs + 60000 },
      });
      await Promise.race([
        started,
        Bun.sleep(10000).then(() => {
          throw Error("Scrape did not start");
        }),
      ]);
      const draining = pulseRuntime.stop();
      expect(await Promise.race([draining.then(() => true), Bun.sleep(50).then(() => false)])).toBe(false);
      release();
      await draining;
      expect(sync.health().activeHandlers).toBe(0);
      const [samples] = await sql`SELECT count(*)::int AS count FROM pulse.metric_samples WHERE base_id=${baseId}::uuid`;
      expect(samples?.count).toBe(5);
      const drained = await sync.drain({ timeoutMs: 5000 });
      expect(drained.timedOut).toBe(false);
    } finally {
      release();
      await pulseRuntime.stop();
      await sync.drain({ timeoutMs: 5000 });
      unbindProcessSync();
      exporter.stop(true);
      await sql.unsafe(`DROP TRIGGER IF EXISTS ${trigger} ON pulse.metric_samples`);
      await sql.unsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
      await sql.unsafe(`DROP SEQUENCE IF EXISTS ${sequence}`);
      const {
        jetstreamManager,
      }: {
        jetstreamManager(client: typeof connection): Promise<{
          streams: {
            list(): AsyncIterable<{
              config: { name: string; metadata?: Record<string, string> };
            }>;
            delete(name: string): Promise<boolean>;
          };
        }>;
      } = await import(Bun.resolveSync("@nats-io/jetstream", new URL(".", import.meta.resolve("@k2b/sync")).pathname));
      const manager = await jetstreamManager(connection);
      const ownedStreams: string[] = [];
      for await (const stream of manager.streams.list())
        if (stream.config.metadata?.["sync.namespace"] === namespace) ownedStreams.push(stream.config.name);
      await Promise.all(ownedStreams.map((name) => manager.streams.delete(name)));
      await connection.drain();
      await sql`DELETE FROM pulse.bases WHERE id=${baseId}::uuid`;
    }
  },
  120000,
);
