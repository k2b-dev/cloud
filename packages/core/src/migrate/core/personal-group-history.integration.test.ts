import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { migrate as migrateAudit } from "./audit";
import { migrate as migrateAuth } from "./auth";
import { migratePersonalGroupHistory, scanPersonalGroupHistory, startPersonalGroupHistory } from "./personal-group-history";
import { migratePosix } from "./posix";

databaseSuite()("historical personal-group retirement", () => {
  let disposable: Awaited<ReturnType<typeof useFreshDatabase>>;
  let number = 800000;
  const cases: { id: string; owner: string; gid: number }[] = [];
  const legacy = async (proof = true) => {
    const id = crypto.randomUUID();
    const owner = crypto.randomUUID();
    const gid = ++number;
    await sql`INSERT INTO auth.groups(id,cn,provider,name,gid_number) VALUES(${id}::uuid,${`local:legacy_${gid}`},'local',${`legacy_${gid}`},${gid})`;
    await sql`INSERT INTO auth.posix_allocations(kind,number,owner_id) VALUES ('gid',${gid},${id}::uuid),('uid',${gid},${owner}::uuid)`;
    if (proof)
      await sql`INSERT INTO audit.events(action,outcome,target_type,target_id,metadata)
      VALUES('accounts.linux.provision','allowed','user',${owner},${JSON.stringify({ primaryGroupId: id, uidNumber: gid, gidNumber: gid })}::text::jsonb)`;
    const result = { id, owner, gid };
    cases.push(result);
    return result;
  };
  beforeAll(async () => {
    disposable = await useFreshDatabase("personal_history");
    await migrateAuth();
    await migrateAudit();
    await migratePersonalGroupHistory();
  });
  afterAll(async () => {
    await sql.close();
    await disposable?.drop();
  });

  test("startup migration does not inspect candidates, and a scheduled scan can be stopped before it starts", async () => {
    const item = await legacy();
    await migratePersonalGroupHistory();
    expect(await sql`SELECT id FROM auth.groups WHERE id=${item.id}::uuid`).toHaveLength(1);
    expect(await sql`SELECT * FROM auth.personal_group_review WHERE group_id=${item.id}::uuid`).toHaveLength(0);
    const stop = startPersonalGroupHistory();
    await stop();
    expect(await sql`SELECT id FROM auth.groups WHERE id=${item.id}::uuid`).toHaveLength(1);
    await sql`DELETE FROM auth.groups WHERE id=${item.id}::uuid`;
  });

  test("an abort after collecting candidates rolls back instead of completing unchecked cases", async () => {
    const item = await legacy();
    const controller = new AbortController();
    const check = spyOn(controller.signal, "throwIfAborted").mockImplementation(() => {
      controller.abort();
      throw controller.signal.reason;
    });
    try {
      await expect(scanPersonalGroupHistory(sql, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
      expect(check).toHaveBeenCalled();
      expect(await sql`SELECT * FROM auth.personal_group_review WHERE group_id=${item.id}::uuid`).toHaveLength(0);
      expect(await sql`SELECT id FROM auth.groups WHERE id=${item.id}::uuid`).toHaveLength(1);
    } finally {
      check.mockRestore();
    }
    await scanPersonalGroupHistory();
    expect(await sql`SELECT * FROM auth.personal_groups WHERE group_id=${item.id}::uuid AND retired_at IS NOT NULL`).toHaveLength(1);
  });

  test("retires only an unreferenced, uniquely audited deleted owner's group and preserves its GID", async () => {
    const safe = await legacy();
    await scanPersonalGroupHistory();
    expect(await sql`SELECT * FROM auth.groups WHERE id=${safe.id}::uuid`).toHaveLength(0);
    const [tombstone] = await sql`SELECT * FROM auth.personal_groups WHERE group_id=${safe.id}::uuid`;
    expect(tombstone).toMatchObject({ owner_id: safe.owner, group_name: `legacy_${safe.gid}`, gid_number: safe.gid });
    expect(tombstone!.retired_at).toBeInstanceOf(Date);
    expect(await sql`SELECT * FROM audit.events WHERE action='accounts.linux.retire_personal_group' AND target_id=${safe.id}`).toHaveLength(
      1,
    );
    expect(await sql`SELECT * FROM auth.posix_allocations WHERE kind='gid' AND owner_id=${safe.id}::uuid`).toHaveLength(1);
    await scanPersonalGroupHistory();
    const [replayed] = await sql`SELECT * FROM auth.personal_groups WHERE group_id=${safe.id}::uuid`;
    expect(replayed).toEqual(tombstone);
  });

  test("reports members, nested groups, managers, directory shares, grants, application references and uncertain evidence without altering them", async () => {
    const [member] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users(uid,provider,profile) VALUES('history_member','local','user') RETURNING id`;
    const [recipient] = await sql<
      { id: string }[]
    >`INSERT INTO auth.service_accounts(name,kind,status) VALUES('History recipient','standalone','active') RETURNING id`;
    await sql`CREATE TABLE auth.history_app_reference(group_id UUID REFERENCES auth.groups(id) ON DELETE CASCADE)`.simple();
    const referenced = await Promise.all(Array.from({ length: 8 }, () => legacy()));
    await sql`INSERT INTO auth.user_groups_v2 VALUES(${member!.id}::uuid,${referenced[0]!.id}::uuid)`;
    await sql`INSERT INTO auth.group_groups_v2 VALUES(${referenced[1]!.id}::uuid,${referenced[2]!.id}::uuid)`;
    await sql`INSERT INTO auth.group_manager_users_v2 VALUES(${referenced[3]!.id}::uuid,${member!.id}::uuid)`;
    await sql`INSERT INTO auth.group_manager_groups_v2 VALUES(${referenced[4]!.id}::uuid,${referenced[5]!.id}::uuid)`;
    await sql`INSERT INTO auth.directory_shares(recipient_id,group_id) VALUES(${recipient!.id}::uuid,${referenced[6]!.id}::uuid)`;
    await sql`INSERT INTO auth.access(group_id,permission) VALUES(${referenced[7]!.id}::uuid,'write')`;
    const app = await legacy();
    await sql`INSERT INTO auth.history_app_reference VALUES(${app.id}::uuid)`;
    const unknown = await legacy(false);
    const missingAllProof = await legacy(false);
    await sql`DELETE FROM auth.posix_allocations WHERE owner_id IN (${missingAllProof.id}::uuid,${missingAllProof.owner}::uuid)`;
    const ambiguous = await legacy();
    await sql`INSERT INTO audit.events(action,outcome,target_type,target_id,metadata)
      VALUES('accounts.linux.provision','allowed','user',${crypto.randomUUID()},${JSON.stringify({ primaryGroupId: ambiguous.id, uidNumber: ambiguous.gid, gidNumber: ambiguous.gid })}::text::jsonb)`;
    const mismatched = await legacy();
    await sql`UPDATE auth.posix_allocations SET number=${++number} WHERE kind='uid' AND owner_id=${mismatched.owner}::uuid`;
    const missingReservation = await legacy();
    await sql`DELETE FROM auth.posix_allocations WHERE kind='gid' AND owner_id=${missingReservation.id}::uuid`;
    const active = await legacy();
    await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${active.owner}::uuid,'history_active','local','user')`;
    const ordinary = await legacy(false);
    await sql`INSERT INTO audit.events(action,outcome,target_type,target_id,metadata)
      VALUES('accounts.linux.provision_group','allowed','group',${ordinary.id},${JSON.stringify({ gidNumber: ordinary.gid })}::text::jsonb)`;
    const preserved = [...referenced, app, unknown, missingAllProof, ambiguous, mismatched, missingReservation, active, ordinary];
    const before = await sql`SELECT * FROM auth.groups ORDER BY id`;
    await scanPersonalGroupHistory();
    expect(await sql`SELECT * FROM auth.groups ORDER BY id`).toEqual(before);
    for (const item of preserved) expect(await sql`SELECT * FROM auth.personal_groups WHERE group_id=${item.id}::uuid`).toHaveLength(0);
    for (const item of [...referenced, app]) {
      const [review] = await sql`SELECT reason,details FROM auth.personal_group_review WHERE group_id=${item.id}::uuid`;
      expect(review!.reason).toBe("remaining_references");
      expect(review!.details.references.length).toBeGreaterThan(0);
    }
    for (const item of [unknown, ambiguous, mismatched, missingReservation, active]) {
      const [review] = await sql`SELECT reason FROM auth.personal_group_review WHERE group_id=${item.id}::uuid`;
      expect(review!.reason).toBe("ownership_unproven");
    }
    expect(await sql`SELECT * FROM auth.personal_group_review WHERE group_id=${ordinary.id}::uuid`).toHaveLength(0);
    expect(await sql`SELECT * FROM auth.personal_group_review WHERE group_id=${missingAllProof.id}::uuid`).toHaveLength(0);
    const reports = await sql`SELECT * FROM auth.personal_group_review ORDER BY group_id`;
    await scanPersonalGroupHistory();
    const warn = spyOn(console, "warn");
    try {
      await scanPersonalGroupHistory();
      expect(warn).not.toHaveBeenCalled();
      expect(await sql`SELECT * FROM auth.personal_group_review ORDER BY group_id`).toEqual(reports);
    } finally {
      warn.mockRestore();
    }
  });

  test("preserves soft directory bindings, approval policies and nested JSON principals", async () => {
    await sql`CREATE SCHEMA filesv2`.simple();
    await sql`CREATE TABLE filesv2.bases(kind TEXT, identity_id UUID)`.simple();
    await sql`CREATE SCHEMA grids`.simple();
    await sql`CREATE TABLE grids.table_finalization_activations(approver_group_id UUID)`.simple();
    await sql`CREATE TABLE grids.records(data JSONB)`.simple();
    const directory = await legacy();
    const approval = await legacy();
    const principal = await legacy();
    await sql`INSERT INTO filesv2.bases VALUES('groups',${directory.id}::uuid)`;
    await sql`INSERT INTO grids.table_finalization_activations VALUES(${approval.id}::uuid)`;
    await sql`INSERT INTO grids.records VALUES(${JSON.stringify({ field: [{ type: "group", id: principal.id }] })}::text::jsonb)`;
    await scanPersonalGroupHistory();
    for (const item of [directory, approval, principal]) {
      expect(await sql`SELECT id FROM auth.groups WHERE id=${item.id}::uuid`).toHaveLength(1);
      const [review] = await sql`SELECT reason,details FROM auth.personal_group_review WHERE group_id=${item.id}::uuid`;
      expect(review!.reason).toBe("remaining_references");
      expect(review!.details.references.length).toBeGreaterThan(0);
    }
    await sql`DELETE FROM grids.records`;
    await scanPersonalGroupHistory();
    // Finished cases stay unchanged even if references disappear; retry is deliberate.
    expect(await sql`SELECT id FROM auth.groups WHERE id=${principal.id}::uuid`).toHaveLength(1);
    await sql`DELETE FROM auth.personal_group_review WHERE group_id=${principal.id}::uuid`;
    await scanPersonalGroupHistory();
    expect(await sql`SELECT * FROM auth.personal_group_review WHERE group_id=${principal.id}::uuid`).toHaveLength(0);
    expect(await sql`SELECT * FROM auth.personal_groups WHERE group_id=${principal.id}::uuid AND retired_at IS NOT NULL`).toHaveLength(1);
  });

  test("preserves UUID arrays, encoded JSON and persisted workflow or notification audiences", async () => {
    await sql`CREATE SCHEMA workflows`.simple();
    await sql`CREATE TABLE workflows.history_reference(definition JSONB)`.simple();
    await sql`CREATE SCHEMA notifications`.simple();
    await sql`CREATE TABLE notifications.history_reference(selection JSONB)`.simple();
    const items = await Promise.all(Array.from({ length: 6 }, () => legacy()));
    await sql`INSERT INTO grids.records VALUES(${JSON.stringify({ filter: [items[0]!.id] })}::text::jsonb)`;
    await sql`INSERT INTO grids.records VALUES(${JSON.stringify(JSON.stringify({ type: "group", id: items[1]!.id }))}::text::jsonb)`;
    await sql`INSERT INTO grids.records VALUES(${JSON.stringify({ filter: [items[4]!.id.toUpperCase()] })}::text::jsonb)`;
    await sql`INSERT INTO workflows.history_reference VALUES(${JSON.stringify({ groupIds: [items[2]!.id] })}::text::jsonb)`;
    await sql`INSERT INTO notifications.history_reference VALUES(${JSON.stringify({ groupIds: [items[3]!.id] })}::text::jsonb)`;
    await sql`INSERT INTO grids.records VALUES(${JSON.stringify({ text: `11111111-2222-3333-4444-5555${items[5]!.id}` })}::text::jsonb)`;
    await scanPersonalGroupHistory();
    for (const item of items) {
      expect(await sql`SELECT id FROM auth.groups WHERE id=${item.id}::uuid`).toHaveLength(1);
      const [review] = await sql`SELECT reason FROM auth.personal_group_review WHERE group_id=${item.id}::uuid`;
      expect(review!.reason).toBe("remaining_references");
    }
  });

  test("completes busy-table cases once without waiting and requires an explicit retry", async () => {
    const item = await legacy();
    const referenced = await legacy();
    await sql`INSERT INTO auth.access(group_id,permission) VALUES(${referenced.id}::uuid,'write')`;
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const writer = sql.begin(async (tx) => {
      await tx`INSERT INTO grids.records VALUES('{}'::jsonb)`;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const migration = scanPersonalGroupHistory();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        migration,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("History migration waited for an application writer")), 5000);
        }),
      ]);
      const [review] = await sql`SELECT reason FROM auth.personal_group_review WHERE group_id=${item.id}::uuid`;
      expect(review!.reason).toBe("references_unchecked");
      const [alreadyReferenced] = await sql`SELECT reason FROM auth.personal_group_review WHERE group_id=${referenced.id}::uuid`;
      expect(alreadyReferenced!.reason).toBe("references_unchecked");
      expect(await sql`SELECT id FROM auth.groups WHERE id=${item.id}::uuid`).toHaveLength(1);
    } finally {
      clearTimeout(timer);
      release.resolve();
      await writer;
      await migration;
    }
    const [completed] = await sql`SELECT completed_at FROM auth.personal_group_review WHERE group_id=${item.id}::uuid`;
    await scanPersonalGroupHistory();
    expect(await sql`SELECT id FROM auth.groups WHERE id=${item.id}::uuid`).toHaveLength(1);
    const [unchanged] = await sql`SELECT completed_at FROM auth.personal_group_review WHERE group_id=${item.id}::uuid`;
    expect(unchanged).toEqual(completed);
    await sql`DELETE FROM auth.personal_group_review WHERE group_id=${item.id}::uuid`;
    await scanPersonalGroupHistory();
    expect(await sql`SELECT * FROM auth.personal_groups WHERE group_id=${item.id}::uuid AND retired_at IS NOT NULL`).toHaveLength(1);
    expect(await sql`SELECT * FROM auth.personal_group_review WHERE group_id=${item.id}::uuid`).toHaveLength(0);
  });

  test("reports non-ID foreign keys conservatively instead of aborting startup", async () => {
    const item = await legacy();
    await sql`CREATE TABLE auth.history_name_reference(cn TEXT REFERENCES auth.groups(cn) ON DELETE CASCADE)`.simple();
    try {
      await sql`INSERT INTO auth.history_name_reference VALUES(${`local:legacy_${item.gid}`})`;
      await scanPersonalGroupHistory();
      expect(await sql`SELECT id FROM auth.groups WHERE id=${item.id}::uuid`).toHaveLength(1);
      const [review] = await sql`SELECT details FROM auth.personal_group_review WHERE group_id=${item.id}::uuid`;
      expect(review!.details.references).toContain("auth.history_name_reference.cn (non-id or composite constraint)");
    } finally {
      await sql`DROP TABLE auth.history_name_reference`.simple();
    }
  });

  test("reports conflicting ordinary provisioning and excludes IPA identities", async () => {
    const conflict = await legacy();
    await sql`INSERT INTO audit.events(action,outcome,target_type,target_id,metadata)
      VALUES('accounts.linux.provision_group','allowed','group',${conflict.id},${JSON.stringify({ gidNumber: conflict.gid })}::text::jsonb)`;
    const ipa = await legacy();
    await sql`UPDATE auth.groups SET provider='ipa' WHERE id=${ipa.id}::uuid`;
    await scanPersonalGroupHistory();
    const [review] = await sql`SELECT reason FROM auth.personal_group_review WHERE group_id=${conflict.id}::uuid`;
    expect(review!.reason).toBe("ownership_unproven");
    expect(await sql`SELECT * FROM auth.personal_group_review WHERE group_id=${ipa.id}::uuid`).toHaveLength(0);
    expect(await sql`SELECT id FROM auth.groups WHERE id=${ipa.id}::uuid`).toHaveLength(1);
  });

  test("a reserved GID without a current primary-group owner remains reviewable even without a matching UID number", async () => {
    const item = await legacy(false);
    await sql`DELETE FROM auth.posix_allocations WHERE kind='uid' AND owner_id=${item.owner}::uuid`;
    await scanPersonalGroupHistory();
    const [review] = await sql`SELECT reason,completed_at FROM auth.personal_group_review WHERE group_id=${item.id}::uuid`;
    expect(review!.reason).toBe("ownership_unproven");
    expect(review!.completed_at).toBeInstanceOf(Date);
    expect(await sql`SELECT id FROM auth.groups WHERE id=${item.id}::uuid`).toHaveLength(1);
  });

  test("backfill remembers live ownership idempotently and never provisions unrelated groups", async () => {
    const id = crypto.randomUUID();
    const groupId = crypto.randomUUID();
    const gid = ++number;
    await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${id}::uuid,'history_live','local','user')`;
    await sql`INSERT INTO auth.groups(id,cn,provider,name,gid_number) VALUES(${groupId}::uuid,'local:history_live','local','history_live',${gid})`;
    await sql`INSERT INTO auth.user_posix(user_id,managed_by,uid_number,primary_gid_number,primary_group_id,home_directory,login_shell)
      VALUES(${id}::uuid,'local',${gid},${gid},${groupId}::uuid,'/home/history_live','/bin/bash')`;
    // Simulate a pre-upgrade identity; migratePosix backfills without any new identity allocation.
    await sql`DELETE FROM auth.personal_groups WHERE group_id=${groupId}::uuid`;
    await migratePosix();
    await migratePosix();
    expect(
      await sql`SELECT * FROM auth.personal_groups WHERE group_id=${groupId}::uuid AND owner_id=${id}::uuid AND retired_at IS NULL`,
    ).toHaveLength(1);
    await sql`DELETE FROM auth.users WHERE id=${id}::uuid`;
    expect(await sql`SELECT * FROM auth.groups WHERE id=${groupId}::uuid`).toHaveLength(0);
  });
  test("rejects reassignment and diagnoses duplicate legacy owners with the group ID", async () => {
    const item = await legacy();
    const owner = crypto.randomUUID();
    const second = crypto.randomUUID();
    for (const id of [owner, second]) await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${id}::uuid,${id},'local','user')`;
    const insert = async (id: string) =>
      await sql`INSERT INTO auth.user_posix(user_id,managed_by,uid_number,primary_gid_number,primary_group_id,home_directory,login_shell)
      VALUES(${id}::uuid,'local',${item.gid},${item.gid},${item.id}::uuid,'/home/example','/bin/bash')`;
    await insert(owner);
    await expect(insert(second)).rejects.toMatchObject({ errno: "23514" });
    await sql`ALTER TABLE auth.user_posix DISABLE TRIGGER remember_personal_group`.simple();
    try {
      await insert(second);
      await expect(migratePosix()).rejects.toThrow(item.id);
    } finally {
      await sql`DELETE FROM auth.user_posix WHERE user_id=${second}::uuid`;
      await sql`ALTER TABLE auth.user_posix ENABLE TRIGGER remember_personal_group`.simple();
      await sql`DELETE FROM auth.users WHERE id IN (${owner}::uuid,${second}::uuid)`;
    }
  });
});
