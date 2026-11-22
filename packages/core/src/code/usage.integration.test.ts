import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import * as capabilities from "@k2b/cloud/capabilities/server";
import type { RequestAuthority } from "@k2b/cloud/server";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAuth } from "../migrate/core/auth";
import { migrate as migrateCode } from "../migrate/core/code";
import { migrate as migrateJobs } from "../migrate/core/code-jobs";
import { migrate as migrateScheduling } from "../migrate/core/code-scheduling";
import { migrate as migrateEvents } from "../migrate/core/events";
import { migrate as migrateSettings } from "../migrate/core/settings";
import { appendCodeCall, finishCodeCall } from "./store";
import { findCodeUsage, readCodeUsage } from "./usage";

const viewer = "11111111-1111-4111-8111-111111111111";
const owner = "22222222-2222-4222-8222-222222222222";
const base = { type: "pulse.base", id: "Base01" };
const fields = [
  { capability: "pulse.base.read", field: "id" },
  { capability: "pulse.sql.run", field: "baseId" },
];
const now = new Date("2026-11-21T12:00:00.000Z");
const since = new Date("2026-10-22T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

suiteFor("database")("Code usage of one resource (K1)", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  const runs = new Map<string, string>();
  /** One Code with one running run; `active: false` leaves it a draft. */
  const code = async (id: string, userId: string, active = true) => {
    await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title) VALUES(${id},'person',${userId}::uuid,${`Title ${id}`})`;
    const [version] = await sql<{ id: string }[]>`INSERT INTO code.versions
      (code_id,number,source_files,bundle,source_hash,bundle_hash,source_bytes,bundle_bytes,created_by)
      VALUES(${id},1,'{"code.ts":"fixture"}'::jsonb,'fixture',${"a".repeat(64)},${"b".repeat(64)},7,7,${userId}::uuid) RETURNING id`;
    if (active) await sql`UPDATE code.codes SET state='active',active_version_id=${version!.id}::uuid WHERE id=${id}`;
    const [run] = await sql<{ id: string }[]>`INSERT INTO code.runs(code_id,version_id,trigger,entrypoint,payload_bytes,calls_limit)
      VALUES(${id},${version!.id}::uuid,'manual','run',32768,40) RETURNING id`;
    await sql`UPDATE code.runs SET state='running',started_at=clock_timestamp() WHERE id=${run!.id}::uuid`;
    runs.set(id, run!.id);
  };
  const call = async (
    codeId: string,
    kind: "query" | "action",
    capability: string,
    target: { type: string; id: string } | null,
    input: unknown,
    state: "succeeded" | "failed" | "running",
    endedAt: Date,
    refs: Record<string, { type: string; id: string }> = {},
  ) => {
    const runId = runs.get(codeId)!;
    const ordinal = await sql.begin((tx) => appendCodeCall({ runId, kind, call: { capability, target, refs, input } }, tx));
    if (state !== "running")
      await sql.begin((tx) =>
        finishCodeCall({ runId, ordinal, state, result: state === "succeeded" ? { ok: true } : { ok: false }, endedAt }, tx),
      );
  };

  beforeAll(async () => {
    database = await useFreshDatabase("core_code_usage");
    for (const migrate of [migrateAuth, migrateEvents, migrateSettings, migrateCode, migrateScheduling, migrateJobs]) await migrate();
    await sql`INSERT INTO auth.users(id,uid,provider,profile,display_name) VALUES
      (${viewer}::uuid,'viewer','local','user','Viewer Person'),(${owner}::uuid,'owner','local','user','')`;
    for (const id of ["c_usetarget", "c_useref", "c_useinput", "c_usemiss"]) await code(id, id === "c_usetarget" ? viewer : owner);
    await code("c_usedraft", owner, false);

    // The target of a Query; the newest of two matching calls counts.
    await call("c_usetarget", "query", "pulse.base.sql.run", base, { sql: "SELECT 1" }, "succeeded", hoursAgo(5));
    await call("c_usetarget", "query", "pulse.base.sql.run", base, { sql: "SELECT 2" }, "succeeded", hoursAgo(1));
    // A ref of a Query.
    await call("c_useref", "query", "pulse.panel.read", { type: "pulse.panel", id: "P1" }, {}, "succeeded", hoursAgo(2), {
      base,
    });
    // An app-wide Query that names the base in a declared input field.
    await call("c_useinput", "query", "pulse.sql.run", null, { baseId: "Base01", sql: "SELECT 1" }, "succeeded", hoursAgo(3));
    // None of these read the base.
    await call("c_usemiss", "query", "pulse.base.sql.run", base, { sql: "x" }, "failed", hoursAgo(1));
    await call("c_usemiss", "action", "pulse.saved_query.save", base, { name: "n", sql: "x" }, "succeeded", hoursAgo(1));
    await call("c_usemiss", "query", "pulse.base.sql.run", base, { sql: "x" }, "running", hoursAgo(1));
    await call("c_usemiss", "query", "pulse.base.sql.run", { type: "pulse.base", id: "Base02" }, { sql: "x" }, "succeeded", hoursAgo(1));
    await call("c_usemiss", "query", "pulse.base.list", null, { query: "Base01" }, "succeeded", hoursAgo(1));
    // A field that names the base only counts on an app-wide Query, never beside another target.
    await call("c_usemiss", "query", "pulse.sql.run", { type: "pulse.source", id: "S1" }, { baseId: "Base01" }, "succeeded", hoursAgo(1));
    await call("c_usemiss", "query", "pulse.sql.run", null, { baseId: 7 }, "succeeded", hoursAgo(1));
    await call("c_usemiss", "query", "pulse.base.sql.run", base, { sql: "old" }, "succeeded", new Date(since.getTime() - 60_000));
    await call("c_usedraft", "query", "pulse.base.sql.run", base, { sql: "x" }, "succeeded", hoursAgo(1));
  });
  afterAll(async () => {
    await database?.drop();
  });

  test("target, ref and named input field match in one statement; failed, running, action, other, old and draft calls do not", async () => {
    const meter = await meterSql();
    try {
      let rows: Awaited<ReturnType<typeof findCodeUsage>> = [];
      const statements = await meter.during(async () => {
        rows = await findCodeUsage({ ref: base, fields, since });
      });
      expect(statements).toHaveLength(1);
      expect(rows.map((row) => [row.id, row.last_called_at.toISOString()])).toEqual([
        ["c_usetarget", hoursAgo(1).toISOString()],
        ["c_useref", hoursAgo(2).toISOString()],
        ["c_useinput", hoursAgo(3).toISOString()],
      ]);
      // The person's name comes with the row; an empty display name falls back to the account name.
      expect(rows.map((row) => row.owner_name)).toEqual(["Viewer Person", "owner", "owner"]);
      // Without the declared field the app-wide Query names no resource.
      const narrow = await findCodeUsage({ ref: base, fields: [], since });
      expect(narrow.map((row) => row.id)).toEqual(["c_usetarget", "c_useref"]);
      expect(await findCodeUsage({ ref: base, fields, since: hoursAgo(1.5) })).toHaveLength(1);
    } finally {
      await meter.close();
    }
  });

  test("the whole answer costs the one matching statement when the person owns the only openable Code", async () => {
    const facts = spyOn(capabilities, "getCapabilityCodeReadFacts").mockResolvedValue({
      inputRefs: { "pulse.base.read": { id: "pulse.base" }, "pulse.sql.run": { baseId: "pulse.base" } },
      typeReaders: { "pulse.base": "base.read" },
      publicRoutes: false,
    });
    const invoke = spyOn(capabilities, "invokeCapabilityWithDataSchema").mockResolvedValue({
      ok: true,
      data: { data: { view: { title: "Base", permission: "read" } } },
    } as never);
    const authority = {
      actor: { kind: "user", user: { id: viewer, uid: "viewer", displayName: "Viewer Person", roles: ["user"], profile: "user" } },
      accessSubject: { type: "user", userId: viewer },
      credentialKind: "session",
      scopes: [],
    } as unknown as RequestAuthority;
    const meter = await meterSql();
    try {
      let answer: Awaited<ReturnType<typeof readCodeUsage>> | undefined;
      const statements = await meter.during(async () => {
        answer = await readCodeUsage(
          { ref: base, now },
          { authority, locale: "en" },
          // Only the person's own Code: its permission needs no statement.
          { find: async (input) => (await findCodeUsage(input)).filter((row) => row.id === "c_usetarget") },
        );
      });
      expect(statements).toHaveLength(1);
      expect(answer).toEqual({
        items: [
          {
            codeId: "c_usetarget",
            title: "Title c_usetarget",
            kind: "automation",
            owner: "Viewer Person",
            lastCalledAt: hoursAgo(1).toISOString(),
            href: "/app/assistant/code/c_usetarget",
          },
        ],
        others: 0,
        since: since.toISOString(),
      });
    } finally {
      await meter.close();
      facts.mockRestore();
      invoke.mockRestore();
    }
  });

  test("Codes the person may not open are counted without names", async () => {
    const facts = spyOn(capabilities, "getCapabilityCodeReadFacts").mockResolvedValue({
      inputRefs: { "pulse.sql.run": { baseId: "pulse.base" } },
      typeReaders: { "pulse.base": "base.read" },
      publicRoutes: false,
    });
    const invoke = spyOn(capabilities, "invokeCapabilityWithDataSchema").mockResolvedValue({
      ok: true,
      data: { data: { view: { title: "Base", permission: "read" } } },
    } as never);
    const authority = {
      actor: { kind: "user", user: { id: viewer, uid: "viewer", displayName: "Viewer Person", roles: ["user"], profile: "user" } },
      accessSubject: { type: "user", userId: viewer },
      credentialKind: "session",
      scopes: [],
    } as unknown as RequestAuthority;
    try {
      const answer = await readCodeUsage({ ref: base, now }, { authority, locale: "en" });
      expect(answer.items.map((item) => item.codeId)).toEqual(["c_usetarget"]);
      expect(answer.others).toBe(2);
      expect(JSON.stringify(answer)).not.toContain("c_useref");
    } finally {
      facts.mockRestore();
      invoke.mockRestore();
    }
  });
});
