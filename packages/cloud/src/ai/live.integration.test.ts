import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite, testInfra, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { aiFileStore } from "./files-store";
import { AiInvalidationSchema } from "./live-events";
import { migrateCloudAi } from "./migrate";
import { aiProjects } from "./projects";
import { aiConversations } from "./store";

const suite = databaseSuite();
let database: Awaited<ReturnType<typeof useFreshDatabase>> | undefined;

// The file owns a private database: it migrates from an empty one, and its row counts cover every user.
beforeAll(async () => {
  if (!testInfra.database) return;
  database = await useFreshDatabase("ai_live");
});

afterAll(async () => {
  if (!database) return;
  await sql.close();
  await database.drop();
});

const insertUser = async (label: string): Promise<string> => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
    VALUES (${`ai-live-${label}-${suffix}`}, 'local', 'user', ${`AI Live ${label}`}, ${`ai-live-${suffix}@example.test`}, 'AI', 'Live')
    RETURNING id
  `;
  return row!.id;
};

const insertServiceAccount = async (label: string): Promise<string> => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
    VALUES (${`AI Live ${label} ${suffix}`}, 'resource_bound', 'ai-live-test', 'project-test', ${suffix})
    RETURNING id
  `;
  return row!.id;
};

/** The AI live updates pending for one user, as the Assistant receives their data. */
const updatesFor = async (userId: string) => {
  const rows = await sql<{ ordering_key: string; payload: { v: number; k: string; d: unknown } }[]>`
    SELECT ordering_key, payload FROM events.outbox
    WHERE kind = 'live' AND app_id = 'core' AND ordering_key = ${`u:${userId}`}
    ORDER BY seq
  `;
  return rows.map((row) => {
    expect(row.payload).toMatchObject({ v: 1, k: row.ordering_key });
    return AiInvalidationSchema.parse(row.payload.d);
  });
};

/** Users with a pending update about the Project. */
const recipientsOf = async (projectShortId: string): Promise<string[]> => {
  const rows = await sql<{ ordering_key: string }[]>`
    SELECT DISTINCT ordering_key FROM events.outbox
    WHERE kind = 'live' AND app_id = 'core' AND payload->'d'->>'projectId' = ${projectShortId}
  `;
  return rows.map((row) => row.ordering_key.slice(2)).sort();
};

const clearUpdates = () => sql`DELETE FROM events.outbox WHERE kind = 'live' AND app_id = 'core'`;

/** The function body of releases before AI moved to the platform outbox, as an older Core installs it. */
const installPreviousFunction = () => sql`
  CREATE OR REPLACE FUNCTION ai.enqueue_live_for_user(
    p_change_id UUID, p_user_id UUID, p_conversation_short_id TEXT, p_project_short_id TEXT, p_domains TEXT[]
  ) RETURNS void AS $$
  BEGIN
    IF p_user_id IS NULL OR cardinality(p_domains) = 0 THEN RETURN; END IF;
    INSERT INTO ai.live_invalidation_outbox (change_id, audience_user_id, conversation_short_id, project_short_id, domains)
    VALUES (p_change_id, p_user_id, p_conversation_short_id, p_project_short_id,
      ARRAY(SELECT DISTINCT domain FROM unnest(p_domains) domain ORDER BY domain));
  END
  $$ LANGUAGE plpgsql
`;

suite("AI live updates in the platform outbox", () => {
  test("the AI migration refuses to run before Core's events migration, and Core's setup runs them in that order", async () => {
    await expect(migrateCloudAi()).rejects.toThrow(/Run Core's events migration before the AI migration/);
    const [schema] = await sql<{ exists: boolean }[]>`SELECT to_regnamespace('ai') IS NOT NULL AS exists`;
    expect(schema?.exists).toBe(false);

    const { runCoreSetup } = await import("../../../core/src/runtime-helpers");
    await runCoreSetup();
    const ownerId = await insertUser("first");
    await aiConversations.createConversation({ ownerUserId: ownerId });
    expect(await updatesFor(ownerId)).toHaveLength(1);
  });

  test("keeps only the global live-enqueue function signature", async () => {
    const rows = await sql<{ arguments: string }[]>`
      SELECT pg_get_function_identity_arguments(procedure.oid) AS arguments
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'ai' AND procedure.proname = 'enqueue_live_for_user'
    `;
    expect(rows.map((row) => row.arguments)).toEqual([
      "p_change_id uuid, p_user_id uuid, p_conversation_short_id text, p_project_short_id text, p_domains text[]",
    ]);
  });

  test("a conversation change reaches only its owner, in the transaction of the change", async () => {
    const ownerId = await insertUser("owner");
    const otherId = await insertUser("other");
    await clearUpdates();
    const conversation = await aiConversations.createConversation({ ownerUserId: ownerId });
    const [created] = await updatesFor(ownerId);
    expect(created).toMatchObject({ type: "ai.invalidated", conversationId: conversation.shortId, projectId: null });
    expect(created?.domains).toEqual(["conversation-detail", "conversation-list"]);
    expect(await updatesFor(otherId)).toEqual([]);

    await aiFileStore.write({
      conversationId: conversation.id,
      path: "/photo.png",
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: "image/png",
      origin: "user",
    });
    expect((await updatesFor(ownerId)).flatMap((update) => update.domains)).toContain("conversation-files");

    const before = (await updatesFor(ownerId)).length;
    await expect(
      sql.begin(async (tx) => {
        await tx`UPDATE ai.conversations SET title = 'rolled back' WHERE id = ${conversation.id}::uuid`;
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await updatesFor(ownerId)).toHaveLength(before);
    expect((await aiConversations.getConversation({ conversationId: conversation.id }))?.title).toBe("New chat");
  });

  test("a Project change reaches its readers before and after a grant changes, and a Project chat only its owner", async () => {
    const ownerId = await insertUser("project-owner");
    const memberId = await insertUser("project-member");
    const strangerId = await insertUser("project-stranger");
    const owner = { type: "user" as const, userId: ownerId };
    const project = await aiProjects.create({ subject: owner, name: "Realtime Project" });
    await clearUpdates();

    const grant = await aiProjects.grantAccess(project.id, owner, { principal: { type: "user", userId: memberId }, permission: "read" });
    expect(await recipientsOf(project.shortId)).toEqual([memberId, ownerId].sort());

    await clearUpdates();
    await aiProjects.updateAccess(project.id, grant!.id, owner, "write");
    expect(await recipientsOf(project.shortId)).toEqual([memberId, ownerId].sort());

    // The member who loses access still learns that the Project left their list.
    await clearUpdates();
    await aiProjects.revokeAccess(project.id, grant!.id, owner);
    expect(await recipientsOf(project.shortId)).toEqual([memberId, ownerId].sort());
    expect((await updatesFor(memberId)).flatMap((update) => update.domains)).toContain("project-list");

    await clearUpdates();
    await aiProjects.update(project.id, owner, { name: "Renamed Project" });
    expect(await recipientsOf(project.shortId)).toEqual([ownerId]);

    await clearUpdates();
    const chat = await aiConversations.createConversation({ ownerUserId: ownerId, projectId: project.id });
    expect((await updatesFor(ownerId)).map((update) => update.conversationId)).toContain(chat.shortId);
    expect(await updatesFor(memberId)).toEqual([]);
    expect(await updatesFor(strangerId)).toEqual([]);
  });

  test("nested groups and authenticated-only grants reach every member; a Project without users reaches nobody", async () => {
    const ownerId = await insertUser("group-owner");
    const memberId = await insertUser("nested-member");
    const anyoneId = await insertUser("any-user");
    const serviceAccountId = await insertServiceAccount("only");
    const owner = { type: "user" as const, userId: ownerId };
    const suffix = crypto.randomUUID();
    const [parent, child] = await sql<{ id: string }[]>`
      INSERT INTO auth.groups (cn, provider, name, description)
      VALUES (${`ai-live-parent-${suffix}`}, 'local', 'Live parent', 'Live parent'),
             (${`ai-live-child-${suffix}`}, 'local', 'Live child', 'Live child')
      RETURNING id
    `;
    const project = await aiProjects.create({ subject: owner, name: "Group Project" });
    await aiProjects.grantAccess(project.id, owner, { principal: { type: "group", groupId: parent!.id }, permission: "read" });
    await sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${parent!.id}::uuid, ${child!.id}::uuid)`;

    // Joining and leaving a nested group changes the member's Project list at once.
    await clearUpdates();
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${memberId}::uuid, ${child!.id}::uuid)`;
    expect(await recipientsOf(project.shortId)).toContain(memberId);
    await clearUpdates();
    await aiProjects.update(project.id, owner, { name: "Group Project, renamed" });
    expect(await recipientsOf(project.shortId)).toEqual([memberId, ownerId].sort());
    await clearUpdates();
    await sql`DELETE FROM auth.user_groups_v2 WHERE user_id = ${memberId}::uuid AND group_id = ${child!.id}::uuid`;
    expect(await recipientsOf(project.shortId)).toContain(memberId);

    // A grant to every signed-in person reaches every user of the installation.
    await clearUpdates();
    const everyone = await aiProjects.grantAccess(project.id, owner, { principal: { type: "authenticated" }, permission: "read" });
    const [users] = await sql<{ ids: string[] }[]>`SELECT array_agg(id::text ORDER BY id::text) AS ids FROM auth.users`;
    expect(await recipientsOf(project.shortId)).toEqual(users!.ids.sort());
    expect(await recipientsOf(project.shortId)).toContain(anyoneId);
    await aiProjects.revokeAccess(project.id, everyone!.id, owner);

    await clearUpdates();
    const service = { type: "service_account" as const, serviceAccountId };
    const serviceProject = await aiProjects.create({ subject: service, name: "Service Project" });
    expect(await recipientsOf(serviceProject.shortId)).toEqual([]);
  });

  test("deleting a user who reads a Project neither fails nor stops updates for the other readers", async () => {
    const ownerId = await insertUser("delete-owner");
    const leavingId = await insertUser("delete-member");
    const owner = { type: "user" as const, userId: ownerId };
    const project = await aiProjects.create({ subject: owner, name: "Shared before deletion" });
    await aiProjects.grantAccess(project.id, owner, { principal: { type: "user", userId: leavingId }, permission: "read" });
    await aiConversations.createConversation({ ownerUserId: leavingId, projectId: project.id });

    await clearUpdates();
    await sql`DELETE FROM auth.users WHERE id = ${leavingId}::uuid`;
    expect(await recipientsOf(project.shortId)).toContain(ownerId);
  });

  test("an older Core that starts again writes to the previous table until the next current Core migrates", async () => {
    await installPreviousFunction();

    // Meanwhile updates go to the previous table, which no current Core publishes.
    const ownerId = await insertUser("rollback");
    await clearUpdates();
    await aiConversations.createConversation({ ownerUserId: ownerId });
    expect(await updatesFor(ownerId)).toEqual([]);
    const [previous] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM ai.live_invalidation_outbox WHERE audience_user_id = ${ownerId}::uuid
    `;
    expect(previous?.count).toBe(1);

    await migrateCloudAi();
    await aiConversations.createConversation({ ownerUserId: ownerId });
    expect(await updatesFor(ownerId)).toHaveLength(1);
  });
});
