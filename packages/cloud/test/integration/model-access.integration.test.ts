import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAuth } from "../../../core/src/migrate/core/auth";
import { migrate as migrateSettings } from "../../../core/src/migrate/core/settings";
import { AiModelAccessConflict, aiModelAccess } from "../../src/ai/model-access";
import { migrateAiModelAccess } from "../../src/ai/model-access-migrate";
import type { Principal } from "../../src/contracts/shared";

const suite = databaseSuite();
const draft = <T extends Principal>(principal: T) => ({ principal, permission: "read" as const });

suite("Assistant model grants using normal Cloud access", () => {
  let userId: string;
  let outsiderId: string;
  let groupId: string;
  let serviceAccountId: string;
  const subject = () => ({ type: "user" as const, userId });
  let fresh: Awaited<ReturnType<typeof useFreshDatabase>>;
  afterAll(async () => {
    await sql.close();
    await fresh?.drop();
  });
  const sync = (ids: string[], changes: Parameters<typeof aiModelAccess.syncModels>[1] = []) =>
    sql.begin((tx) => aiModelAccess.syncModels(ids, changes, tx));

  beforeAll(async () => {
    fresh = await useFreshDatabase("model_access");
    await migrateAuth();
    await migrateSettings();
    await sql`CREATE SCHEMA IF NOT EXISTS ai`;
    for (const label of ["member", "outsider"]) {
      const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, mail)
        VALUES (${label}, 'local', 'user', ${label}, ${`${label}@example.test`}) RETURNING id`;
      if (!user) throw new Error("Missing fixture user");
      if (label === "member") userId = user.id;
      else outsiderId = user.id;
    }
    const groups: string[] = [];
    for (const name of ["parent", "child"]) {
      const [group] = await sql<
        { id: string }[]
      >`INSERT INTO auth.groups (cn, provider, name) VALUES (${name}, 'local', ${name}) RETURNING id`;
      if (!group) throw new Error("Missing fixture group");
      groups.push(group.id);
    }
    groupId = groups[0]!;
    await sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${groupId}::uuid, ${groups[1]!}::uuid)`;
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${userId}::uuid, ${groups[1]!}::uuid)`;
    const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
      VALUES ('test', 'resource_bound', 'test', 'fixture', 'model-access') RETURNING id`;
    if (!account) throw new Error("Missing fixture account");
    serviceAccountId = account.id;
    await migrateAiModelAccess();
    await sync(["open", "limited"]);
  });

  test("new models receive real authenticated grants and schema migration is idempotent", async () => {
    const initial = await aiModelAccess.listForAdmin();
    expect(initial.open?.entries.map((entry) => entry.principal)).toEqual([{ type: "authenticated" }]);
    await migrateAiModelAccess();
    expect(await aiModelAccess.listForAdmin()).toEqual(initial);
    const candidates = [
      { id: "limited", modelId: "limited" },
      { id: "missing", modelId: "missing" },
      { id: "open", modelId: "open" },
    ];
    expect(await aiModelAccess.filterModels(candidates, subject())).toEqual([
      { id: "limited", modelId: "limited" },
      { id: "open", modelId: "open" },
    ]);
    expect(await aiModelAccess.filterModels(candidates, null)).toEqual([]);
  });

  test("nested groups and service accounts use canonical resolver; explicit denial fails closed", async () => {
    const state = await aiModelAccess.listForAdmin();
    await sync(
      ["open", "limited"],
      [
        {
          modelId: "limited",
          expectedRevision: state.limited!.revision,
          entries: [draft({ type: "group", groupId }), draft({ type: "service_account", serviceAccountId })],
        },
      ],
    );
    await expect(aiModelAccess.assertAllowed("limited", subject())).resolves.toBeUndefined();
    await expect(aiModelAccess.assertAllowed("limited", { type: "service_account", serviceAccountId })).resolves.toBeUndefined();
    // The permission editor names the account by its kind.
    expect((await aiModelAccess.listForAdmin()).limited?.entries.find((entry) => entry.principal.type === "service_account")).toMatchObject(
      {
        serviceAccountKind: "resource_bound",
      },
    );
    await expect(aiModelAccess.assertAllowed("limited", { type: "user", userId: outsiderId })).rejects.toMatchObject({
      aiError: { code: "model_access_denied" },
    });
    await expect(aiModelAccess.assertAllowed("missing", subject())).rejects.toThrow();
  });

  test("empty permissions stay denied across migration and stale drafts conflict", async () => {
    const state = await aiModelAccess.listForAdmin();
    const change = { modelId: "limited", expectedRevision: state.limited!.revision, entries: [] };
    await sync(["open", "limited"], [change]);
    await expect(sync(["open", "limited"], [change])).rejects.toBeInstanceOf(AiModelAccessConflict);
    await migrateAiModelAccess();
    expect((await aiModelAccess.listForAdmin()).limited?.entries).toEqual([]);
    await expect(aiModelAccess.assertAllowed("limited", subject())).rejects.toThrow();
  });

  test("invalid principals roll back ACL and setting changes atomically", async () => {
    const before = await aiModelAccess.listForAdmin();
    await expect(
      sql.begin(async (tx) => {
        await tx`INSERT INTO settings.entries (key, value) VALUES ('model_access_rollback_probe', 'changed')`;
        await aiModelAccess.syncModels(
          ["open", "limited"],
          [{ modelId: "open", expectedRevision: before.open!.revision, entries: [draft({ type: "user", userId: crypto.randomUUID() })] }],
          tx,
        );
      }),
    ).rejects.toThrow();
    expect(await aiModelAccess.listForAdmin()).toEqual(before);
    expect(await sql`SELECT key FROM settings.entries WHERE key = 'model_access_rollback_probe'`).toHaveLength(0);
  });

  test("new models have independent grants and deletion cleans grant rows", async () => {
    let state = await aiModelAccess.listForAdmin();
    await sync(
      ["open", "limited", "copy"],
      [
        {
          modelId: "copy",
          expectedRevision: null,
          entries: state.open!.entries.map(({ principal }) => {
            if (principal.type === "public") throw new Error("Fixture grant must not be public");
            return draft(principal);
          }),
        },
      ],
    );
    state = await aiModelAccess.listForAdmin();
    expect(state.copy!.entries[0]!.id).not.toBe(state.open!.entries[0]!.id);
    await sync(
      ["renamed", "limited", "copy"],
      [
        {
          modelId: "renamed",
          expectedRevision: null,
          entries: [draft({ type: "user", userId }), draft({ type: "user", userId })],
        },
      ],
    );
    state = await aiModelAccess.listForAdmin();
    expect(state.open).toBeUndefined();
    expect(state.renamed!.entries).toHaveLength(1);
    expect(await aiModelAccess.filterModels([{ id: "renamed", modelId: "renamed" }], subject())).toHaveLength(1);
    const ids = Object.values(state).flatMap((entry) => entry.entries.map((grant) => grant.id));
    await sync([]);
    expect(await aiModelAccess.listForAdmin()).toEqual({});
    for (const id of ids) expect(await sql`SELECT id FROM auth.access WHERE id = ${id}::uuid`).toHaveLength(0);
  });

  test("deleted and recreated model cannot reuse its old permission revision", async () => {
    await sync(["recreated"]);
    const old = (await aiModelAccess.listForAdmin()).recreated!.revision;
    await sync([]);
    await sync(["recreated"]);
    await expect(sync(["recreated"], [{ modelId: "recreated", expectedRevision: old, entries: [] }])).rejects.toBeInstanceOf(
      AiModelAccessConflict,
    );
  });
});
