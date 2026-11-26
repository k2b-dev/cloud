import { beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { resolveDisplayNames } from "@k2b/cloud/server";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
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
import type { Binding } from "../data/bases";
import { migrate } from "../migrate";
import { createActivityReader } from "./activity-reader";

const suite = suiteFor("database");
const call = testCall(testActor);
const groupId = "20000000-0000-4000-8000-000000000002";
const foreignId = "20000000-0000-4000-8000-000000000003";
const groupIdentity = "50000000-0000-4000-8000-000000000001";
const group: Binding = {
  ...historyBinding,
  id: groupId,
  kind: "groups",
  identity_id: groupIdentity,
  identity_name: "werkstatt",
  path: "groups/werkstatt",
};
const foreign: Binding = {
  ...historyBinding,
  id: foreignId,
  kind: "groups",
  identity_id: otherId,
  identity_name: "privat",
  path: "groups/privat",
};
/** The storages the service authorized (see `wholeStorages`), on the fixture's server. */
const scope = (bindingIds: string[]) => ({ serverUrl: "http://filegate.test", bindingIds });
const at = (minute: number) => new Date(`2030-05-15T12:${String(minute).padStart(2, "0")}:00.000Z`);

suite("Files storage table: who changed each storage last", () => {
  beforeAll(async () => {
    await assertPrivateDatabase();
    await sql`CREATE SCHEMA auth`.simple();
    await sql`CREATE TABLE auth.users(id uuid PRIMARY KEY,uid text,display_name text,avatar_hash text)`.simple();
    await sql`CREATE TABLE auth.groups(id uuid PRIMARY KEY,name text)`.simple();
    await sql`CREATE TABLE auth.access(id uuid PRIMARY KEY)`.simple();
    await migrate();
  });
  beforeEach(async () => {
    await sql`TRUNCATE filesv2.activity,filesv2.bases,auth.users CASCADE`.simple();
    await sql`INSERT INTO auth.users(id,uid,display_name) VALUES(${actorId}::uuid,'alice','Live Alice'),(${otherId}::uuid,'bob','Live Bob')`;
    for (const binding of [historyBinding, group, foreign]) await sql`INSERT INTO filesv2.bases ${sql(binding)}`;
  });

  let index = 0;
  async function seed(patch: Partial<ActivityCandidate>) {
    index += 1;
    const {
      effective_time: _time,
      metadataUnknown: _metadata,
      observed_before: _before,
      observed_after: _after,
      share_expires_at: _expiry,
      ...row
    } = candidate(index, { action: "file.edit", path_before: `${home}/a.md`, path_after: `${home}/a.md`, ...patch });
    await sql`INSERT INTO filesv2.activity ${sql({ ...row, name: "Stored name" })}`;
  }
  /** The reader on the real statement; the service passes it the bindings it authorized. */
  function reader() {
    return createActivityReader({ ...historyFixture().deps, data: activityReaderData, displayNames: resolveDisplayNames });
  }

  test("each storage names its newest finished content change, inside its own path, with the live name", async () => {
    await seed({ actor_user_id: otherId, finished_at: at(1) });
    await seed({ actor_user_id: actorId, finished_at: at(2) });
    // newer, but no change of what the storage holds, not finished, or outside the storage's own path
    await seed({ action: "share.create", finished_at: at(3) });
    await seed({ state: "failed", finished_at: at(4) });
    await seed({ path_before: "users/alicia/b.md", path_after: "users/alicia/b.md", finished_at: at(5) });
    // the group: an upload has no old side, so its new side names the storage
    await seed({
      action: "file.upload",
      base_id: groupId,
      path_before: null,
      path_after: "groups/werkstatt/Plan.pdf",
      actor_user_id: otherId,
      finished_at: at(6),
    });
    // a storage the service did not pass says nothing
    await seed({ base_id: foreignId, path_before: "groups/privat/x", path_after: "groups/privat/x", finished_at: at(7) });

    const changes = await reader().storageChanges(call, scope([baseId, groupId]));
    expect(changes.toSorted((a, b) => a.baseId.localeCompare(b.baseId))).toEqual([
      {
        baseId: `cloud:groups:${groupIdentity}`,
        time: at(6).toISOString(),
        actor: { kind: "user", userId: otherId, name: "Live Bob" },
        via: "web",
      },
      { baseId: publicBaseId, time: at(2).toISOString(), actor: { kind: "user", userId: actorId, name: "Live Alice" }, via: "web" },
    ]);
  });

  test("a storage the service does not pass says nothing, also where the reader is a member", async () => {
    await seed({ finished_at: at(1) });
    await seed({ base_id: groupId, path_before: "groups/werkstatt/x", path_after: "groups/werkstatt/x", finished_at: at(2) });
    expect((await reader().storageChanges(call, scope([groupId]))).map((change) => change.baseId)).toEqual([
      `cloud:groups:${groupIdentity}`,
    ]);
  });

  test("a move into the storage counts for it by its new side", async () => {
    await seed({
      action: "item.move",
      base_id: baseId,
      base_after_id: groupId,
      path_before: `${home}/Plan.pdf`,
      path_after: "groups/werkstatt/Plan.pdf",
      finished_at: at(8),
    });
    const changes = await reader().storageChanges(call, scope([groupId]));
    expect(changes.map((change) => [change.baseId, change.time])).toEqual([[`cloud:groups:${groupIdentity}`, at(8).toISOString()]]);
  });

  test("all storages cost one read of the activity, and their people one lookup of names", async () => {
    for (let minute = 0; minute < 20; minute++) await seed({ finished_at: at(minute), actor_user_id: minute % 2 ? actorId : otherId });
    await seed({ base_id: groupId, path_before: "groups/werkstatt/x", path_after: "groups/werkstatt/x", finished_at: at(30) });
    const meter = await meterSql();
    try {
      const statements = await meter.during(() => reader().storageChanges(call, scope([baseId, groupId])));
      // one read of the activity in the reader's budget frame (BEGIN, its timeout, the read, COMMIT), one of names
      expect(statements).toHaveLength(5);
      expect(
        statements.filter((statement) => statement.includes("filesv2.activity") || statement.startsWith("SELECT b.id AS binding_id")),
      ).toHaveLength(1);
      expect(statements[2]).toStartWith("SELECT b.id AS binding_id");
    } finally {
      await meter.close();
    }
  });

  test("a reader of no storage reads nothing", async () => {
    await seed({ finished_at: at(1) });
    const meter = await meterSql();
    try {
      const statements = await meter.during(async () => expect(await reader().storageChanges(call, scope([]))).toEqual([]));
      expect(statements).toEqual([]);
    } finally {
      await meter.close();
    }
  });
});
