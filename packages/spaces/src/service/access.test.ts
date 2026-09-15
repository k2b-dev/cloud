import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { newShortId } from "../lib/short-id";
import { grantSpaceAccess, resolveSpaceApiKeyPermission, revokeSpaceAccess, updateSpaceAccessPermission } from "./access";
import { checkOverlap, listCalendar, searchAcross } from "./items";
import { list as listSpaces, listPage as listSpacesPage } from "./spaces";

const databaseTest = process.env.CLOUD_DATABASE_TEST === "1" ? test : test.skip;

const resourceSubject = {
  type: "service_account" as const,
  serviceAccountId: "11111111-1111-4111-8111-111111111111",
};

describe("resolveSpaceApiKeyPermission", () => {
  test("caps credential scopes by the resource access permission", () => {
    expect(resolveSpaceApiKeyPermission("admin", ["read"])).toBe("read");
    expect(resolveSpaceApiKeyPermission("admin", ["write"])).toBe("write");
    expect(resolveSpaceApiKeyPermission("write", ["admin"])).toBe("write");
    expect(resolveSpaceApiKeyPermission("read", ["admin"])).toBe("read");
  });

  test("uses the strongest credential scope and denies credentials without usable scopes", () => {
    expect(resolveSpaceApiKeyPermission("admin", ["read", "write"])).toBe("write");
    expect(resolveSpaceApiKeyPermission("admin", [])).toBe("none");
    expect(resolveSpaceApiKeyPermission("none", ["admin"])).toBe("none");
  });
});

test("resource service-account collections fail closed without a valid space binding", async () => {
  expect(await listSpaces({ subject: resourceSubject })).toEqual([]);
  expect(await searchAcross({ subject: resourceSubject, query: "test", kinds: "all", limit: 10 })).toEqual([]);
  expect(await listCalendar({ subject: resourceSubject, from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z" })).toEqual([]);
  expect(await checkOverlap({ subject: resourceSubject, from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z" })).toEqual([]);
});

databaseTest("Space pages filter and paginate in SQL while enforcing resource bindings", async () => {
  const suffix = crypto.randomUUID();
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail)
    VALUES (${`spaces-page-${suffix}`}, 'local', 'user', 'Spaces Page User', ${`spaces-page.${suffix}@example.test`})
    RETURNING id
  `;
  const [serviceAccount] = await sql<{ id: string }[]>`
    INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
    VALUES (${`Spaces page service ${suffix}`}, 'resource_bound', 'spaces', 'space', ${suffix})
    RETURNING id
  `;
  const createdSpaces = await sql<{ id: string; name: string }[]>`
    INSERT INTO spaces.spaces (short_id, name, description)
    VALUES
      (${newShortId()}, ${`Capability Alpha ${suffix}`}, 'first match'),
      (${newShortId()}, ${`Capability Beta ${suffix}`}, 'second match')
    RETURNING id, name
  `;
  const accessEntries = await sql<{ id: string }[]>`
    INSERT INTO auth.access (user_id, service_account_id, permission)
    VALUES
      (${user!.id}::uuid, NULL, 'read'),
      (${user!.id}::uuid, NULL, 'write'),
      (NULL, ${serviceAccount!.id}::uuid, 'admin')
    RETURNING id
  `;
  await sql`
    INSERT INTO spaces.space_access (space_id, access_id)
    VALUES
      (${createdSpaces[0]!.id}::uuid, ${accessEntries[0]!.id}::uuid),
      (${createdSpaces[1]!.id}::uuid, ${accessEntries[1]!.id}::uuid),
      (${createdSpaces[0]!.id}::uuid, ${accessEntries[2]!.id}::uuid),
      (${createdSpaces[1]!.id}::uuid, ${accessEntries[2]!.id}::uuid)
  `;

  try {
    const first = await listSpacesPage({
      subject: { type: "user", userId: user!.id },
      query: suffix,
      pagination: { page: 1, perPage: 1 },
    });
    const second = await listSpacesPage({
      subject: { type: "user", userId: user!.id },
      query: suffix,
      pagination: { page: 2, perPage: 1 },
    });
    expect(first).toMatchObject({ total: 2, hasNext: true, items: [{ name: `Capability Alpha ${suffix}`, permission: "read" }] });
    expect(second).toMatchObject({ total: 2, hasNext: false, items: [{ name: `Capability Beta ${suffix}`, permission: "write" }] });

    const writable = await listSpacesPage({
      subject: { type: "user", userId: user!.id },
      requiredLevel: "write",
      query: suffix,
      pagination: { page: 1, perPage: 10 },
    });
    expect(writable.items.map((entry) => entry.id)).toEqual([createdSpaces[1]!.id]);

    const bound = await listSpacesPage({
      subject: { type: "service_account", serviceAccountId: serviceAccount!.id },
      boundSpaceId: createdSpaces[0]!.id,
      pagination: { page: 1, perPage: 10 },
    });
    expect(bound.items.map((entry) => entry.id)).toEqual([createdSpaces[0]!.id]);
  } finally {
    await sql`DELETE FROM spaces.spaces WHERE id IN (${createdSpaces[0]!.id}::uuid, ${createdSpaces[1]!.id}::uuid)`;
    await sql`DELETE FROM auth.access WHERE id IN (${accessEntries[0]!.id}::uuid, ${accessEntries[1]!.id}::uuid, ${accessEntries[2]!.id}::uuid)`;
    await sql`DELETE FROM auth.service_accounts WHERE id = ${serviceAccount!.id}::uuid`;
    await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
  }
});

databaseTest("Space access mutations preserve an administrator and can recover an orphaned Space", async () => {
  const suffix = crypto.randomUUID();
  const users = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail)
    VALUES
      (${`spaces-access-first-${suffix}`}, 'local', 'user', 'First Space Admin', ${`first.${suffix}@example.test`}),
      (${`spaces-access-second-${suffix}`}, 'local', 'user', 'Second Space Admin', ${`second.${suffix}@example.test`})
    RETURNING id
  `;
  const [space] = await sql<{ id: string }[]>`
    INSERT INTO spaces.spaces (short_id, name) VALUES (${newShortId()}, ${`Access Guard ${suffix}`}) RETURNING id
  `;
  const [orphaned] = await sql<{ id: string }[]>`
    INSERT INTO spaces.spaces (short_id, name) VALUES (${newShortId()}, ${`Orphaned ${suffix}`}) RETURNING id
  `;
  const accessEntries = await sql<{ id: string }[]>`
    INSERT INTO auth.access (user_id, permission)
    VALUES (${users[0]!.id}::uuid, 'admin'), (${users[1]!.id}::uuid, 'admin')
    RETURNING id
  `;
  await sql`
    INSERT INTO spaces.space_access (space_id, access_id)
    VALUES (${space!.id}::uuid, ${accessEntries[0]!.id}::uuid), (${space!.id}::uuid, ${accessEntries[1]!.id}::uuid)
  `;

  try {
    const demoted = await updateSpaceAccessPermission({
      spaceId: space!.id,
      accessId: accessEntries[0]!.id,
      permission: "write",
    });
    expect(demoted.ok).toBe(true);

    const lastAdmin = await updateSpaceAccessPermission({
      spaceId: space!.id,
      accessId: accessEntries[1]!.id,
      permission: "write",
    });
    expect(lastAdmin.ok).toBe(false);
    if (!lastAdmin.ok) expect(lastAdmin.error.message).toBe("Cannot remove the last admin");

    expect(await revokeSpaceAccess({ spaceId: space!.id, accessId: accessEntries[0]!.id })).toEqual({ ok: true, data: undefined });
    const lastEntry = await revokeSpaceAccess({ spaceId: space!.id, accessId: accessEntries[1]!.id });
    expect(lastEntry.ok).toBe(false);
    if (!lastEntry.ok) expect(lastEntry.error.message).toBe("Cannot remove the last access entry");

    const recovered = await grantSpaceAccess({
      spaceId: orphaned!.id,
      principal: { type: "user", userId: users[0]!.id },
      permission: "admin",
    });
    expect(recovered.ok).toBe(true);
  } finally {
    await sql`DELETE FROM spaces.spaces WHERE id IN (${space!.id}::uuid, ${orphaned!.id}::uuid)`;
    await sql`DELETE FROM auth.access WHERE id IN (${accessEntries[0]!.id}::uuid, ${accessEntries[1]!.id}::uuid)`;
    await sql`DELETE FROM auth.users WHERE id IN (${users[0]!.id}::uuid, ${users[1]!.id}::uuid)`;
  }
});
