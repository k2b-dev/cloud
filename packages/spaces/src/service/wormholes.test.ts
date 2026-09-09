import { describe, expect, test } from "bun:test";
import type { PermissionLevel } from "@k2b/cloud/server";
import { toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { newShortId } from "../lib/short-id";
import { actorForUser, create, transfer, type WormholeActor } from "./wormholes";

type Fixture = {
  sourceSpaceId: string;
  targetSpaceId: string;
  sourceColumnId: string;
  targetColumnId: string;
  actorUserId: string;
  keptUserId: string;
  removedUserId: string;
  accessIds: string[];
};

const canUseDatabase = async () => {
  try {
    const [row] = await sql<{ wormholes: string | null; users: string | null }[]>`
      SELECT to_regclass('spaces.wormholes')::text AS wormholes, to_regclass('auth.users')::text AS users
    `;
    return Boolean(row?.wormholes && row.users);
  } catch {
    return false;
  }
};

/** Reported as skipped rather than silently passing when the backing service is absent. */
const suite = (await canUseDatabase()) ? describe : describe.skip;

const insertUser = async (suffix: string, label: string) => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail)
    VALUES (${`spaces-wormhole-${label}-${suffix}`}, 'local', 'user', ${`Wormhole ${label}`}, ${`${label}.${suffix}@example.test`})
    RETURNING id
  `;
  return row!.id;
};

const grant = async (spaceId: string, userId: string, permission: PermissionLevel) => {
  const [access] = await sql<{ id: string }[]>`
    INSERT INTO auth.access (user_id, permission) VALUES (${userId}::uuid, ${permission}) RETURNING id
  `;
  await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${spaceId}::uuid, ${access!.id}::uuid)`;
  return access!.id;
};

const createFixture = async (targetPermission: PermissionLevel = "admin"): Promise<Fixture> => {
  const suffix = crypto.randomUUID();
  const actorUserId = await insertUser(suffix, "actor");
  const keptUserId = await insertUser(suffix, "kept");
  const removedUserId = await insertUser(suffix, "removed");
  const [source] = await sql<{ id: string }[]>`
    INSERT INTO spaces.spaces (short_id, name, color) VALUES (${newShortId()}, ${`Source ${suffix}`}, '#3b82f6') RETURNING id
  `;
  const [target] = await sql<{ id: string }[]>`
    INSERT INTO spaces.spaces (short_id, name, color) VALUES (${newShortId()}, ${`Target ${suffix}`}, '#10b981') RETURNING id
  `;
  const [sourceColumn] = await sql<{ id: string }[]>`
    INSERT INTO spaces.columns (short_id, space_id, name, rank) VALUES (${newShortId()}, ${source!.id}::uuid, 'To do', 1024) RETURNING id
  `;
  const [targetColumn] = await sql<{ id: string }[]>`
    INSERT INTO spaces.columns (short_id, space_id, name, rank, is_done) VALUES (${newShortId()}, ${target!.id}::uuid, 'Done', 1024, true) RETURNING id
  `;
  const accessIds = [
    await grant(source!.id, actorUserId, "admin"),
    await grant(target!.id, actorUserId, targetPermission),
    await grant(target!.id, keptUserId, "read"),
  ];
  return {
    sourceSpaceId: source!.id,
    targetSpaceId: target!.id,
    sourceColumnId: sourceColumn!.id,
    targetColumnId: targetColumn!.id,
    actorUserId,
    keptUserId,
    removedUserId,
    accessIds,
  };
};

const cleanup = async (fixture: Fixture) => {
  await sql`DELETE FROM spaces.spaces WHERE id IN (${fixture.sourceSpaceId}::uuid, ${fixture.targetSpaceId}::uuid)`;
  await sql`DELETE FROM auth.access WHERE id = ANY(${toPgUuidArray(fixture.accessIds)}::uuid[])`;
  await sql`
    DELETE FROM auth.users
    WHERE id IN (${fixture.actorUserId}::uuid, ${fixture.keptUserId}::uuid, ${fixture.removedUserId}::uuid)
  `;
};

const actorFor = (fixture: Fixture): WormholeActor => ({
  subject: { type: "user", userId: fixture.actorUserId },
  resourceBoundSpaceId: null,
});

suite("Spaces wormholes", () => {
  test("builds a user actor without account-level access shortcuts", () => {
    expect(actorForUser({ id: crypto.randomUUID() })).toMatchObject({
      subject: { type: "user" },
      resourceBoundSpaceId: null,
    });
  });

  test("does not grant implicit destination access", async () => {
    const fixture = await createFixture("none");
    const actor = actorForUser({ id: fixture.actorUserId });
    try {
      const created = await create({
        sourceSpaceId: fixture.sourceSpaceId,
        data: { targetColumnId: fixture.targetColumnId, color: "#6366f1" },
        actor,
      });
      expect(created.ok).toBe(false);
      if (!created.ok) expect(created.status).toBe(403);
    } finally {
      await cleanup(fixture);
    }
  });

  test("rejects a wormhole back into its source Space", async () => {
    const fixture = await createFixture();
    try {
      const created = await create({
        sourceSpaceId: fixture.sourceSpaceId,
        data: { targetColumnId: fixture.sourceColumnId, color: "#6366f1" },
        actor: actorFor(fixture),
      });
      expect(created.ok).toBe(false);
      if (!created.ok) {
        expect(created.status).toBe(400);
        expect(created.error).toBe("A wormhole must lead to another space");
      }
    } finally {
      await cleanup(fixture);
    }
  });

  test("atomically transfers one item and cleans source-scoped relations", async () => {
    const fixture = await createFixture();
    try {
      const [item] = await sql<{ id: string }[]>`
        INSERT INTO spaces.items (short_id, space_id, column_id, title, description, rank)
        VALUES (${newShortId()}, ${fixture.sourceSpaceId}::uuid, ${fixture.sourceColumnId}::uuid, 'Transfer me', 'Keep this', 1024)
        RETURNING id
      `;
      const [tag] = await sql<{ id: string }[]>`
        INSERT INTO spaces.tags (short_id, space_id, name, color)
        VALUES (${newShortId()}, ${fixture.sourceSpaceId}::uuid, 'Source only', '#ef4444') RETURNING id
      `;
      await sql`INSERT INTO spaces.item_tags (item_id, tag_id) VALUES (${item!.id}::uuid, ${tag!.id}::uuid)`;
      await sql`
        INSERT INTO spaces.item_assignees (item_id, user_id)
        VALUES (${item!.id}::uuid, ${fixture.keptUserId}::uuid), (${item!.id}::uuid, ${fixture.removedUserId}::uuid)
      `;
      await sql`INSERT INTO spaces.comments (short_id, item_id, user_id, content) VALUES (${newShortId()}, ${item!.id}::uuid, ${fixture.actorUserId}::uuid, 'Keep me')`;
      const [blocker] = await sql<{ id: string }[]>`
        INSERT INTO spaces.items (short_id, space_id, column_id, title, rank)
        VALUES (${newShortId()}, ${fixture.sourceSpaceId}::uuid, ${fixture.sourceColumnId}::uuid, 'Source blocker', 512)
        RETURNING id
      `;
      await sql`
        INSERT INTO spaces.item_dependencies (item_id, blocker_item_id)
        VALUES (${item!.id}::uuid, ${blocker!.id}::uuid)
      `;

      const created = await create({
        sourceSpaceId: fixture.sourceSpaceId,
        data: { targetColumnId: fixture.targetColumnId, color: "#6366f1" },
        actor: actorFor(fixture),
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error);

      const result = await transfer({
        sourceSpaceId: fixture.sourceSpaceId,
        itemId: item!.id,
        wormholeId: created.data.id,
        actor: actorFor(fixture),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(result.data.item.id).toBe(item!.id);
      expect(result.data.item.spaceId).toBe(fixture.targetSpaceId);
      expect(result.data.item.columnId).toBe(fixture.targetColumnId);
      expect(result.data.item.completedAt).not.toBeNull();
      expect(result.data.item.tags).toEqual([]);
      expect(result.data.item.assignees?.map((assignee) => assignee.id)).toEqual([fixture.keptUserId]);
      expect(result.data.removedTagCount).toBe(1);
      expect(result.data.removedAssigneeCount).toBe(1);
      expect(result.data.removedDependencyCount).toBe(1);

      const [dependencyCount] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM spaces.item_dependencies
        WHERE item_id = ${item!.id}::uuid OR blocker_item_id = ${item!.id}::uuid
      `;
      expect(dependencyCount?.count).toBe(0);

      const [commentCount] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM spaces.comments WHERE item_id = ${item!.id}::uuid
      `;
      expect(commentCount?.count).toBe(1);

      const [authenticatedAccess] = await sql<{ id: string }[]>`
        INSERT INTO auth.access (authenticated_only, permission) VALUES (true, 'read') RETURNING id
      `;
      await sql`
        INSERT INTO spaces.space_access (space_id, access_id)
        VALUES (${fixture.targetSpaceId}::uuid, ${authenticatedAccess!.id}::uuid)
      `;
      fixture.accessIds.push(authenticatedAccess!.id);
      const [broadAccessItem] = await sql<{ id: string }[]>`
        INSERT INTO spaces.items (short_id, space_id, column_id, title, rank)
        VALUES (${newShortId()}, ${fixture.sourceSpaceId}::uuid, ${fixture.sourceColumnId}::uuid, 'Keep authenticated assignee', 2048)
        RETURNING id
      `;
      await sql`
        INSERT INTO spaces.item_assignees (item_id, user_id)
        VALUES (${broadAccessItem!.id}::uuid, ${fixture.removedUserId}::uuid)
      `;
      const broadAccessResult = await transfer({
        sourceSpaceId: fixture.sourceSpaceId,
        itemId: broadAccessItem!.id,
        wormholeId: created.data.id,
        actor: actorFor(fixture),
      });
      expect(broadAccessResult.ok).toBe(true);
      if (!broadAccessResult.ok) throw new Error(broadAccessResult.error);
      expect(broadAccessResult.data.item.assignees?.map((assignee) => assignee.id)).toEqual([fixture.removedUserId]);
      expect(broadAccessResult.data.removedAssigneeCount).toBe(0);
    } finally {
      await cleanup(fixture);
    }
  });

  test("requires target admin permission for configuration and rejects resource-bound crossings", async () => {
    const fixture = await createFixture("write");
    try {
      const denied = await create({
        sourceSpaceId: fixture.sourceSpaceId,
        data: { targetColumnId: fixture.targetColumnId, color: "#6366f1" },
        actor: actorFor(fixture),
      });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.status).toBe(403);

      const resourceBound = await create({
        sourceSpaceId: fixture.sourceSpaceId,
        data: { targetColumnId: fixture.targetColumnId, color: "#6366f1" },
        actor: { ...actorFor(fixture), resourceBoundSpaceId: fixture.sourceSpaceId },
      });
      expect(resourceBound.ok).toBe(false);
      if (!resourceBound.ok) expect(resourceBound.status).toBe(403);
    } finally {
      await cleanup(fixture);
    }
  });

  test("rejects recurring items without modifying them", async () => {
    const fixture = await createFixture();
    try {
      const [item] = await sql<{ id: string }[]>`
        INSERT INTO spaces.items (short_id, space_id, column_id, title, rank, recurrence_rrule, recurrence_dtstart)
        VALUES (${newShortId()}, ${fixture.sourceSpaceId}::uuid, ${fixture.sourceColumnId}::uuid, 'Recurring', 1024, 'FREQ=DAILY', now())
        RETURNING id
      `;
      const created = await create({
        sourceSpaceId: fixture.sourceSpaceId,
        data: { targetColumnId: fixture.targetColumnId, color: "#6366f1" },
        actor: actorFor(fixture),
      });
      if (!created.ok) throw new Error(created.error);
      const result = await transfer({
        sourceSpaceId: fixture.sourceSpaceId,
        itemId: item!.id,
        wormholeId: created.data.id,
        actor: actorFor(fixture),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(400);
      const [unchanged] = await sql<{ space_id: string; column_id: string }[]>`
        SELECT space_id, column_id FROM spaces.items WHERE id = ${item!.id}::uuid
      `;
      expect(unchanged).toEqual({ space_id: fixture.sourceSpaceId, column_id: fixture.sourceColumnId });
    } finally {
      await cleanup(fixture);
    }
  });
});
