import { afterEach, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { resolveDisplayNames } from "@k2b/cloud/server";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { testActor, testCall } from "../../test/files-call";
import { assertPrivateDatabase } from "../../test/private-database";
import { ACTIVITY_EXPORT_BATCH, type ActivityExportInput } from "../activity-export-contracts";
import { migrateActivity } from "../data/activity-migration";
import { type ActivityExportDeps, createActivityExportService, openActivityExportSnapshot } from "./activity-export";

// Discovered under src by the existing test:integration script, which supplies the private DB preload.
// Run only with that preload; no Filegate, NATS, Valkey, or development DB is used.
const suite = suiteFor("database");
const now = new Date("2030-05-15T12:00:00.000Z");
const input: ActivityExportInput = { format: "jsonl", from: "2030-01-01", to: "2030-12-31" };
const userId = "10000000-0000-4000-8000-000000000001";
const baseId = "20000000-0000-4000-8000-000000000001";
const otherBaseId = "20000000-0000-4000-8000-000000000002";
const call = { ...testCall(testActor), requestId: "original-export-request" };

suite("admin history export in a private PostgreSQL snapshot", () => {
  let allowed = true;
  let authorizations = 0;
  const deps = (): ActivityExportDeps => ({
    async requireAdmin() {
      authorizations++;
      if (!allowed) throw new Error("forbidden");
    },
    displayNames: resolveDisplayNames,
  });
  const service = (overrides: Partial<ActivityExportDeps> = {}) => createActivityExportService({ ...deps(), ...overrides });
  const requests = new Set<AbortController>();
  type ExportResult = Awaited<ReturnType<ReturnType<typeof service>["export"]>>;
  async function withExport(
    exporter: ReturnType<typeof service>,
    selected: ActivityExportInput,
    signal: AbortSignal,
    check: (result: ExportResult, reader: ReadableStreamDefaultReader<Uint8Array>) => Promise<void> = async () => undefined,
  ) {
    const request = new AbortController();
    requests.add(request);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const result = await exporter.export(call, selected, AbortSignal.any([signal, request.signal]));
      reader = result.stream.getReader();
      await check(result, reader);
      // Check natural completion/cancellation before the safety net, so it cannot hide service leaks.
      await noSnapshots();
    } finally {
      try {
        // An errored stream rejects cancel with its existing error; afterEach still checks SQL cleanup.
        await reader?.cancel().catch(() => undefined);
      } finally {
        reader?.releaseLock();
        request.abort();
        requests.delete(request);
      }
    }
  }
  async function readText(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      text += decoder.decode(chunk.value, { stream: true });
    }
  }
  async function seed(count = 1, options: { time?: Date; action?: string } = {}) {
    await sql`INSERT INTO filesv2.activity(id,state,action,server_url,root,base_id,base_after_id,directory,name,path_before,path_after,
      actor_kind,actor_user_id,via,started_at,finished_at,detail,error_code)
      SELECT ('10000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'done',${options.action ?? "item.move"},'http://private-credential-server','cloud',
        ${baseId}::uuid,${otherBaseId}::uuid,false,'file-'||i::text,'users/alice/file-'||i::text,'users/bob/file-'||i::text,
        'user',${userId}::uuid,'web',${options.time ?? now},${options.time ?? now},'{"password":"never-export","error":"opaque"}'::jsonb,'opaque_error'
      FROM generate_series(1,${count}) AS i`;
  }
  async function auditRows() {
    return sql<{ actor_user_id: string; request_id: string; metadata: Record<string, unknown> }[]>`
      SELECT actor_user_id,request_id,metadata FROM audit.events WHERE action='filesv2.activity.export'`;
  }
  async function noSnapshots() {
    // close() is awaited on explicit cancellation/completion; request abort cleanup may still be committing.
    let remaining: { pid: number; state: string; wait: string | null }[] = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      remaining = await sql<typeof remaining>`SELECT pid,state,wait_event_type AS wait FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid() AND xact_start IS NOT NULL
          AND backend_type='client backend'`;
      if (remaining.length === 0) return;
      await Bun.sleep(10);
    }
    throw new Error(`Export leaked a transaction: ${JSON.stringify(remaining)}`);
  }
  beforeAll(async () => {
    await assertPrivateDatabase();
    await sql`CREATE SCHEMA auth`.simple();
    await sql`CREATE TABLE auth.users(id uuid PRIMARY KEY,uid text,display_name text,avatar_hash text)`.simple();
    await sql`CREATE SCHEMA filesv2`.simple();
    await sql`CREATE TABLE filesv2.bases(id uuid PRIMARY KEY,area text,kind text,identity_id uuid,root text,path text)`.simple();
    await sql`CREATE SCHEMA audit`.simple();
    await sql`CREATE TABLE audit.events(id bigint GENERATED ALWAYS AS IDENTITY,created_at timestamptz DEFAULT now(),
      action text,outcome text,actor_user_id uuid,actor_uid text,actor_provider text,actor_roles text[],
      target_type text,target_id text,target_label text,target_provider text,reason text,error_code text,error_message text,
      request_id text,metadata jsonb)`.simple();
    await migrateActivity();
  });
  beforeEach(async () => {
    setSystemTime(now);
    allowed = true;
    authorizations = 0;
    await sql`TRUNCATE filesv2.activity,filesv2.bases,audit.events,auth.users CASCADE`;
    await sql`INSERT INTO auth.users(id,uid,display_name) VALUES(${userId}::uuid,'alice','Alice current')`;
    await sql`INSERT INTO filesv2.bases(id,area,kind,identity_id,root,path) VALUES
      (${baseId}::uuid,'cloud','users',${userId}::uuid,'cloud','users/alice'),
      (${otherBaseId}::uuid,'cloud','users',${otherBaseId}::uuid,'cloud','users/bob')`;
  });
  afterEach(async () => {
    try {
      // Report a real leak before aborting any unfinished test, including one whose body timed out.
      await noSnapshots();
    } finally {
      for (const request of requests) request.abort();
      try {
        await noSnapshots();
      } finally {
        setSystemTime();
      }
    }
  });

  test("count and streamed rows retain one set while another connection inserts, updates and deletes", async () => {
    await seed(501);
    // The batch cursor must retain sub-millisecond precision even though exported times are ISO milliseconds.
    await sql`UPDATE filesv2.activity SET finished_at=finished_at+interval '1 microsecond'`;
    const exporter = service({
      snapshot: async (filter, signal) => {
        const snapshot = await openActivityExportSnapshot(filter, signal);
        const count = snapshot.count.bind(snapshot);
        return {
          ...snapshot,
          async count() {
            const total = await count();
            await sql`DELETE FROM filesv2.activity WHERE id='10000000-0000-4000-8000-000000000001'::uuid`;
            await sql`UPDATE filesv2.activity SET path_after='changed-after-count' WHERE id='10000000-0000-4000-8000-000000000002'::uuid`;
            await sql`INSERT INTO filesv2.activity(id,state,action,server_url,root,directory,name,actor_kind,via,started_at)
          VALUES('90000000-0000-4000-8000-000000000001'::uuid,'done','folder.create','private','cloud',true,'later','system','system',${now})`;
            return total;
          },
        };
      },
    });
    await withExport(exporter, input, new AbortController().signal, async (result, reader) => {
      expect(result.count).toBe(501);
      const rows = (await readText(reader))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(rows.map((row) => row.id)).toEqual(
        Array.from({ length: 501 }, (_, index) => `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`),
      );
      expect(rows[0].pathAfter).toBe("users/bob/file-1");
      expect(rows[1].pathAfter).toBe("users/bob/file-2");
      expect(rows.every((row) => row.action === "item.move")).toBe(true);
      expect(authorizations).toBeGreaterThanOrEqual(4);
    });
  });
  test("committed start evidence has original actor/request and survives midstream cancellation", async () => {
    await seed(501);
    await withExport(service(), input, new AbortController().signal, async (_result, reader) => {
      // Bun SQL returns an array subclass. Assert cardinality and the actual row, not a nested partial array match.
      const evidence = await auditRows();
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toEqual({
        actor_user_id: userId,
        request_id: call.requestId,
        metadata: {
          phase: "authorized_export_start",
          format: input.format,
          from: input.from,
          to: input.to,
          baseId: null,
          actor: null,
          action: null,
          q: null,
          count: 501,
          invocationId: call.invocationId,
          callingApp: call.callingApp,
          actorKind: call.actor.kind,
          serviceAccountId: null,
        },
      });
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      expect(new TextDecoder().decode(chunk.value).trim().split("\n")).toHaveLength(ACTIVITY_EXPORT_BATCH);
      await reader.cancel();
      expect(Array.from(await auditRows())).toEqual(Array.from(evidence));
    });
  });
  test.each(["before reading", "after the first batch"])("a failing check %s still releases the snapshot", async (phase) => {
    await seed(501);
    const failure = new Error("failed export assertion");
    await expect(
      withExport(service(), input, new AbortController().signal, async (_result, reader) => {
        if (phase === "after the first batch") await reader.read();
        throw failure;
      }),
    ).rejects.toBe(failure);
    await noSnapshots();
    expect(await auditRows()).toHaveLength(1);
    // This was the first blocked statement in the cascading run: it must not await the stream's idle timer.
    await sql`TRUNCATE filesv2.activity`;
  });
  test.each(["reader", "request"])("early %s cancellation returns snapshot connection and retains evidence", async (kind) => {
    await seed();
    const request = new AbortController();
    await withExport(service(), input, request.signal, async (_result, reader) => {
      if (kind === "reader") await reader.cancel();
      else {
        request.abort();
        await expect(reader.read()).rejects.toHaveProperty("code", "activity_export_failed");
      }
      await noSnapshots();
      expect(await auditRows()).toHaveLength(1);
    });
  });
  test("100001 rows rejects before any response/audit and returns snapshot connection", async () => {
    await seed(100001);
    await expect(withExport(service(), input, new AbortController().signal)).rejects.toMatchObject({
      code: "activity_export_limit",
      status: 413,
    });
    expect(await auditRows()).toHaveLength(0);
  });
  test("exactly 100000 rows pass the SQL count and stream in bounded batches", async () => {
    await seed(100000);
    await withExport(service(), input, new AbortController().signal, async (result, reader) => {
      expect(result.count).toBe(100000);
      let total = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const count = new TextDecoder().decode(chunk.value).trim().split("\n").length;
        expect(count).toBeLessThanOrEqual(ACTIVITY_EXPORT_BATCH);
        total += count;
      }
      expect(total).toBe(100000);
    });
  });
  test("request abort cancels a blocked SQL count and releases the transaction before any audit", async () => {
    await seed();
    const blocker = await sql.reserve();
    const request = new AbortController();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker`BEGIN`;
      await blocker`LOCK filesv2.activity IN ACCESS EXCLUSIVE MODE`;
      pending = withExport(service(), input, request.signal);
      void pending.catch(() => undefined);
      // Observe the count waiting on our table lock before cancelling it.
      let blocked = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const [state] = await sql<{ blocked: boolean }[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%bounded%') AS blocked`;
        if (state?.blocked) {
          blocked = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(blocked).toBe(true);
      request.abort();
      await expect(pending).rejects.toHaveProperty("name", "AbortError");
    } finally {
      request.abort();
      await pending?.catch(() => undefined);
      try {
        await blocker`ROLLBACK`;
      } finally {
        blocker.release();
      }
    }
    expect(await auditRows()).toHaveLength(0);
  });
  test("real audit insert rollback denies preparation and leaks no bytes or transaction", async () => {
    await seed();
    await sql`ALTER TABLE audit.events ADD CONSTRAINT deny_export CHECK(action<>'filesv2.activity.export')`;
    try {
      await expect(withExport(service(), input, new AbortController().signal)).rejects.toHaveProperty("errno", "23514");
      expect(await auditRows()).toHaveLength(0);
    } finally {
      await sql`ALTER TABLE audit.events DROP CONSTRAINT deny_export`;
    }
  });
  test("abort while the real audit insert waits cancels its query and rolls back before any response", async () => {
    await seed();
    const blocker = await sql.reserve();
    const request = new AbortController();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker`BEGIN`;
      await blocker`LOCK audit.events IN ACCESS EXCLUSIVE MODE`;
      pending = withExport(service(), input, request.signal);
      void pending.catch(() => undefined);
      let blocked = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const [state] = await sql<{ blocked: boolean }[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%INSERT INTO audit.events%') AS blocked`;
        if (state?.blocked) {
          blocked = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(blocked).toBe(true);
      request.abort();
      await expect(pending).rejects.toHaveProperty("name", "AbortError");
    } finally {
      request.abort();
      await pending?.catch(() => undefined);
      try {
        await blocker`ROLLBACK`;
      } finally {
        blocker.release();
      }
    }
    await noSnapshots();
    expect(await auditRows()).toHaveLength(0);
  });
  test("date endpoints use inclusive UTC effective time, action/actor/base filters match either public base", async () => {
    await seed(1, { time: new Date("2030-05-15T23:59:59.999Z") });
    await sql`UPDATE filesv2.activity SET started_at='2029-01-01'`;
    // Separate ID avoids replacing the first row.
    await sql`INSERT INTO filesv2.activity(id,state,action,server_url,root,directory,name,actor_kind,via,started_at)
      VALUES('90000000-0000-4000-8000-000000000002'::uuid,'done','folder.create','private','cloud',true,'outside','system','system','2030-05-16')`;
    for (const identity of [userId, otherBaseId]) {
      await withExport(
        service(),
        { ...input, from: "2030-05-15", to: "2030-05-15", baseId: `cloud:users:${identity}`, actor: userId, action: "item.move" },
        new AbortController().signal,
        async (result, reader) => {
          expect(result.count).toBe(1);
          const text = await readText(reader);
          expect(JSON.parse(text).actorName).toBe("Alice current");
          expect(text).not.toContain("password");
          expect(text).not.toContain("opaque");
          expect(text).not.toContain("private-credential-server");
        },
      );
    }
  });
  test("deleted actor is null, live renamed actor is resolved at export, unknown actions are excluded", async () => {
    await seed();
    await sql`UPDATE auth.users SET display_name='Alice renamed'`;
    await withExport(service(), input, new AbortController().signal, async (_result, reader) => {
      expect(JSON.parse(await readText(reader)).actorName).toBe("Alice renamed");
    });
    await sql`DELETE FROM auth.users`;
    await sql`UPDATE filesv2.activity SET action='future.unsafe.action'`;
    await withExport(service(), input, new AbortController().signal, async (result, reader) => {
      expect(result.count).toBe(0);
      expect(await readText(reader)).toBe("");
    });
    await sql`UPDATE filesv2.activity SET action='item.move'`;
    await withExport(service(), input, new AbortController().signal, async (_result, reader) => {
      expect(JSON.parse(await readText(reader))).toMatchObject({ actorUserId: null, actorName: null });
    });
  });
  test("unknown metadata follows the reader's minimal projection without inventing directory or identity facts", async () => {
    await seed();
    await sql`UPDATE filesv2.activity SET detail='{"metadata_unknown":true}'::jsonb,item_id='unconfirmed',item_after_id='unconfirmed'`;
    await withExport(service(), input, new AbortController().signal, async (_result, reader) => {
      expect(JSON.parse(await readText(reader))).toMatchObject({
        directory: null,
        rootBefore: null,
        rootAfter: null,
        baseBeforeId: null,
        baseAfterId: null,
        itemBeforeId: null,
        itemAfterId: null,
        pathBefore: "users/alice/file-1",
        pathAfter: "users/bob/file-1",
      });
    });
  });
  test("preview and download apply the same literal case-insensitive path query without auditing the preview", async () => {
    await seed(3);
    await sql`UPDATE filesv2.activity SET path_before='users/alice/100%_Offer.txt'
      WHERE id='10000000-0000-4000-8000-000000000002'`;
    const selected = { ...input, q: "100%_offer" };
    expect(await service().preview(call, selected, new AbortController().signal)).toEqual({ count: 1 });
    expect(await auditRows()).toHaveLength(0);
    await withExport(service(), selected, new AbortController().signal, async (result, reader) => {
      expect(result.count).toBe(1);
      expect(JSON.parse(await readText(reader)).pathBefore).toBe("users/alice/100%_Offer.txt");
    });
    expect((await auditRows())[0]?.metadata.q).toBe("100%_offer");
  });
  test("base-filtered preview and export retain recorded archive paths after the base moves", async () => {
    await seed();
    await sql`UPDATE filesv2.activity SET action='admin.read',path_before='archive/alice-op-123/file-1',path_after=NULL,base_after_id=NULL`;
    const selected = { ...input, baseId: `cloud:users:${userId}` };
    expect(await service().preview(call, selected, new AbortController().signal)).toEqual({ count: 1 });
    await withExport(service(), selected, new AbortController().signal, async (result, reader) => {
      expect(result.count).toBe(1);
      expect(JSON.parse(await readText(reader)).pathBefore).toBe("archive/alice-op-123/file-1");
    });
  });
});
