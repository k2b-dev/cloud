import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { installFixtureStore } from "../store/base-store.test-fixture";
import { mirrorPendingSources } from "./source-mirror";
import { writeFixture } from "./write.test-fixture";

suiteFor(
  "database",
  "valkey",
  "clickhouse",
)("Pulse source mirrors", () => {
  beforeAll(installFixtureStore, 30000);
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
