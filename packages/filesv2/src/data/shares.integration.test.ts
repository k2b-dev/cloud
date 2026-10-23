import { beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { actorId, baseId, historyBinding, home, otherId } from "../../test/activity-reader-fixture";
import { assertPrivateDatabase } from "../../test/private-database";
import { migrate } from "../migrate";
import { type ShareItemFilter, shares } from "./shares";

suiteFor("database")("share item SQL with legacy snapshots", () => {
  beforeAll(async () => {
    await assertPrivateDatabase();
    await sql`CREATE SCHEMA auth`.simple();
    await sql`CREATE TABLE auth.users(id uuid PRIMARY KEY)`.simple();
    await sql`CREATE TABLE auth.groups(id uuid PRIMARY KEY)`.simple();
    await sql`CREATE TABLE auth.access(id uuid PRIMARY KEY)`.simple();
    await migrate();
  });
  beforeEach(async () => {
    await sql`TRUNCATE filesv2.bases,filesv2.shares CASCADE`.simple();
    await sql`INSERT INTO filesv2.bases ${sql(historyBinding)}`;
  });

  const filter = (directory: boolean): ShareItemFilter => ({
    bindingId: baseId,
    serverUrl: "http://filegate.test",
    root: "cloud",
    basePath: home,
    path: directory ? "Inbox" : "Docs/file.txt",
    target: `${home}/${directory ? "Inbox" : "Docs/file.txt"}`,
    directory,
    itemId: "current-id",
  });
  async function seed(id: string, kind: "download" | "inbox", snapshots: string | null) {
    await sql`INSERT INTO filesv2.shares(id,token_hash,kind,base_id,root,base_path,scope,items,title,created_by,created_by_name,target_snapshots,created_at)
      VALUES(${id}::uuid,${id},${kind},${baseId}::uuid,'cloud',${home},'Inbox','["Docs/file.txt"]','Share',${actorId}::uuid,'Alice',${snapshots}::jsonb,'2030-05-15T12:00:00Z')`;
    // Exercise SQL NULL separately from the driver's JSON-null parameter encoding.
    if (snapshots === null) await sql`UPDATE filesv2.shares SET target_snapshots=NULL WHERE id=${id}::uuid`;
  }

  test.each(["download", "inbox"] as const)("%s treats only SQL NULL and JSON null as legacy absence", async (kind) => {
    const variants = [null, "null", "[]", "{}", '"invalid"', "0", "false"];
    const ids = variants.map((_, i) => `50000000-0000-4000-8000-${(i + 1).toString().padStart(12, "0")}`);
    for (const [i, snapshots] of variants.entries()) await seed(ids[i]!, kind, snapshots);
    const item = filter(kind === "inbox");
    const first = await shares.list({ ownerId: actorId, item, limit: 1 });
    expect(first.items.map((row) => row.id)).toEqual([ids[1]!]);
    expect(first.next).toBe(ids[1]!);
    const last = await shares.list({ ownerId: actorId, item, limit: 1, after: first.next! });
    expect(last.items.map((row) => row.id)).toEqual([ids[0]!]);
    expect(last.next).toBeNull();
    expect(first.items[0]?.target_snapshots).toBeNull();
    expect(last.items[0]?.target_snapshots).toBeNull();
    for (const patch of [{ root: "other" }, { basePath: "users/replacement" }, { path: "Other", target: `${home}/Other` }])
      expect((await shares.list({ ownerId: actorId, item: { ...item, ...patch } })).items).toEqual([]);
    expect((await shares.list({ ownerId: otherId, item })).items).toEqual([]);
    expect((await shares.list({ ownerId: actorId, after: ids[1]!, limit: 1 })).items.map((row) => row.id)).toEqual([ids[0]!]);
    await sql`UPDATE filesv2.shares SET server_url='http://original.test'`;
    expect((await shares.list({ ownerId: actorId, item })).items).toEqual([]);
  });

  test("retained stable identity remains authoritative over a reused path", async () => {
    const id = "50000000-0000-4000-8000-000000000001";
    const item = filter(false);
    await seed(id, "download", JSON.stringify([{ path: item.target, directory: false, itemId: item.itemId }]));
    expect(
      (await shares.list({ ownerId: actorId, item: { ...item, path: "Moved.txt", target: `${home}/Moved.txt` } })).items.map(
        (row) => row.id,
      ),
    ).toEqual([id]);
    expect((await shares.list({ ownerId: actorId, item: { ...item, itemId: "replacement" } })).items).toEqual([]);
    expect((await shares.list({ ownerId: actorId, item: { ...item, directory: true } })).items).toEqual([]);
    expect((await shares.list({ ownerId: actorId, item: { ...item, itemId: null } })).items.map((row) => row.id)).toEqual([id]);
  });
});
