import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { suiteFor, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAuth } from "../migrate/core/auth";
import { migrate as migrateCode } from "../migrate/core/code";
import { migrate as migrateJobs } from "../migrate/core/code-jobs";
import { migrate as migrateScheduling } from "../migrate/core/code-scheduling";
import { migrate as migrateEvents } from "../migrate/core/events";
import { migrate as migrateSettings } from "../migrate/core/settings";
import { codeRunReadsQuery, parseCodeRouteReads } from "./requests";
import { appendCodeCall, finishCodeCall } from "./store";

const owner = "11111111-1111-4111-8111-111111111111";
const codeId = "c_readstest";
const runId = "55555555-5555-4555-8555-555555555555";
const otherRunId = "66666666-6666-4666-8666-666666666666";

suiteFor("database")("Code route reads for the visitor check (G1)", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  let versionId: string;
  const call = async (
    run: string,
    kind: "query" | "action",
    capability: string,
    target: { type: string; id: string } | null,
    input: unknown,
    state: "succeeded" | "failed" | "running",
    refs: Record<string, { type: string; id: string }> = {},
  ) => {
    const ordinal = await sql.begin((tx) => appendCodeCall({ runId: run, kind, call: { capability, target, refs, input } }, tx));
    if (state !== "running")
      await sql.begin((tx) =>
        finishCodeCall(
          { runId: run, ordinal, state, result: state === "succeeded" ? { ok: true } : { ok: false }, endedAt: new Date() },
          tx,
        ),
      );
  };
  beforeAll(async () => {
    setSystemTime(new Date("2026-11-21T12:00:00.000Z"));
    database = await useFreshDatabase("core_code_page_reads");
    for (const migrate of [migrateAuth, migrateEvents, migrateSettings, migrateCode, migrateScheduling, migrateJobs]) await migrate();
    await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${owner}::uuid,'owner','local','user')`;
    await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title) VALUES(${codeId},'person',${owner}::uuid,'Reads fixture')`;
    const [version] = await sql<{ id: string }[]>`INSERT INTO code.versions
      (code_id,number,source_files,bundle,source_hash,bundle_hash,source_bytes,bundle_bytes,created_by)
      VALUES(${codeId},1,'{"code.ts":"fixture"}'::jsonb,'fixture',${"a".repeat(64)},${"b".repeat(64)},7,7,${owner}::uuid) RETURNING id`;
    versionId = version!.id;
    for (const id of [runId, otherRunId]) {
      await sql`INSERT INTO code.runs(id,code_id,version_id,trigger,entrypoint,payload_bytes,calls_limit)
        VALUES(${id}::uuid,${codeId},${versionId}::uuid,'manual','run',32768,20)`;
      await sql`UPDATE code.runs SET state='running',started_at=clock_timestamp() WHERE id=${id}::uuid`;
    }
  });
  afterAll(async () => {
    setSystemTime();
    await database?.drop();
  });

  test("succeeded Queries name themselves, their targets, refs and reader ids once; writes, failures and other runs do not count", async () => {
    const base = { type: "pulse.base", id: "Base01" };
    await call(runId, "query", "pulse.base.sql.run", base, { sql: "SELECT 1" }, "succeeded");
    await call(runId, "query", "pulse.base.sql.run", base, { sql: "SELECT 2" }, "succeeded");
    await call(runId, "query", "grids.row.list", { type: "grids.table", id: "T1" }, {}, "succeeded", {
      view: { type: "grids.view", id: "V1" },
    });
    await call(runId, "query", "pulse.source.read", null, { id: "Src001" }, "succeeded");
    await call(runId, "query", "pulse.base.list", null, { query: "x" }, "succeeded");
    await call(runId, "query", "pulse.base.sql.run", { type: "pulse.base", id: "Failed" }, { sql: "x" }, "failed");
    await call(runId, "query", "pulse.base.sql.run", { type: "pulse.base", id: "Pending" }, { sql: "x" }, "running");
    await call(runId, "action", "pulse.saved_query.save", { type: "pulse.base", id: "Write1" }, { name: "n", sql: "x" }, "succeeded");
    await call(otherRunId, "query", "pulse.base.sql.run", { type: "pulse.base", id: "Other1" }, { sql: "x" }, "succeeded");
    const [row] = await sql<{ reads: unknown }[]>`SELECT (${codeRunReadsQuery(runId)}) AS reads`;
    const reads = parseCodeRouteReads(row!.reads);
    const key = (read: (typeof reads)[number]) => JSON.stringify(read);
    expect(reads.map(key).sort()).toEqual(
      [
        { kind: "target", ref: base },
        { kind: "target", ref: { type: "grids.table", id: "T1" } },
        { kind: "target", ref: { type: "grids.view", id: "V1" } },
        { kind: "reader", capability: "pulse.source.read", id: "Src001" },
        { kind: "query", capability: "pulse.base.sql.run" },
        { kind: "query", capability: "grids.row.list" },
        { kind: "query", capability: "pulse.source.read" },
        { kind: "query", capability: "pulse.base.list" },
      ]
        .map((read) => JSON.stringify(read))
        .sort(),
    );
    const [empty] = await sql<{ reads: unknown }[]>`SELECT (${codeRunReadsQuery("77777777-7777-4777-8777-777777777777")}) AS reads`;
    expect(parseCodeRouteReads(empty!.reads)).toEqual([]);
  });
});
