import { sql } from "bun";
import { clickhouseTestPrefix } from "../../../../scripts/fixtures/test-clickhouse";
import { createBaseStore } from "../store/base-store";
import { cleanupFixtureBase, fixtureBase, fixtureConnection, fixtureStore } from "../store/base-store.test-fixture";
import { StoreQueryError } from "../store/client";
import { quoteIdentifier as q } from "../store/validation";
import { createBaseLifecycle } from "./base-lifecycle";
import { deterministicRowId } from "./ingest-bulk";
import { createIngestWriter } from "./ingest-writer";

export const writeFixture = async (name: string) => {
  let instant = new Date("2026-10-17T12:00:00Z");
  const clock = () => new Date(instant);
  const base = await fixtureBase(deterministicRowId(clickhouseTestPrefix, name, "base", 0));
  const sourceId = deterministicRowId(clickhouseTestPrefix, name, "source", 0);
  await createBaseLifecycle(fixtureStore())(base.id);
  await sql`INSERT INTO pulse.sources(id,short_id,base_id,kind,name,created_at,updated_at) VALUES(${sourceId}::uuid,${sourceId.replaceAll("-", "").slice(0, 6)},${base.id}::uuid,'http_ingest','Write fixture',${clock()},${clock()})`;
  let inserts = 0,
    abortAt: number | null = null;
  const store = createBaseStore({ prefix: clickhouseTestPrefix, connection: async () => fixtureConnection(), clock });
  const query = store.query;
  store.query = async (statement, params) => {
    if (statement.startsWith("INSERT INTO") && ++inserts === abortAt) throw new StoreQueryError("unreachable");
    return query(statement, params);
  };
  // Independent store/ingest instances share no caches or deduplication state.
  const other = createBaseStore({ prefix: clickhouseTestPrefix, connection: async () => fixtureConnection(), clock });
  const writer = createIngestWriter({ store, clock }),
    writerB = createIngestWriter({ store: other, clock });
  const write = (batch: Parameters<typeof writer>[0]["batch"], idempotencyKey?: string) =>
    writer({ baseId: base.id, sourceId, batch, idempotencyKey });
  const writeB = (batch: Parameters<typeof writer>[0]["batch"], idempotencyKey?: string) =>
    writerB({ baseId: base.id, sourceId, batch, idempotencyKey });
  return {
    base,
    sourceId,
    store,
    other,
    clock,
    write,
    writeB,
    setTime: (date: string) => {
      instant = new Date(date);
    },
    failInsert: (ordinal: number) => {
      inserts = 0;
      abortAt = ordinal;
    },
    recover: () => {
      abortAt = null;
    },
    read: (view: string, columns = "*", suffix = "") => query(`SELECT ${columns} FROM ${q(base.database)}.${view} ${suffix}`),
    stopMerges: async () => {
      const { clickhouseAdminQuery } = await import("../../../../scripts/fixtures/test-clickhouse");
      for (const table of ["_samples", "_rollups", "_series", "_events", "_states_current", "_state_changes", "_sources"])
        await clickhouseAdminQuery(`SYSTEM STOP MERGES ${q(base.database)}.${table}`);
    },
    cleanup: () => cleanupFixtureBase(base),
  };
};
export const assertWrite = (result: Awaited<ReturnType<ReturnType<typeof createIngestWriter>>>) => {
  if (!result.ok) throw new Error(`${result.error.status}: ${result.error.message}`);
  return result.data;
};
