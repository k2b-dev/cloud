import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { installFixtureStore } from "../store/base-store.test-fixture";
import { quoteIdentifier as q } from "../store/validation";
import { createBaseLifecycle } from "./base-lifecycle";
import { mirrorPendingSources } from "./source-mirror";
import { assertWrite, writeFixture } from "./write.test-fixture";

suiteFor(
  "database",
  "valkey",
  "clickhouse",
)("Pulse source mirrors", () => {
  beforeAll(installFixtureStore, 30000);
  for (const scenario of ["provision", "clear", "provision-retry"] as const)
    test(`missing database ${scenario} requeues source mirrors and surviving series`, async () => {
      const operation = scenario === "clear" ? "clear" : "provision";
      const f = await writeFixture(`mirror-rebuild-${scenario}`);
      try {
        await mirrorPendingSources(f.base.id, f.store);
        assertWrite(await f.write({ metrics: [{ name: "load", value: 1 }] }));
        expect(await f.read("sources", "name")).toEqual([{ name: "Write fixture" }]);
        expect((await sql`SELECT mirrored FROM pulse.metric_series WHERE base_id=${f.base.id}::uuid`)[0]?.mirrored).toBe(true);
        await f.store.query(`DROP DATABASE ${q(f.base.database)} SYNC`);
        // A CREATE DATABASE can survive the rollback of its Postgres schema-version reset.
        if (scenario === "provision-retry") await f.store.query(`CREATE DATABASE ${q(f.base.database)}`);
        await sql`UPDATE pulse.base_stores SET state=${operation === "clear" ? "clearing" : "provisioning"},operation=${operation},
          schema_version=CASE WHEN ${operation === "clear"} THEN 0 ELSE schema_version END WHERE base_id=${f.base.id}::uuid`;
        const run = createBaseLifecycle(f.store);
        let done = false;
        for (let i = 0; i < 20 && !done; i++) done = (await run(f.base.id)).done;
        expect(done).toBe(true);
        expect(await f.read("sources")).toHaveLength(0);
        expect((await sql`SELECT mirror_pending FROM pulse.sources WHERE id=${f.sourceId}::uuid`)[0]?.mirror_pending).toBe(true);
        if (operation === "provision")
          expect((await sql`SELECT mirrored FROM pulse.metric_series WHERE base_id=${f.base.id}::uuid`)[0]?.mirrored).toBe(false);
        await mirrorPendingSources(f.base.id, f.store);
        expect(await f.read("sources", "name")).toEqual([{ name: "Write fixture" }]);
        assertWrite(await f.write({ metrics: [{ name: "load", value: 2 }] }));
        expect(await f.read("series", "metric")).toEqual([{ metric: "load" }]);
      } finally {
        await f.cleanup();
      }
    }, 60000);
  test("pending creates/updates/deletes retry after a failed insert and tombstones hide immediately", async () => {
    const f = await writeFixture("source-mirror");
    try {
      await f.stopMerges();
      await mirrorPendingSources(f.base.id, f.store, f.sourceId);
      expect(await f.read("sources", "name")).toEqual([{ name: "Write fixture" }]);
      await sql`UPDATE pulse.sources SET name='Changed',mirror_pending=true,updated_at=${new Date(f.clock().getTime() + 1)} WHERE id=${f.sourceId}::uuid`;
      f.failInsert(1);
      await expect(mirrorPendingSources(f.base.id, f.store, f.sourceId)).rejects.toThrow();
      const [pending] = await sql`SELECT mirror_pending FROM pulse.sources WHERE id=${f.sourceId}::uuid`;
      expect(pending?.mirror_pending).toBe(true);
      f.recover();
      await mirrorPendingSources(f.base.id, f.store, f.sourceId);
      expect(await f.read("sources", "name")).toEqual([{ name: "Changed" }]);
      await sql`UPDATE pulse.sources SET deleted=true,enabled=false,mirror_pending=true,updated_at=${new Date(f.clock().getTime() + 2)} WHERE id=${f.sourceId}::uuid`;
      f.failInsert(1);
      await expect(mirrorPendingSources(f.base.id, f.store, f.sourceId)).rejects.toThrow();
      f.recover();
      await mirrorPendingSources(f.base.id, f.store, f.sourceId);
      expect(await f.read("sources")).toHaveLength(0);
      expect(await sql`SELECT id FROM pulse.sources WHERE id=${f.sourceId}::uuid`).toHaveLength(0);
    } finally {
      await f.cleanup();
    }
  }, 60000);
});
