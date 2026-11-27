import { beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { resolveDisplayNames } from "@k2b/cloud/server";
import { accountIdentities } from "@k2b/cloud/services";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { actorId, candidate, historyBinding, historyFixture, home, otherId, publicBaseId } from "../../test/activity-reader-fixture";
import { testActor, testCall } from "../../test/files-call";
import { assertPrivateDatabase } from "../../test/private-database";
import type { ActivityCandidate } from "../data/activity-reader";
import { bindings } from "../data/bases";
import { shares } from "../data/shares";
import { migrate } from "../migrate";
import { withActivityReadBudget } from "./activity-read-budget";
import { connectFilegate } from "./filegate-facade";
import { createFilesService } from "./index";
import { createListingFactsReader } from "./listing-facts";

const suite = suiteFor("database");
const call = testCall(testActor);
const page = {
  binding: historyBinding,
  baseId: publicBaseId,
  folder: "",
  items: [{ path: "new", target: `${home}/new`, itemId: "stable-a", directory: true }],
};

suite("Files listing facts in one batched page read", () => {
  beforeAll(async () => {
    await assertPrivateDatabase();
    await sql`CREATE SCHEMA auth`.simple();
    await sql`CREATE TABLE auth.users(id uuid PRIMARY KEY,uid text,display_name text,avatar_hash text)`.simple();
    await sql`CREATE TABLE auth.groups(id uuid PRIMARY KEY,name text)`.simple();
    await sql`CREATE TABLE auth.access(id uuid PRIMARY KEY)`.simple();
    await migrate();
  });
  beforeEach(async () => {
    await sql`TRUNCATE filesv2.activity,filesv2.bases,filesv2.shares,auth.users CASCADE`.simple();
    await sql`INSERT INTO auth.users(id,uid,display_name) VALUES(${actorId}::uuid,'alice','Live Alice'),(${otherId}::uuid,'bob','Live Bob')`;
    await sql`INSERT INTO filesv2.bases ${sql(historyBinding)}`;
  });

  async function seed(index: number, patch: Partial<ActivityCandidate> = {}) {
    const {
      effective_time: _time,
      metadataUnknown: _metadata,
      observed_before: _before,
      observed_after: _after,
      share_expires_at: _expiry,
      ...row
    } = candidate(index, {
      action: "file.create",
      ...patch,
    });
    await sql`INSERT INTO filesv2.activity ${sql({ ...row, name: "Stored name" })}`;
  }
  async function link(patch: Partial<Parameters<typeof shares.create>[0]> = {}) {
    return shares.create({
      token_hash: `test-token-${patch.title ?? "own"}`,
      password_hash: null,
      kind: "download",
      base_id: historyBinding.id,
      root: historyBinding.root,
      base_path: home,
      server_url: "http://filegate.test",
      target_snapshots: [{ itemId: "stable-a", path: `${home}/old`, directory: true }],
      scope: "",
      items: ["old"],
      title: "own",
      note: null,
      public_note: null,
      owner_uid: null,
      owner_gid: null,
      created_by: actorId,
      created_by_name: "Historical Alice",
      expires_at: null,
      max_file_size: 0,
      max_total_size: 0,
      show_upload_names: false,
      ...patch,
    });
  }
  function fixture() {
    const f = historyFixture();
    const reader = createListingFactsReader({
      requestContext: (...args) => f.deps.requestContext(...args),
      displayNames: resolveDisplayNames,
    });
    return { ...f, reader };
  }

  test("the newest completed user content action wins, using effective time and live names", async () => {
    await seed(1, { action: "file.upload", actor_user_id: actorId });
    await seed(2, { action: "file.edit", finished_at: new Date("2030-05-15T12:01:00Z") });
    await seed(3, { action: "file.overwrite", state: "failed", finished_at: new Date("2030-05-15T12:02:00Z"), actor_user_id: actorId });
    await seed(4, { action: "file.edit", actor_kind: "observed", actor_user_id: null, finished_at: new Date("2030-05-15T12:03:00Z") });
    expect((await fixture().reader(call, page)).get("new")?.author).toEqual({ userId: otherId, name: "Live Bob" });
  });

  test("a move does not reset the author of a stable item", async () => {
    await seed(1, { path_after: `${home}/old` });
    await seed(2, { action: "item.move", actor_user_id: actorId, finished_at: new Date("2030-05-15T12:01:00Z") });
    expect((await fixture().reader(call, page)).get("new")?.author?.userId).toBe(otherId);
  });

  test("stable IDs reject replaced paths, while roots without stable IDs use exact full paths", async () => {
    await seed(1, { item_after_id: "replacement" });
    const f = fixture();
    expect((await f.reader(call, page)).get("new")?.author).toBeNull();
    expect((await f.reader(call, { ...page, items: [{ ...page.items[0]!, itemId: null }] })).get("new")?.author?.userId).toBe(otherId);
    await seed(2, { server_url: "http://different.test", finished_at: new Date("2030-05-15T12:02:00Z"), actor_user_id: actorId });
    await seed(3, { root: "other", finished_at: new Date("2030-05-15T12:03:00Z"), actor_user_id: actorId });
    expect((await f.reader(call, { ...page, items: [{ ...page.items[0]!, itemId: null }] })).get("new")?.author?.userId).toBe(otherId);
  });

  test("link counts include only the reader's own links, for members and admins", async () => {
    await link();
    await link({ created_by: otherId, title: "foreign" });
    const f = fixture();
    expect((await f.reader(call, page)).get("new")?.links).toBe(1);
    f.setAdmin(true);
    expect((await f.reader(call, page)).get("new")?.links).toBe(1);
  });

  test("path matching distinguishes nested search hits beyond a shared 400-character Unicode prefix", async () => {
    const prefix = `nested/${"ä".repeat(410)}`;
    const first = `${prefix}/one/report.txt`;
    const second = `${prefix}/two/report.txt`;
    await seed(1, { path_after: `${home}/${first}`, item_after_id: null, directory: false });
    await seed(2, { path_after: `${home}/${second}`, item_after_id: null, directory: false, actor_user_id: actorId });
    const items = [first, second].map((path) => ({ path, target: `${home}/${path}`, itemId: null, directory: false }));
    const facts = await fixture().reader(call, { ...page, items });
    expect(facts.get(first)?.author?.name).toBe("Live Bob");
    expect(facts.get(second)?.author?.name).toBe("Live Alice");
  });

  test("deleted authors leave no stored display name and need no name lookup", async () => {
    await seed(1);
    await sql`DELETE FROM auth.users WHERE id=${otherId}::uuid`;
    const meter = await meterSql();
    try {
      const statements = await meter.during(async () => {
        expect((await fixture().reader(call, page)).get("new")?.author).toBeNull();
      });
      expect(statements).toHaveLength(1);
      expect(statements[0]).toStartWith("WITH page AS (");
    } finally {
      await meter.close();
    }
  });

  test("expired, revoked, inbox, wrong-storage and malformed links are excluded; legacy paths still match", async () => {
    const expired = await link({ title: "expired" });
    // Expiry is relative to the database clock, independent of the calendar date of this test run.
    await sql`UPDATE filesv2.shares SET expires_at=now()-interval '1 minute' WHERE id=${expired.id}::uuid`;
    const revoked = await link({ title: "revoked" });
    await shares.revoke(revoked.id, actorId);
    await link({ title: "inbox", kind: "inbox" });
    await link({ title: "other-server", server_url: "http://different.test" });
    const malformed = await link({ title: "malformed", items: ["new"] });
    await sql`UPDATE filesv2.shares SET target_snapshots='{}'::jsonb WHERE id=${malformed.id}::uuid`;
    await link({ title: "legacy", target_snapshots: null, server_url: null, items: ["new"] });
    expect((await fixture().reader(call, page)).get("new")?.links).toBe(1);
  });

  test("a reader without history access receives null and never resolves author names", async () => {
    await seed(1);
    const f = fixture();
    const context = f.deps.requestContext;
    f.deps.requestContext = async (...args) => ({ ...(await context(...args)), historyAvailable: false });
    expect((await f.reader(call, page)).get("new")?.author).toBeNull();
    expect(f.authorized).toEqual([]);
  });

  test("a foreign admin receives null without an unaudited history or name read", async () => {
    await seed(1);
    await link({ created_by: otherId, title: "foreign" });
    const f = fixture();
    f.setAdmin(true);
    f.setMember(false);
    const meter = await meterSql();
    try {
      const statements = await meter.during(async () => {
        expect((await f.reader(call, page)).get("new")).toEqual({ author: null, links: 0 });
      });
      expect(statements).toHaveLength(1);
      expect(statements[0]).toStartWith("WITH page AS (");
      expect(f.adminReads).toEqual([]);
      expect(f.authorized).toEqual([]);
      expect(await sql`SELECT id FROM filesv2.activity WHERE action='admin.read'`).toHaveLength(0);
    } finally {
      await meter.close();
    }
  });

  test("listing and search pin the full 50-entry page to three existing statements plus facts and one name lookup", async () => {
    for (let index = 0; index < 50; index++)
      await seed(index + 1, { path_after: `${home}/folder/file-${index}`, item_after_id: `stable-${index}`, directory: false });
    const f = historyFixture();
    const context = await withActivityReadBudget(undefined, (budget) => f.deps.requestContext(testActor, budget));
    const nodes = Array.from({ length: 50 }, (_, index) => f.node(`${home}/folder/file-${index}`, `stable-${index}`, false));
    const transport: typeof fetch = Object.assign(
      async (request: Parameters<typeof fetch>[0]) => {
        const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url);
        if (url.pathname === "/v1/roots/cloud")
          return Response.json({
            stableIds: true,
            managed: true,
            execution: false,
            index: { enabled: true },
            versioning: { enabled: true },
          });
        const path = url.searchParams.get("path") ?? "";
        if (url.pathname.endsWith("/stat")) return Response.json(f.node(path, "folder-id"));
        if (url.pathname.endsWith("/search")) return Response.json({ items: nodes, total: 50 });
        if (url.pathname.endsWith("/entries")) return Response.json({ items: url.searchParams.has("search") ? [] : nodes });
        throw new Error(`Unexpected Filegate request ${url.pathname}`);
      },
      { preconnect: fetch.preconnect },
    );
    const service = createFilesService({
      identities: {
        ...accountIdentities,
        self: async () => ({
          user: { id: actorId, username: "alice", provider: "local", profile: "user", posix: null },
          availability: { localLinuxEnabled: true, freeipaEnabled: false },
        }),
        groups: async () => ({ items: [], nextCursor: null }),
      },
      bindings,
      displayNames: resolveDisplayNames,
      readConfiguration: async () => context.config,
      writeConfiguration: async () => {},
      resetConfiguration: async () => {},
      publicOrigin: async () => "https://cloud.test",
      userById: async () => null,
      transfer: transport,
      connect: (config, signal) => connectFilegate(config, transport, signal),
    });
    const meter = await meterSql();
    try {
      for (const read of [
        () => service.list(call, { baseId: publicBaseId, path: "folder" }),
        () => service.search(call, { baseId: publicBaseId, path: "folder", q: "file" }),
      ]) {
        const statements = await meter.during(async () => {
          const result = await read();
          expect(result.items).toHaveLength(50);
          expect(result.items.every((item) => item.facts?.author?.name === "Live Bob")).toBe(true);
        });
        expect(statements).toEqual([
          "SELECT EXISTS(SELECT 1 FROM filesv2.machine_storage) AS exists",
          "SELECT id,lifecycle,area,kind,identity_id,identity_name,root,path,uid_number::double precision AS uid_number,gid_number:",
          "SELECT * FROM filesv2.operations WHERE root=$1 AND source=$2 AND state='pending'",
          "WITH page AS ( SELECT * FROM unnest( $1 ::text[], $2 ::text[], $3 ::text[], $4 ::boolean[] ) AS entry(path,target,item_i",
          "SELECT id, display_name, uid, avatar_hash FROM auth.users WHERE id = ANY($1 ::uuid[])",
        ]);
      }
    } finally {
      await meter.close();
    }
  });
});
