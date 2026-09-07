import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { sql } from "bun";
import type { Principal } from "../contracts/shared";
import { decryptValue, encryptValue } from "../services/settings/crypto";
import { AiModelAccessConflict, aiModelAccess, splitAiModelAccess } from "./model-access";
import { migrateAiModelAccess } from "./model-access-migrate";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgres://localhost/unconfigured");
// This suite owns a fresh model-access namespace, never a shared development database.
const isolated =
  ["localhost", "127.0.0.1"].includes(databaseUrl.hostname) && /^\/cloud_ai_model_access_verify_[a-z0-9_]+$/.test(databaseUrl.pathname);
const suite = isolated ? describe : describe.skip;
const profiles = ["open", "limited"].map((id) => ({ id, label: id, provider: "ollama", model: id }));
const draft = <T extends Principal>(principal: T) => ({ principal, permission: "read" as const });

suite("Assistant model grants using normal Cloud access", () => {
  let userId: string;
  let outsiderId: string;
  let groupId: string;
  let serviceAccountId: string;
  const subject = () => ({ type: "user" as const, userId });
  const sync = (ids: string[], changes: Parameters<typeof aiModelAccess.syncProfiles>[1] = []) =>
    sql.begin((tx) => aiModelAccess.syncProfiles(ids, changes, tx));

  beforeAll(async () => {
    const [existing] = await sql<{ resource: string | null }[]>`SELECT to_regclass('ai.model_access_resources')::text AS resource`;
    if (existing?.resource) throw new Error("Model-access fixture requires a fresh dedicated database.");
    await sql`CREATE SCHEMA IF NOT EXISTS ai`;
    const value = await encryptValue(JSON.stringify(profiles));
    await sql`INSERT INTO settings.entries (key, value) VALUES ('ai.model_profiles_json', ${value})`;
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
    await sql`CREATE TABLE ai.model_credentials (
      profile_id TEXT PRIMARY KEY, secret TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  });

  test("migration seeds real authenticated grants and is idempotent", async () => {
    const initial = await aiModelAccess.listForAdmin();
    expect(initial.open?.entries.map((entry) => entry.principal)).toEqual([{ type: "authenticated" }]);
    await migrateAiModelAccess();
    expect(await aiModelAccess.listForAdmin()).toEqual(initial);
    const candidates = [{ id: "limited" }, { id: "missing" }, { id: "open" }];
    expect(await aiModelAccess.filterModels(candidates, subject())).toEqual([{ id: "limited" }, { id: "open" }]);
    expect(await aiModelAccess.filterModels(candidates, null)).toEqual([]);
  });

  test("nested groups and service accounts use canonical resolver; explicit denial fails closed", async () => {
    const state = await aiModelAccess.listForAdmin();
    await sync(
      ["open", "limited"],
      [
        {
          profileId: "limited",
          expectedRevision: state.limited!.revision,
          entries: [draft({ type: "group", groupId }), draft({ type: "service_account", serviceAccountId })],
        },
      ],
    );
    await expect(aiModelAccess.assertAllowed("limited", subject())).resolves.toBeUndefined();
    await expect(aiModelAccess.assertAllowed("limited", { type: "service_account", serviceAccountId })).resolves.toBeUndefined();
    await expect(aiModelAccess.assertAllowed("limited", { type: "user", userId: outsiderId })).rejects.toMatchObject({
      aiError: { code: "model_access_denied" },
    });
    await expect(aiModelAccess.assertAllowed("missing", subject())).rejects.toThrow();
  });

  test("empty permissions stay denied across migration and stale drafts conflict", async () => {
    const state = await aiModelAccess.listForAdmin();
    const change = { profileId: "limited", expectedRevision: state.limited!.revision, entries: [] };
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
        await aiModelAccess.syncProfiles(
          ["open", "limited"],
          [{ profileId: "open", expectedRevision: before.open!.revision, entries: [draft({ type: "user", userId: crypto.randomUUID() })] }],
          tx,
        );
      }),
    ).rejects.toThrow();
    expect(await aiModelAccess.listForAdmin()).toEqual(before);
    expect(await sql`SELECT key FROM settings.entries WHERE key = 'model_access_rollback_probe'`).toHaveLength(0);
  });

  test("duplicate and rename preserve independent grants, deletion cleans grant rows", async () => {
    let state = await aiModelAccess.listForAdmin();
    await sync(
      ["open", "limited", "copy"],
      [
        {
          profileId: "copy",
          sourceProfileId: "open",
          expectedRevision: state.open!.revision,
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
          profileId: "renamed",
          sourceProfileId: "open",
          expectedRevision: state.open!.revision,
          entries: [draft({ type: "user", userId }), draft({ type: "user", userId })],
        },
      ],
    );
    state = await aiModelAccess.listForAdmin();
    expect(state.open).toBeUndefined();
    expect(state.renamed!.entries).toHaveLength(1);
    expect(await aiModelAccess.filterModels([{ id: "renamed" }], subject())).toHaveLength(1);
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
    await expect(sync(["recreated"], [{ profileId: "recreated", expectedRevision: old, entries: [] }])).rejects.toBeInstanceOf(
      AiModelAccessConflict,
    );
  });

  test("admin settings PUT keeps keyless model grants and rolls back settings and credentials", async () => {
    const { auth } = await import("../server");
    // Exercise the actual settings transaction; authentication is a separate tested middleware.
    const role = spyOn(auth, "requireRole").mockImplementation(() => async (_c, next) => next());
    let app: typeof import("../api/admin-core-settings")["default"];
    try {
      app = (await import("../api/admin-core-settings")).default;
    } finally {
      role.mockRestore();
    }
    const put = (submitted: unknown[]) =>
      app.request("/", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates: { "ai.enabled": false, "ai.model_profiles_json": JSON.stringify(submitted) } }),
      });
    const local = { id: "local", label: "Local", provider: "ollama", model: "local" };
    const remote = { id: "remote", label: "Remote", provider: "openai", model: "remote" };
    const saved = await put([
      { ...local, assistantAccess: { expectedRevision: null, entries: [] } },
      { ...remote, apiKey: "fixture-secret", assistantAccess: { expectedRevision: null, entries: [draft({ type: "authenticated" })] } },
    ]);
    expect(saved.status).toBe(204);
    const state = await aiModelAccess.listForAdmin();
    expect(state.local?.entries).toEqual([]);
    expect(state.remote?.entries).toHaveLength(1);
    const readProfiles = async () => {
      const [row] = await sql<{ value: string }[]>`SELECT value FROM settings.entries WHERE key = 'ai.model_profiles_json'`;
      return JSON.parse(String(await decryptValue(row!.value)));
    };
    expect(await readProfiles()).toEqual([local, remote]);
    const { getAiCredential } = await import("./credentials");
    expect(await getAiCredential("remote")).toBe("fixture-secret");
    const invalid = await put([
      local,
      {
        ...remote,
        label: "Do not persist",
        apiKey: "replacement",
        assistantAccess: { expectedRevision: state.remote!.revision, entries: [draft({ type: "user", userId: crypto.randomUUID() })] },
      },
    ]);
    expect(invalid.status).toBe(400);
    expect(await readProfiles()).toEqual([local, remote]);
    expect(await getAiCredential("remote")).toBe("fixture-secret");
    expect(await aiModelAccess.listForAdmin()).toEqual(state);
    const update = [local, { ...remote, assistantAccess: { expectedRevision: state.remote!.revision, entries: [] } }];
    expect((await put(update)).status).toBe(204);
    expect((await put(update)).status).toBe(409);
    expect((await aiModelAccess.listForAdmin()).remote?.entries).toEqual([]);
    const reset = await app.request("/ai.model_profiles_json", { method: "DELETE" });
    expect(reset.status).toBe(204);
    expect(await aiModelAccess.listForAdmin()).toEqual({});
    expect(await getAiCredential("remote")).toBeNull();
  });
});

describe("model permission draft transport", () => {
  test("removes drafts from persisted provider JSON", () => {
    const input = { ...profiles[0], assistantAccess: { expectedRevision: null, entries: [draft({ type: "authenticated" })] } };
    const result = splitAiModelAccess(JSON.stringify([input]));
    expect(JSON.parse(result.profilesJson)).toEqual([profiles[0]]);
    expect(result.changes).toEqual([{ profileId: "open", ...input.assistantAccess }]);
  });
  test("rejects public, elevated permissions and unrecognized metadata", () => {
    for (const entries of [
      [draft({ type: "public" })],
      [{ principal: { type: "authenticated" }, permission: "admin" }],
      [{ ...draft({ type: "authenticated" }), displayName: "spoof" }],
    ]) {
      expect(() =>
        splitAiModelAccess(JSON.stringify([{ ...profiles[0], assistantAccess: { expectedRevision: null, entries } }])),
      ).toThrow();
    }
  });
});
