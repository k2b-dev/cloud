import { afterAll, beforeAll, expect, test } from "bun:test";
import { createSync, type Sync } from "@k2b/sync";
import { connectTestNats, suiteFor, testSyncNamespace, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { migrate as migrateLogging } from "../../../../core/src/migrate/core/logging";
import { bindProcessSync, unbindProcessSync } from "../../_internal/process-sync";
import { sql } from "../../runtime/clients";
import { startLinksRuntime } from "./runtime";

suiteFor("database", "nats")("one shared platform link retention schedule", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>> | undefined;
  let connection: Awaited<ReturnType<typeof connectTestNats>> | undefined;
  const instances: Sync[] = [];
  const stops: Array<() => Promise<void>> = [];
  beforeAll(async () => {
    database = await useFreshDatabase("one_time_links_runtime");
    await migrateLogging();
    connection = await connectTestNats({ ignoreClusterUpdates: true });
    const namespace = testSyncNamespace("links-runtime");
    for (const application of ["invoices", "website"]) {
      const sync = createSync({ connection, namespace, application, defaults: { replicas: 1 } });
      instances.push(sync);
      bindProcessSync(sync);
      try {
        stops.push(await startLinksRuntime());
      } finally {
        unbindProcessSync();
      }
    }
  });
  afterAll(async () => {
    try {
      for (const stop of stops.toReversed()) await stop();
      for (const sync of instances) await sync.drain({ timeoutMs: 5000 });
    } finally {
      unbindProcessSync();
      await connection?.drain();
      await sql.close();
      await database?.drop();
    }
  });

  test("different apps share one serial schedule and deduplicate the same accepted cleanup run", async () => {
    const schedules = instances.map((sync) => sync.controls().find((control) => control.kind === "scheduler"));
    const [first, second] = schedules;
    if (!first || first.kind !== "scheduler" || !second || second.kind !== "scheduler") throw new Error("missing retention schedule");
    expect(first.id).toBe("cloud-links-retention");
    expect(second.id).toBe(first.id);
    expect(first.owner).toBe("platform");
    expect(second.owner).toBe(first.owner);
    expect((await first.scheduler.list()).map((schedule) => schedule.id)).toEqual(["retention"]);
    expect((await second.scheduler.list()).map((schedule) => schedule.id)).toEqual(["retention"]);
    await sql`INSERT INTO platform._cloud_links (package, token_hash, purpose, subject, created_at, expires_at)
      VALUES ('test-package', 'expired', 'portal.login', ''::bytea,
        statement_timestamp() - interval '2 days', statement_timestamp() - interval '25 hours')`;
    const requestId = "retention-contract-test";
    const [a, b] = await Promise.all([
      first.scheduler.runNow({ id: "retention", requestId }),
      second.scheduler.runNow({ id: "retention", requestId }),
    ]);
    expect(a.runId).toBe(b.runId);
    expect(await first.scheduler.awaitRun({ id: "retention", runId: a.runId, timeoutMs: 10000 })).toEqual({ completed: true });
    const [row] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM platform._cloud_links`;
    expect(row?.count).toBe(0);
  });
});
