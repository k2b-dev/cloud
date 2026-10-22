import { beforeAll, beforeEach, expect, test } from "bun:test";
import { resolveDisplayNames } from "@k2b/cloud/server";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import {
  actorId,
  baseId,
  candidate,
  historyBinding,
  historyFixture,
  home,
  otherId,
  publicBaseId,
} from "../../test/activity-reader-fixture";
import { testActor, testCall } from "../../test/files-call";
import { assertPrivateDatabase } from "../../test/private-database";
import { type ActivityCandidate, activityReaderData } from "../data/activity-reader";
import { bindings } from "../data/bases";
import { shares } from "../data/shares";
import { migrate } from "../migrate";
import { withActivityReadBudget } from "./activity-read-budget";
import { createActivityReader } from "./activity-reader";

const suite = suiteFor("database");
const call = testCall(testActor);
const shareId = "50000000-0000-4000-8000-000000000001";
const now = new Date("2030-05-15T12:00:00Z");
const emptyNetworks = { known: 0, incomplete: false, overflow: false, items: [], next: null, rolledUp: false };

suite("history reader SQL and permission projection in a private database", () => {
  beforeAll(async () => {
    await assertPrivateDatabase();
    await sql`CREATE SCHEMA auth`.simple();
    await sql`CREATE TABLE auth.users(id uuid PRIMARY KEY,uid text,display_name text,avatar_hash text)`.simple();
    await sql`CREATE TABLE auth.groups(id uuid PRIMARY KEY,name text)`.simple();
    await sql`CREATE TABLE auth.access(id uuid PRIMARY KEY)`.simple();
    await migrate();
    // PR5 is a merge prerequisite. Until it lands, these private test-only tables exercise its read contract.
    await sql`CREATE TABLE IF NOT EXISTS filesv2.share_access (
      share_id uuid,hour timestamptz,network text,client text,pages bigint,downloads bigint,password_failed bigint,
      PRIMARY KEY(share_id,hour,network,client))`.simple();
    await sql`CREATE TABLE IF NOT EXISTS filesv2.share_access_daily (
      share_id uuid,day date,pages bigint,downloads bigint,password_failed bigint,PRIMARY KEY(share_id,day))`.simple();
  });
  beforeEach(async () => {
    await sql`TRUNCATE auth.users,auth.groups,filesv2.bases,filesv2.shares,filesv2.share_access,filesv2.share_access_daily CASCADE`.simple();
    await sql`INSERT INTO auth.users(id,uid,display_name) VALUES(${actorId}::uuid,'alice','Alice'),(${otherId}::uuid,'bob','Live Bob')`;
    await sql`INSERT INTO filesv2.bases ${sql(historyBinding)}`;
  });
  async function seed(row = candidate()) {
    const { share_expires_at: _expiry, effective_time: _time, observed_before, observed_after, metadataUnknown, ...stored } = row;
    await sql`INSERT INTO filesv2.activity ${sql({
      ...stored,
      name: "Old stored name must not escape",
      detail: JSON.stringify({
        observed_before,
        observed_after,
        metadata_unknown: metadataUnknown,
        token: "raw-private-token",
        actor_name: "Old Bob",
        hidden_path: "hidden/place",
      }),
    })}`;
  }
  function fixture(at = now) {
    const f = historyFixture();
    const reader = createActivityReader({
      ...f.deps,
      data: activityReaderData,
      bindings,
      shares,
      displayNames: resolveDisplayNames,
      now: () => at,
    });
    return { ...f, reader };
  }

  test("reads actual rows, resolves live names, strips private detail, and preserves FK name deletion", async () => {
    await seed();
    const f = fixture();
    const page = await f.reader.activity(call);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.actor).toMatchObject({ userId: otherId, name: "Live Bob" });
    expect(page.items[0]?.before).toEqual({
      visibility: "disappearance",
      name: "old",
      path: `${home}/old`,
      directory: true,
      publicBaseId,
      relativePath: "old",
    });
    expect(JSON.stringify(page)).not.toMatch(/Old Bob|raw-private|hidden\/place|Old stored/);
    await sql`UPDATE auth.users SET display_name='Renamed Bob' WHERE id=${otherId}::uuid`;
    expect((await f.reader.activity(call)).items[0]?.actor.name).toBe("Renamed Bob");
    await sql`DELETE FROM auth.users WHERE id=${otherId}::uuid`;
    expect((await f.reader.activity(call)).items[0]?.actor).toEqual({ kind: "user", userId: null, name: null });
  });

  test("guessed hidden names, old paths, IDs and batch totals remain absent after real ACL checks", async () => {
    await seed(candidate(1, { path_before: null }));
    await seed(candidate(2, { path_before: null, path_after: `${home}/secret` }));
    const f = fixture();
    f.nodes.set(`${home}/secret`, f.node(`${home}/secret`, "stable-a"));
    f.denied.add("secret");
    const page = await f.reader.activity(call);
    expect(page.items).toHaveLength(1);
    expect(page.visibleCount).toBe(1);
    expect(page.batches[0]?.visibleCount).toBe(1);
    for (const query of [{ q: "secret" }, { baseId: publicBaseId, path: "secret" }])
      expect((await f.reader.activity(call, query)).items).toEqual([]);
    f.setMember(false);
    expect((await f.reader.activity(call)).items).toEqual([]);
  });

  test("batch SQL counts visible peers beyond search matches, rechecks mixed-side ACLs, and retains only own snapshots", async () => {
    const anchor = candidate(1, { path_before: null });
    await seed(anchor);
    await seed(candidate(2, { path_before: null, path_after: `${home}/secret` }));
    await seed(candidate(3, { path_before: `${home}/secret`, path_after: `${home}/peer` }));
    await seed(candidate(4, { actor_user_id: actorId, base_id: null, path_after: "private/own-snapshot" }));
    await seed(candidate(5, { batch_id: "30000000-0000-4000-8000-000000000002" }));
    await seed(candidate(6, { path_before: `${home}/peer`, path_after: `${home}/secret` }));
    const f = fixture();
    f.nodes.set(`${home}/secret`, f.node(`${home}/secret`, "stable-a"));
    f.nodes.set(`${home}/peer`, f.node(`${home}/peer`, "stable-a"));
    f.denied.add("secret");
    expect((await f.reader.activity(call, { q: "peer" })).items.map((row) => row.id)).toEqual([candidate(6).id, candidate(3).id]);
    expect(await f.reader.activityBatchContext(call, { activityId: anchor.id })).toEqual({ visibleCount: 4, complete: true });
    f.denied.add("peer");
    expect(await f.reader.activityBatchContext(call, { activityId: anchor.id })).toEqual({ visibleCount: 2, complete: true });
    f.setMember(false);
    expect(await f.reader.activityBatchContext(call, { activityId: candidate(4).id })).toEqual({ visibleCount: 1, complete: true });
    for (const id of [anchor.id, candidate(99).id])
      await expect(f.reader.activityBatchContext(call, { activityId: id })).rejects.toMatchObject({ code: "not_found", status: 404 });
    await sql`UPDATE filesv2.activity SET batch_id=NULL WHERE id=${candidate(4).id}::uuid`;
    await expect(f.reader.activityBatchContext(call, { activityId: candidate(4).id })).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
  });

  test("batch SQL caps anchor plus peers at 500 and reports only a lower bound, even when candidates are hidden", async () => {
    const anchor = candidate(1, { actor_user_id: actorId });
    await seed(anchor);
    await sql`INSERT INTO filesv2.activity(id,action,state,server_url,root,base_id,directory,name,path_after,item_after_id,actor_kind,actor_user_id,via,batch_id,started_at,finished_at)
      SELECT ('40000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,'item.move','done',${anchor.server_url},'cloud',${baseId}::uuid,true,'secret',${home + "/secret"},'stable-a','user',${otherId}::uuid,'web',
        ${anchor.batch_id}::uuid,'2030-05-15T12:00:00Z','2030-05-15T12:00:00Z' FROM generate_series(2,501) n`;
    const f = fixture();
    f.nodes.set(`${home}/secret`, f.node(`${home}/secret`, "stable-a"));
    f.denied.add("secret");
    expect(await f.reader.activityBatchContext(call, { activityId: anchor.id })).toEqual({ visibleCount: 1, complete: false });
    await sql`UPDATE filesv2.activity SET actor_user_id=${actorId}::uuid`;
    expect(await f.reader.activityBatchContext(call, { activityId: anchor.id })).toEqual({ visibleCount: 500, complete: false });
    await sql`DELETE FROM filesv2.activity WHERE id IN (${candidate(500).id}::uuid,${candidate(501).id}::uuid)`;
    expect(await f.reader.activityBatchContext(call, { activityId: anchor.id })).toEqual({ visibleCount: 499, complete: true });
  });

  test("batch candidates have an indexed batch/order access path without sorting the whole activity table", async () => {
    const anchor = candidate();
    await seed(anchor);
    const db = await sql.reserve();
    try {
      await db`BEGIN`;
      await db`SET LOCAL enable_seqscan=off`;
      const plan = await db`EXPLAIN (FORMAT JSON) SELECT id FROM filesv2.activity
        WHERE batch_id=${anchor.batch_id}::uuid AND id<>${anchor.id}::uuid
          AND (base_id=${baseId}::uuid OR base_after_id=${baseId}::uuid OR (actor_kind='user' AND actor_user_id=${actorId}::uuid))
        ORDER BY coalesce(finished_at,started_at) DESC,id DESC LIMIT 499`;
      expect(JSON.stringify(plan)).toContain("filesv2_activity_batch_effective");
      expect(JSON.stringify(plan)).not.toContain('"Node Type":"Sort"');
      expect(JSON.stringify(plan)).not.toContain('"Node Type":"Seq Scan"');
    } finally {
      await db`ROLLBACK`;
      db.release();
    }
  });

  test("SQL sorts effective finish/start time and losslessly pages through microsecond ties", async () => {
    const rows: ActivityCandidate[] = [
      candidate(1, { started_at: new Date("2030-05-01T00:00:00Z"), finished_at: new Date("2030-05-20T00:00:00Z") }),
      candidate(2, { state: "pending", started_at: new Date("2030-05-19T00:00:00Z"), finished_at: null }),
      candidate(3, { started_at: new Date("2030-05-18T00:00:00Z"), finished_at: new Date("2030-05-18T00:00:00Z") }),
    ];
    for (const row of rows) await seed(row);
    await sql`UPDATE filesv2.activity SET finished_at='2030-05-20T00:00:00.000002Z' WHERE id=${rows[0]!.id}::uuid`;
    await sql`UPDATE filesv2.activity SET started_at='2030-05-20T00:00:00.000001Z' WHERE id=${rows[1]!.id}::uuid`;
    const f = fixture();
    const first = await f.reader.activity(call, { limit: 1 });
    const second = await f.reader.activity(call, { limit: 1, cursor: first.next! });
    const third = await f.reader.activity(call, { limit: 1, cursor: second.next! });
    expect([first.items[0]?.id, second.items[0]?.id, third.items[0]?.id]).toEqual(rows.map((row) => row.id));
    expect(third.exhausted).toBe(true);
    const bounded = await f.reader.activity(call, {
      from: "2030-05-19T00:00:00Z",
      to: "2030-05-21T00:00:00Z",
      actor: otherId,
      action: "item.move",
    });
    expect(bounded.items.map((row) => row.id)).toEqual(rows.slice(0, 2).map((row) => row.id));
  });

  test("exact-time projection keeps inclusive SQL microseconds and paginates within the rounded hour", async () => {
    for (let index = 1; index <= 4; index++) await seed(candidate(index));
    await sql`UPDATE filesv2.activity SET finished_at='2030-05-15T12:00:00Z'::timestamptz
      + ((right(id::text,12)::int - 1) * interval '1 microsecond')`;
    const f = fixture();
    const input = {
      from: "2030-05-15T14:00:00.000001+02:00",
      to: "2030-05-15T14:00:00.000002+02:00",
      q: "new",
      limit: 1,
    };
    const first = await f.reader.activity(call, input);
    expect(first.items.map((row) => row.id)).toEqual([candidate(3).id]);
    expect(first.next).not.toBeNull();
    const second = await f.reader.activity(call, { ...input, cursor: first.next! });
    expect(second.items.map((row) => row.id)).toEqual([candidate(2).id]);
    const last = await f.reader.activity(call, { ...input, cursor: second.next! });
    expect(last.items).toEqual([]);
    expect(last.exhausted).toBe(true);
    expect(last.next).toBeNull();
  });

  test("rounded SQL windows retain bounded continuations past 500 visible rows outside exact time", async () => {
    const row = candidate();
    await sql`INSERT INTO filesv2.activity(id,action,state,server_url,root,base_id,directory,name,path_after,item_after_id,actor_kind,actor_user_id,via,started_at,finished_at)
      SELECT ('40000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,'item.move','done',${row.server_url},'cloud',${baseId}::uuid,true,'new',${home + "/new"},'stable-a','user',${actorId}::uuid,'web',
        '2030-05-15T12:00:00Z','2030-05-15T12:50:00Z' FROM generate_series(1,501) n`;
    await seed(candidate(502, { finished_at: new Date("2030-05-15T12:20:00Z"), actor_user_id: actorId }));
    const f = fixture();
    const input = { from: "2030-05-15T12:10:00Z", to: "2030-05-15T12:30:00Z", q: "new", limit: 1 };
    const first = await f.reader.activity(call, input);
    expect(first.items).toEqual([]);
    expect(first.scanLimitReached).toBe(true);
    expect(first.searchLimitReached).toBe(false);
    expect(first.next).not.toBeNull();
    const second = await f.reader.activity(call, { ...input, cursor: first.next! });
    expect(second.items.map((row) => row.id)).toEqual([candidate(502).id]);
    expect(second.visibleCount).toBe(1);
    expect(second.exhausted).toBe(true);
    expect(second.next).toBeNull();
  });

  test("SQL candidate limit is 500 even when all queried content is hidden", async () => {
    const row = candidate();
    await sql`INSERT INTO filesv2.activity(id,action,state,server_url,root,base_id,directory,name,path_after,item_after_id,actor_kind,actor_user_id,via,started_at,finished_at)
      SELECT ('40000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,'item.move','done',${row.server_url},'cloud',${baseId}::uuid,true,'secret',${home + "/secret"},'stable-a','user',${otherId}::uuid,'web',${row.started_at},${row.finished_at}
      FROM generate_series(1,501) n`;
    const f = fixture();
    f.nodes.set(`${home}/secret`, f.node(`${home}/secret`, "stable-a"));
    f.denied.add("secret");
    const page = await f.reader.activity(call, { q: "secret" });
    expect(page.items).toEqual([]);
    expect(page.scanLimitReached).toBe(true);
    expect(page.next).not.toBeNull();
    expect((await f.reader.activity(call, { q: "secret", cursor: page.next! })).exhausted).toBe(true);
  });

  test("500+ foreign rows cannot alter empty results, guessed-name counts or continuations", async () => {
    const f = fixture();
    const filters = [{}, { q: "hidden-name" }, { q: "not-present" }, { baseId: publicBaseId }];
    const before = await Promise.all(filters.map((input) => f.reader.activity(call, input)));
    await sql`INSERT INTO filesv2.activity(id,action,state,server_url,root,base_id,directory,name,path_before,path_after,actor_kind,actor_user_id,via,started_at,finished_at)
      SELECT ('40000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,'item.move','done','http://filegate.test','cloud',
        '20000000-0000-4000-8000-000000000009'::uuid,true,'hidden-name','foreign/hidden-name','foreign/hidden-name',
        'user',${otherId}::uuid,'web','2030-05-15T12:00:00Z','2030-05-15T12:00:00Z' FROM generate_series(1,700) n`;
    for (const [index, input] of filters.entries()) expect(await f.reader.activity(call, input)).toEqual(before[index]!);
    expect(f.requests).toEqual([]);
  });

  test("base filter includes original actor's historical binding but excludes unrelated owned actions", async () => {
    const old = { ...historyBinding, id: "20000000-0000-4000-8000-000000000009", lifecycle: "retired", path: "archive/alice" };
    // Use a distinct retired public base so the database's unique identity constraint remains intact.
    old.identity_id = otherId;
    old.identity_name = "bob";
    await sql`INSERT INTO filesv2.bases ${sql(old)}`;
    await seed(candidate(1, { actor_user_id: actorId, base_id: old.id, path_before: "users/bob/old", path_after: null }));
    await seed(candidate(2, { actor_user_id: actorId }));
    const f = fixture();
    f.setMember(false);
    const page = await f.reader.activity(call, { baseId: `cloud:users:${otherId}` });
    expect(page.items.map((row) => row.id)).toEqual([candidate(1).id]);
    expect(page.items[0]?.before).toMatchObject({ source: "snapshot", publicBaseId: null });
    expect(page.next).toBeNull();
    expect(f.requests).toEqual([]);
  });

  test("relevant chain SQL crosses a move after 500+ unrelated moves in the same base", async () => {
    await seed(candidate(1));
    await sql`INSERT INTO filesv2.activity(id,action,state,server_url,root,base_id,directory,name,path_before,path_after,actor_kind,actor_user_id,via,started_at,finished_at)
      SELECT ('40000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,'item.move','done','http://filegate.test','cloud',
        ${baseId}::uuid,true,'noise','users/alice/noise-' || n,'users/alice/other-' || n,
        'user',${otherId}::uuid,'web','2030-05-15T12:00:00Z','2030-05-15T12:00:00Z' FROM generate_series(2,601) n`;
    await seed(candidate(602, { path_before: `${home}/new`, path_after: `${home}/final` }));
    const f = fixture();
    f.nodes.delete(`${home}/new`);
    f.nodes.set(`${home}/final`, f.node(`${home}/final`, "stable-a"));
    const chain = await f.reader.movementChain(call, { activityId: candidate().id });
    expect(chain.hops.map((hop) => hop.activityId)).toEqual([candidate().id, candidate(602).id]);
    expect(chain.truncated).toBe(false);
    expect(chain.endpoint?.path).toBe("final");
  });

  test.each([
    "folder.create",
    "file.create",
    "file.upload",
    "file.overwrite",
    "item.copy",
    "item.move",
    "item.restore",
    "version.restore_copy",
  ])("chain SQL includes %s replacements through destination paths and ancestors", async (action) => {
    for (const ancestor of [false, true]) {
      await sql`TRUNCATE filesv2.activity`;
      const path = `${home}/new${ancestor ? "/child" : ""}`;
      const source = candidate(1, { path_after: path, directory: false, item_id: null, item_after_id: null });
      const inbound = ["item.copy", "item.move", "item.restore", "version.restore_copy"].includes(action);
      const replacement = candidate(2, {
        action,
        directory: ancestor || action === "folder.create",
        item_id: null,
        item_after_id: null,
        path_before: inbound ? "foreign/source" : action === "file.overwrite" ? `${home}/new` : null,
        path_after: `${home}/new`,
        root: inbound ? "foreign" : "cloud",
        root_after: inbound ? "cloud" : null,
        base_id: inbound ? null : baseId,
        base_after_id: inbound ? baseId : null,
      });
      await seed(source);
      await seed(replacement);
      const rows = await activityReaderData.candidates({
        scope: { admin: false, userId: actorId, bindingIds: [baseId] },
        chain: { serverUrl: source.server_url, root: "cloud", baseId, path },
        position: { time: source.effective_time, id: source.id },
        direction: "asc",
        limit: 1,
      });
      expect(rows.map((row) => row.id)).toEqual([replacement.id]);
      const f = fixture();
      f.setAdmin(true);
      f.setStableIds(false);
      f.nodes.set(path, f.node(path, undefined, false));
      const chain = await f.reader.movementChain(call, { activityId: source.id });
      expect(chain.truncated).toBe(true);
      expect(chain.endpoint).toBeNull();
    }
  });

  test.each(["item.trash", "item.purge"])("SQL chain stops before a recreated destination after %s", async (action) => {
    const source = candidate(1, { item_id: null, item_after_id: null });
    await seed(source);
    await seed(candidate(2, { action, path_before: `${home}/new`, path_after: null, item_id: null, item_after_id: null }));
    await seed(candidate(3, { action: "folder.create", path_before: null, path_after: `${home}/new`, item_id: null, item_after_id: null }));
    const f = fixture();
    f.setAdmin(true);
    f.setStableIds(false);
    const chain = await f.reader.movementChain(call, { activityId: source.id });
    expect(chain.truncated).toBe(true);
    expect(chain.endpoint).toBeNull();
  });

  test("SQL preserves same-identity writes and path-only copy sources before the next move", async () => {
    const source = candidate(1, { item_id: null, item_after_id: null });
    await seed(source);
    await seed(candidate(2, { action: "file.upload", path_before: `${home}/new`, path_after: `${home}/new` }));
    await seed(candidate(3, { action: "item.copy", path_before: `${home}/new`, path_after: `${home}/copy`, item_after_id: "copy-id" }));
    await seed(candidate(4, { path_before: `${home}/new`, path_after: `${home}/final`, item_id: null, item_after_id: null }));
    const f = fixture();
    f.setAdmin(true);
    f.setStableIds(false);
    f.nodes.set(`${home}/final`, f.node(`${home}/final`));
    const chain = await f.reader.movementChain(call, { activityId: source.id });
    expect(chain.hops.map((hop) => hop.activityId)).toEqual([source.id, candidate(4).id]);
    expect(chain.truncated).toBe(false);
    expect(chain.endpoint?.path).toBe("final");
  });

  test.each(["list", "batch"])("aborting a blocked real SQL %s query removes its waiter without returning partial data", async (mode) => {
    const blocker = await sql.reserve();
    const controller = new AbortController();
    let pending: Promise<void> | undefined;
    try {
      await blocker`BEGIN`;
      await blocker`LOCK TABLE filesv2.activity IN ACCESS EXCLUSIVE MODE`;
      const [backend] = await blocker<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      const waiting = async () => {
        const [row] = await sql<{ blocked: boolean }[]>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
            AND ${backend!.pid}::int=ANY(pg_blocking_pids(pid))
        ) AS blocked`;
        return row!.blocked;
      };
      pending = withActivityReadBudget(controller.signal, (budget) =>
        activityReaderData.candidates(
          {
            scope: { admin: false, userId: actorId, bindingIds: [baseId] },
            batch: mode === "batch" ? { id: candidate().batch_id!, anchorId: candidate().id } : undefined,
            position: null,
            direction: "desc",
            limit: 500,
          },
          budget,
        ),
      ).then(
        () => {
          throw new Error("Canceled query must not return rows");
        },
        (error: unknown) => {
          expect(error).toMatchObject({ message: "query canceled" });
        },
      );
      const until = Date.now() + 5000;
      while (!(await waiting())) {
        if (Date.now() >= until) throw new Error("Reader did not reach the database lock");
        await Bun.sleep(10);
      }
      controller.abort(new Error("query canceled"));
      await pending;
      while (await waiting()) {
        if (Date.now() >= until) throw new Error("Canceled reader left a database waiter behind");
        await Bun.sleep(10);
      }
      expect((await sql<{ healthy: number }[]>`SELECT 1 AS healthy`)[0]?.healthy).toBe(1);
    } finally {
      controller.abort(new Error("query canceled"));
      await blocker`ROLLBACK`;
      blocker.release();
      await pending;
    }
  });

  test("share counts require creator or canonical admin, independently of readable item history", async () => {
    await sql`INSERT INTO filesv2.shares(id,token_hash,kind,base_id,root,base_path,scope,items,title,created_by,created_by_name)
      VALUES(${shareId}::uuid,'test-token-hash','download',${baseId}::uuid,'cloud',${home},'','[]','Share',${otherId}::uuid,'Old name')`;
    await sql`INSERT INTO filesv2.share_access VALUES(${shareId}::uuid,'2030-05-15T12:00:00Z','unknown','unknown',4,2,1)`;
    await sql`INSERT INTO filesv2.share_access_daily VALUES(${shareId}::uuid,'2030-04-01',6,3,2)`;
    const f = fixture();
    const input = { shareId, from: "2030-04-01", to: "2030-05-15" };
    await expect(f.reader.shareAccess(call, input)).rejects.toMatchObject({ status: 404 });
    f.setAdmin(true);
    expect(await f.reader.shareAccess(call, input)).toMatchObject({
      pages: 10,
      downloads: 5,
      passwordFailed: 3,
      networks: { ...emptyNetworks, incomplete: true, rolledUp: true },
    });
    f.setAdmin(false);
    f.setMember(false);
    await sql`UPDATE filesv2.shares SET created_by=${actorId}::uuid WHERE id=${shareId}::uuid`;
    expect(await f.reader.shareAccess(call, input)).toMatchObject({
      pages: 10,
      downloads: 5,
      passwordFailed: 3,
      networks: { ...emptyNetworks, incomplete: true, rolledUp: true },
    });
    expect(await f.reader.shareAccess(call, { ...input, from: "2030-05-15" })).toMatchObject({
      pages: 4,
      downloads: 2,
      passwordFailed: 1,
      networks: { ...emptyNetworks, incomplete: true },
    });
  });

  test("both SQL readers join immutable share expiry without exposing share credentials or missing-row claims", async () => {
    await sql`INSERT INTO filesv2.shares(id,token_hash,password_hash,kind,base_id,root,base_path,scope,items,title,created_by,created_by_name,expires_at)
      VALUES(${shareId}::uuid,'secret-token-hash','secret-password-hash','download',${baseId}::uuid,'cloud',${home},'','[]','Private title',${actorId}::uuid,'Old actor name','2030-06-01T00:00:00Z')`;
    const row = candidate(1, { action: "share.create", actor_user_id: actorId });
    await seed(row);
    await sql`UPDATE filesv2.activity SET share_id=${shareId}::uuid WHERE id=${row.id}::uuid`;
    expect((await activityReaderData.byId(row.id))?.share_expires_at?.toISOString()).toBe("2030-06-01T00:00:00.000Z");
    const f = fixture();
    f.setMember(false);
    const page = await f.reader.activity(call);
    expect(page.items[0]?.share).toEqual({ expiresAt: "2030-06-01T00:00:00.000Z" });
    expect(JSON.stringify(page)).not.toMatch(/secret-|Private title|Old actor name|token_hash|share_id/);
    await sql`UPDATE filesv2.activity SET action='share.revoke' WHERE id=${row.id}::uuid`;
    expect((await f.reader.activityEntry(call, { activityId: row.id })).share).toEqual({ expiresAt: "2030-06-01T00:00:00.000Z" });
    await sql`DELETE FROM filesv2.shares WHERE id=${shareId}::uuid`;
    expect((await f.reader.activity(call)).items[0]?.share).toEqual({ expiresAt: null });
    await sql`UPDATE filesv2.activity SET action='item.move' WHERE id=${row.id}::uuid`;
    expect((await f.reader.activityEntry(call, { activityId: row.id })).share).toBeUndefined();
  });

  test("admin base pages include recorded archived identities and live names without storage inventory", async () => {
    await sql`UPDATE filesv2.bases SET lifecycle='archived',identity_name='Obsolete Alice' WHERE id=${baseId}::uuid`;
    await sql`INSERT INTO auth.groups VALUES('60000000-0000-4000-8000-000000000001','Current team')`;
    await sql`INSERT INTO filesv2.bases(area,kind,identity_id,identity_name,root,path,lifecycle)
      VALUES('cloud','groups','60000000-0000-4000-8000-000000000001','Old team','cloud','groups/old','archived'),
        ('freeipa','groups','60000000-0000-4000-8000-000000000002','Recorded team','freeipa','archive/team','archived')`;
    const f = fixture();
    f.setAdmin(true);
    expect(await f.reader.adminActivityBases(call, { q: "Alice" })).toMatchObject({
      items: [{ id: publicBaseId, name: "Alice", kind: "users" }],
      next: null,
    });
    const page = await f.reader.adminActivityBases(call);
    expect(page.items).toHaveLength(3);
    expect(new Set(page.items.map((item) => item.id)).size).toBe(3);
    expect(page.items.map((item) => item.name).sort()).toEqual(["Alice", "Current team", "Recorded team"]);
    expect(await f.reader.adminActivityBases(call, { q: "Obsolete" })).toEqual({ items: [], next: null });
    await sql`DELETE FROM auth.users WHERE id=${actorId}::uuid`;
    expect((await f.reader.adminActivityBases(call, { baseId: publicBaseId })).items[0]?.name).toBe("Deleted account");
    expect(f.requests).toEqual([]);
  });

  test("recorded base SQL pages every historical binding, including 55 bindings of one public ID", async () => {
    const recordedPublicId = "freeipa:users:70000000-0000-4000-8000-000000000001";
    await sql`INSERT INTO filesv2.bases(id,area,kind,identity_id,identity_name,root,path,lifecycle)
      SELECT ('80000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
        'freeipa','users','70000000-0000-4000-8000-000000000001'::uuid,'Recorded user','freeipa','archive/user-'||n,'archived'
      FROM generate_series(1,55) n`;
    await withActivityReadBudget(undefined, async (budget) => {
      const first = await activityReaderData.activityBases(undefined, 50, budget);
      expect(first.items).toHaveLength(50);
      const last = await activityReaderData.activityBases(first.next!, 50, budget);
      expect(last.items).toHaveLength(6);
      expect(last.next).toBeNull();
      const keys = [...first.items, ...last.items].map((item) => item.id);
      expect(keys).toEqual([...keys].sort());
      expect(new Set(keys).size).toBe(56);
      const filtered = await activityReaderData.activityBases(undefined, 50, budget, { baseId: recordedPublicId });
      const filteredLast = await activityReaderData.activityBases(filtered.next!, 50, budget, { baseId: recordedPublicId });
      expect(filtered.items).toHaveLength(50);
      expect(filteredLast.items).toHaveLength(5);
      expect(filteredLast.next).toBeNull();
      const exact = await activityReaderData.activityBases(undefined, 50, budget, { bindingIds: [keys[55]!] });
      expect(exact.items.map((item) => item.id)).toEqual([keys[55]!]);
      expect(exact.items[0]?.path).toBe("archive/user-55");
    });
    // The public filter used by history/export already matches every binding, including later pages.
    await seed(candidate(1, { base_id: "80000000-0000-4000-8000-000000000049" }));
    await seed(candidate(2, { base_id: "80000000-0000-4000-8000-000000000055" }));
    await withActivityReadBudget(undefined, async (budget) => {
      const rows = await activityReaderData.candidates(
        { scope: { admin: true, userId: actorId, bindingIds: [] }, baseId: recordedPublicId, position: null, direction: "desc", limit: 50 },
        budget,
      );
      expect(rows).toHaveLength(2);
    });
  });
  test("legacy metadata markers are derived narrowly by both SQL readers and never imply file or folder", async () => {
    const row = candidate(1, { action: "share.revoke", directory: false, path_after: null, actor_user_id: actorId });
    await seed(row);
    for (const marker of ["metadata_unknown", "snapshot_unknown", "directory_unknown"]) {
      await sql`UPDATE filesv2.activity SET detail=jsonb_build_object(${marker}::text,true) WHERE id=${row.id}::uuid`;
      expect((await activityReaderData.byId(row.id))?.metadataUnknown).toBe(true);
      const f = fixture();
      f.setMember(false);
      expect((await f.reader.activity(call)).items[0]?.before).toEqual({
        visibility: "disappearance",
        name: "old",
        path: `${home}/old`,
        directory: null,
        publicBaseId: null,
        relativePath: null,
      });
      f.setAdmin(true);
      expect((await f.reader.activity(call)).items[0]?.before.visibility).toBe("disappearance");
      await sql`UPDATE filesv2.activity SET detail=jsonb_build_object(${marker}::text,'true'::text) WHERE id=${row.id}::uuid`;
      expect((await activityReaderData.byId(row.id))?.metadataUnknown).toBe(false);
    }
  });

  test("share networks aggregate clients and hours, hide old buckets despite backlog, and never count daily identities", async () => {
    await sql`INSERT INTO filesv2.share_access VALUES
      (${shareId}::uuid,'2030-05-14T00:00:00Z','192.0.2.0/24','chrome',2,1,0),
      (${shareId}::uuid,'2030-05-14T00:00:00Z','192.0.2.0/24','firefox',3,2,1),
      (${shareId}::uuid,'2030-05-15T12:00:00Z','192.0.2.0/24','chrome',4,1,2),
      (${shareId}::uuid,'2030-04-15T12:00:00Z','2001:db8:abcd::/48','other',5,0,0),
      (${shareId}::uuid,'2030-05-15T00:00:00Z','*','other',6,1,0),
      (${shareId}::uuid,'2030-05-15T00:00:00Z','unknown','unknown',7,0,1),
      (${shareId}::uuid,'2030-04-15T11:00:00Z','198.51.100.0/24','chrome',8,2,0),
      (${shareId}::uuid,'2030-05-16T00:00:00Z','203.0.113.0/24','chrome',100,100,100),
      ('50000000-0000-4000-8000-000000000002'::uuid,'2030-05-15T00:00:00Z','203.0.113.0/24','chrome',100,100,100)`;
    await sql`INSERT INTO filesv2.share_access_daily VALUES(${shareId}::uuid,'2030-04-01',9,3,1)`;
    const input = { shareId, from: "2030-04-01", to: "2030-05-15", networkLimit: 1 };
    const first = await activityReaderData.shareAccess(input, { now });
    expect(first).toMatchObject({
      pages: 44,
      downloads: 10,
      passwordFailed: 5,
      networks: {
        known: 2,
        incomplete: true,
        overflow: true,
        rolledUp: true,
        next: "192.0.2.0/24",
        items: [
          {
            network: "192.0.2.0/24",
            pages: 9,
            downloads: 4,
            passwordFailed: 3,
            firstSeen: "2030-05-14T00:00:00.000Z",
            lastSeen: "2030-05-15T12:00:00.000Z",
          },
        ],
      },
    });
    expect(JSON.stringify(first)).not.toMatch(/198\.51|203\.0|chrome|firefox|unknown|client/);
    expect(first.timeline).toEqual({
      items: [
        {
          date: "2030-05-15T12:00:00.000Z",
          granularity: "hour",
          pages: 4,
          downloads: 1,
          passwordFailed: 2,
          knownNetworks: 1,
          overflow: false,
        },
        {
          date: "2030-05-15T00:00:00.000Z",
          granularity: "hour",
          pages: 13,
          downloads: 1,
          passwordFailed: 1,
          knownNetworks: null,
          overflow: true,
        },
        {
          date: "2030-05-14T00:00:00.000Z",
          granularity: "hour",
          pages: 5,
          downloads: 3,
          passwordFailed: 1,
          knownNetworks: 1,
          overflow: false,
        },
        {
          date: "2030-04-15T00:00:00.000Z",
          granularity: "day",
          pages: 13,
          downloads: 2,
          passwordFailed: 0,
          knownNetworks: null,
          overflow: false,
        },
        {
          date: "2030-04-01T00:00:00.000Z",
          granularity: "day",
          pages: 9,
          downloads: 3,
          passwordFailed: 1,
          knownNetworks: null,
          overflow: false,
        },
      ],
      next: null,
    });
    const second = await activityReaderData.shareAccess({ ...input, networkAfter: first.networks.next! }, { now });
    expect(second.networks).toEqual({
      known: 2,
      incomplete: true,
      overflow: true,
      rolledUp: true,
      next: null,
      items: [
        {
          network: "2001:db8:abcd::/48",
          pages: 5,
          downloads: 0,
          passwordFailed: 0,
          firstSeen: "2030-04-15T12:00:00.000Z",
          lastSeen: "2030-04-15T12:00:00.000Z",
        },
      ],
    });
    const expired = await activityReaderData.shareAccess(input, { now: new Date("2030-06-14T12:00:00.001Z") });
    expect(expired).toMatchObject({
      pages: 44,
      downloads: 10,
      passwordFailed: 5,
      networks: { ...emptyNetworks, incomplete: true, rolledUp: true },
    });
    const dailyOnly = await activityReaderData.shareAccess({ ...input, to: "2030-04-01" }, { now });
    expect(dailyOnly).toMatchObject({
      pages: 9,
      downloads: 3,
      passwordFailed: 1,
      networks: { ...emptyNetworks, incomplete: true, rolledUp: true },
    });
  });

  test("public access timeline is bounded, aggregates clients and networks, and preserves totals after actual rollup", async () => {
    await sql`INSERT INTO filesv2.share_access(share_id,hour,network,client,pages,downloads,password_failed)
      SELECT ${shareId}::uuid,${now}::timestamptz-n*interval '1 hour','192.0.2.0/24','chrome',1,2,0 FROM generate_series(0,70) n`;
    await sql`INSERT INTO filesv2.share_access VALUES
      (${shareId}::uuid,${now},'192.0.2.0/24','firefox',2,1,1),
      (${shareId}::uuid,${now},'198.51.100.0/24','chrome',3,0,0),
      (${shareId}::uuid,'2030-04-01T01:00:00Z','203.0.113.0/24','chrome',4,2,1)`;
    const input = { shareId, from: "2030-04-01", to: "2030-05-15" };
    const first = await activityReaderData.shareAccess(input, { now });
    expect(first).toMatchObject({ from: input.from, to: input.to, pages: 80, downloads: 145, passwordFailed: 2 });
    expect(first.timeline.items).toHaveLength(50);
    expect(first.timeline.next).toBe(first.timeline.items.at(-1)!.date);
    expect(first.timeline.items[0]).toEqual({
      date: now.toISOString(),
      granularity: "hour",
      pages: 6,
      downloads: 3,
      passwordFailed: 1,
      knownNetworks: 2,
      overflow: false,
    });
    const last = await activityReaderData.shareAccess({ ...input, timelineAfter: first.timeline.next! }, { now });
    expect(last.timeline.items).toHaveLength(22);
    expect(last.timeline.next).toBeNull();
    const periods = [...first.timeline.items, ...last.timeline.items];
    expect(new Set(periods.map((period) => period.date)).size).toBe(72);
    expect(periods.reduce((total, period) => total + period.pages, 0)).toBe(first.pages);
    expect(periods.at(-1)).toEqual({
      date: "2030-04-01T00:00:00.000Z",
      granularity: "day",
      pages: 4,
      downloads: 2,
      passwordFailed: 1,
      knownNetworks: null,
      overflow: false,
    });
    // Reproduce retention's atomic move to daily totals, including the cursor network expiring.
    await sql.begin(async (tx) => {
      await tx`INSERT INTO filesv2.share_access_daily(share_id,day,pages,downloads,password_failed)
        SELECT share_id,(hour AT TIME ZONE 'UTC')::date,sum(pages),sum(downloads),sum(password_failed)
        FROM filesv2.share_access GROUP BY share_id,(hour AT TIME ZONE 'UTC')::date`;
      await tx`DELETE FROM filesv2.share_access`;
    });
    const rolled = await activityReaderData.shareAccess(input, { now });
    expect(rolled).toMatchObject({
      pages: first.pages,
      downloads: first.downloads,
      passwordFailed: first.passwordFailed,
      networks: { known: 0, items: [], next: null, rolledUp: true },
    });
    expect(rolled.timeline.items.every((period) => period.granularity === "day" && period.knownNetworks === null)).toBe(true);
    expect(rolled.timeline.items.reduce((total, period) => total + period.pages, 0)).toBe(first.pages);
    await expect(activityReaderData.shareAccess({ ...input, networkAfter: "192.0.2.0/24" }, { now })).rejects.toMatchObject({
      code: "share_access_cursor_expired",
      status: 409,
    });
    expect(JSON.stringify(rolled)).not.toMatch(/192\.0|198\.51|203\.0|chrome|firefox|client/);
  });

  test("page summary counts networks with page views, excluding download-only and password-only networks", async () => {
    await sql`INSERT INTO filesv2.share_access VALUES
      (${shareId}::uuid,${now},'192.0.2.0/24','chrome',96,1,0),
      (${shareId}::uuid,${now},'198.51.100.0/24','chrome',0,20,0),
      (${shareId}::uuid,${now},'203.0.113.0/24','chrome',0,0,9),
      (${shareId}::uuid,${now},'unknown','unknown',0,0,1)`;
    const input = { shareId, from: "2030-05-15", to: "2030-05-15" };
    expect(await activityReaderData.shareAccess(input, { now })).toMatchObject({
      pages: 96,
      pageNetworks: 1,
      networks: { known: 3, incomplete: true },
    });
    await sql`UPDATE filesv2.share_access SET pages=1 WHERE network='unknown'`;
    expect((await activityReaderData.shareAccess(input, { now })).pageNetworks).toBeNull();
    await sql`DELETE FROM filesv2.share_access WHERE network='unknown'`;
    expect(await activityReaderData.shareAccess(input, { now })).toMatchObject({
      pages: 96,
      pageNetworks: 1,
      networks: { known: 3, incomplete: false },
    });
    const empty = await activityReaderData.shareAccess({ ...input, from: "2030-05-14", to: "2030-05-14" }, { now });
    expect(empty).toMatchObject({ pageNetworks: 0, pages: 0, timeline: { items: [], next: null } });
  });

  test("network pages are bounded to 50 and ordered by combined usage with deterministic network ties", async () => {
    await sql`INSERT INTO filesv2.share_access(share_id,hour,network,client,pages,downloads,password_failed)
      SELECT ${shareId}::uuid,'2030-05-15T00:00:00Z','10.0.'||n||'.0/24','chrome',n % 3,54-n,100*n FROM generate_series(0,54) n`;
    const input = { shareId, from: "2030-05-15", to: "2030-05-15" };
    const first = await activityReaderData.shareAccess(input, { now });
    expect(first.networks.known).toBe(55);
    expect(first.networks.items).toHaveLength(50);
    expect(first.networks.next).toBe(first.networks.items[49]!.network);
    const last = await activityReaderData.shareAccess({ ...input, networkAfter: first.networks.next! }, { now });
    expect(last.networks.items).toHaveLength(5);
    expect(last.networks.next).toBeNull();
    expect(last.networks.known).toBe(55);
    const keys = [...first.networks.items, ...last.networks.items].map((item) => item.network);
    expect(new Set(keys).size).toBe(55);
    const expected = Array.from({ length: 55 }, (_, n) => ({ network: `10.0.${n}.0/24`, usage: (n % 3) + 54 - n })).sort(
      (a, b) => b.usage - a.usage || (a.network < b.network ? -1 : a.network > b.network ? 1 : 0),
    );
    expect(keys).toEqual(expected.map((entry) => entry.network));
    expect(first.networks.items[0]?.network).toBe("10.0.0.0/24");
    await expect(activityReaderData.shareAccess({ ...input, networkAfter: "ffff:ffff:ffff::/48" }, { now })).rejects.toMatchObject({
      code: "share_access_cursor_expired",
      status: 409,
    });
    // The cursor is a network key, but its ordering anchor is recomputed from current totals.
    const anchor = first.networks.next!;
    await sql`UPDATE filesv2.share_access SET downloads=1000 WHERE network=${anchor}`;
    const fresh = await activityReaderData.shareAccess({ ...input, networkAfter: anchor }, { now });
    expect(fresh.networks.items[0]?.network).toBe("10.0.0.0/24");
    await sql`DELETE FROM filesv2.share_access WHERE network=${anchor}`;
    await expect(activityReaderData.shareAccess({ ...input, networkAfter: anchor }, { now })).rejects.toMatchObject({
      code: "share_access_cursor_expired",
      status: 409,
    });
  });

  test("UTC date endpoints are inclusive and unsafe totals or network counters fail explicitly", async () => {
    await sql`INSERT INTO filesv2.share_access VALUES
      (${shareId}::uuid,'2030-05-14T23:00:00Z','192.0.2.0/24','chrome',100,0,0),
      (${shareId}::uuid,'2030-05-15T00:00:00Z','192.0.2.0/24','chrome',1,2,3),
      (${shareId}::uuid,'2030-05-15T12:00:00Z','192.0.2.0/24','chrome',4,5,6),
      (${shareId}::uuid,'2030-05-16T00:00:00Z','192.0.2.0/24','chrome',100,0,0)`;
    const input = { shareId, from: "2030-05-15", to: "2030-05-15" };
    expect(await activityReaderData.shareAccess(input, { now })).toMatchObject({ pages: 5, downloads: 7, passwordFailed: 9 });
    // PostgreSQL bigint is wider than JavaScript's safe counter contract.
    await sql`UPDATE filesv2.share_access SET pages=9007199254740991 WHERE hour='2030-05-15T00:00:00Z'`;
    await expect(activityReaderData.shareAccess(input, { now })).rejects.toThrow("safe integer");
    await sql`UPDATE filesv2.share_access SET pages=0`;
    await sql`INSERT INTO filesv2.share_access_daily VALUES(${shareId}::uuid,'2030-05-15',0,9007199254740992,0)`;
    await expect(activityReaderData.shareAccess(input, { now })).rejects.toThrow("safe integer");
  });
});
