import { expect, test } from "bun:test";
import { sql } from "bun";
import { newShortId } from "../lib/short-id";
import { markMetricHoursDirty, runHourlyRollup } from "./metric-rollups";

const dbTest = process.env.PULSE_METRIC_QUERY_DB_TEST === "1" ? test : test.skip;
const HOUR = 3_600_000;
const deferred = () => Promise.withResolvers<void>();
const until = async (check: () => Promise<boolean>) => {
  const deadline = performance.now() + 5_000;
  while (!(await check())) {
    if (performance.now() >= deadline) throw Error("Concurrent database operation did not reach its expected lock state");
    await Bun.sleep(20);
  }
};
const blockedBy = async (pid: number) => {
  const [row] = await sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid}::int=ANY(pg_blocking_pids(pid))) AS blocked`;
  return row.blocked === true;
};
const fixture = async (run: (base: string, hour: Date, series: string[]) => Promise<void>) => {
  const target = new URL(process.env.DATABASE_URL ?? "");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || target.pathname !== "/pulse_analytics_test") {
    throw Error("Metric concurrency tests require loopback pulse_analytics_test");
  }
  const [database] = await sql`SELECT current_database() AS name`;
  if (database.name !== "pulse_analytics_test") throw Error("Wrong disposable database");
  const base = crypto.randomUUID();
  await sql`INSERT INTO pulse.bases(id,short_id,name) VALUES(${base}::uuid,${newShortId()},'Hour concurrency')`;
  try {
    const [metric] = await sql`INSERT INTO pulse.metric_defs(base_id,name) VALUES(${base}::uuid,'concurrency') RETURNING id`;
    const series = [];
    for (let i = 0; i < 2; i++) {
      const [row] = await sql`INSERT INTO pulse.metric_series(base_id,metric_id,series_key,dimensions_hash)
        VALUES(${base}::uuid,${metric.id}::uuid,${String(i)},'fixture') RETURNING id`;
      series.push(String(row.id));
    }
    await run(base, new Date(Math.floor(Date.now() / HOUR) * HOUR - 3 * HOUR), series);
  } finally {
    await sql`DELETE FROM pulse.bases WHERE id=${base}::uuid`;
  }
};

dbTest(
  "dirty-hour writers overlap while a real rollup waits for both commits",
  () =>
    fixture(async (base, hour, series) => {
      await sql`INSERT INTO pulse.metric_hours(base_id,hour,state) VALUES(${base}::uuid,${hour},'dirty')`;
      const releases = [deferred(), deferred()];
      const pids: number[] = [0, 0];
      const writers = series.map((id, index) =>
        sql.begin(async (tx) => {
          await markMetricHoursDirty(base, [hour.toISOString()], tx);
          const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
          pids[index] = Number(backend.pid);
          await tx`INSERT INTO pulse.metric_samples(base_id,series_id,ts,value)
      VALUES(${base}::uuid,${id}::uuid,${new Date(hour.getTime() + 60_000)},${index + 1})`;
          await releases[index]!.promise;
        }),
      );
      let rollup: Promise<unknown> | undefined;
      let rolledUp = false;
      try {
        await until(async () => pids.every((pid) => pid !== 0));
        expect(pids.length).toBe(2);
        rollup = runHourlyRollup(base).then((result) => {
          rolledUp = true;
          return result;
        });
        await until(() => blockedBy(pids[0]!));
        expect(rolledUp).toBe(false);
        releases[0]!.resolve();
        await writers[0];
        await until(() => blockedBy(pids[1]!));
        expect(rolledUp).toBe(false);
        releases[1]!.resolve();
        await Promise.all(writers);
        await rollup;
        const [result] =
          await sql`SELECT sum(sample_count) AS samples,sum(value_sum) AS value FROM pulse.metric_rollups_hourly WHERE base_id=${base}::uuid`;
        expect(Number(result.samples)).toBe(2);
        expect(Number(result.value)).toBe(3);
        const [state] = await sql`SELECT state FROM pulse.metric_hours WHERE base_id=${base}::uuid AND hour=${hour}`;
        expect(state.state).toBe("clean");
      } finally {
        releases.forEach((release) => release.resolve());
        await Promise.allSettled([...writers, ...(rollup ? [rollup] : [])]);
      }
    }),
  30_000,
);

dbTest(
  "oppositely ordered batches transition clean and missing hours without lock upgrades",
  () =>
    fixture(async (base, hour) => {
      const timestamps = [0, 1, 2].map((offset) => new Date(hour.getTime() + offset * HOUR).toISOString());
      await sql`INSERT INTO pulse.metric_hours(base_id,hour,state) VALUES(${base}::uuid,${timestamps[0]}::timestamptz,'clean'),
    (${base}::uuid,${timestamps[1]}::timestamptz,'dirty')`;
      const release = deferred();
      let ownerPid = 0;
      const first = sql.begin(async (tx) => {
        await markMetricHoursDirty(base, [...timestamps].reverse(), tx);
        const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
        ownerPid = Number(backend.pid);
        await release.promise;
      });
      let second: Promise<unknown> | undefined;
      try {
        await until(async () => ownerPid !== 0);
        second = sql.begin((tx) => markMetricHoursDirty(base, timestamps, tx));
        await until(() => blockedBy(ownerPid));
        release.resolve();
        await first;
        await second;
        const rows = await sql<{ state: string }[]>`SELECT state FROM pulse.metric_hours WHERE base_id=${base}::uuid ORDER BY hour`;
        expect(rows.map((row) => row.state)).toEqual(["dirty", "dirty", "dirty"]);
      } finally {
        release.resolve();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
      }
    }),
  30_000,
);

dbTest(
  "a waiting writer dirties a newly completed hour and rejects a newly sealed hour",
  () =>
    fixture(async (base, hour) => {
      await sql`INSERT INTO pulse.metric_hours(base_id,hour,state) VALUES(${base}::uuid,${hour},'dirty')`;
      for (const state of ["clean", "sealed"] as const) {
        const release = deferred();
        let ownerPid = 0;
        const transition = sql.begin(async (tx) => {
          await tx`SELECT hour FROM pulse.metric_hours WHERE base_id=${base}::uuid AND hour=${hour} FOR UPDATE`;
          const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
          ownerPid = Number(backend.pid);
          await release.promise;
          await tx`UPDATE pulse.metric_hours SET state=${state} WHERE base_id=${base}::uuid AND hour=${hour}`;
        });
        let writer: Promise<unknown> | undefined;
        try {
          await until(async () => ownerPid !== 0);
          writer = sql
            .begin((tx) => markMetricHoursDirty(base, [hour.toISOString()], tx))
            .then(
              () => null,
              (error: unknown) => error,
            );
          await until(() => blockedBy(ownerPid));
          release.resolve();
          await transition;
          const outcome = await writer;
          if (state === "clean") expect(outcome).toBeNull();
          else expect(outcome).toMatchObject({ message: "Metric hour is sealed after raw retention" });
          const [actual] = await sql`SELECT state FROM pulse.metric_hours WHERE base_id=${base}::uuid AND hour=${hour}`;
          expect(actual.state).toBe(state === "clean" ? "dirty" : "sealed");
        } finally {
          release.resolve();
          await Promise.allSettled([transition, ...(writer ? [writer] : [])]);
        }
      }
    }),
  30_000,
);

dbTest(
  "a sealed later hour rolls back earlier hour transitions",
  () =>
    fixture(async (base, hour) => {
      const later = new Date(hour.getTime() + HOUR);
      await sql`INSERT INTO pulse.metric_hours(base_id,hour,state) VALUES(${base}::uuid,${hour},'clean'),(${base}::uuid,${later},'sealed')`;
      let rejected = false;
      try {
        await sql.begin((tx) => markMetricHoursDirty(base, [later.toISOString(), hour.toISOString()], tx));
      } catch (error) {
        expect(error).toMatchObject({ message: "Metric hour is sealed after raw retention" });
        rejected = true;
      }
      expect(rejected).toBe(true);
      const rows = await sql<{ state: string }[]>`SELECT state FROM pulse.metric_hours WHERE base_id=${base}::uuid ORDER BY hour`;
      expect(rows.map((row) => row.state)).toEqual(["clean", "sealed"]);
    }),
  30_000,
);
