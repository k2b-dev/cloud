import { describe, expect, mock, test } from "bun:test";
import type { User } from "@valentinkolb/cloud/contracts";
import type { ServiceAccount, ServiceAccountCredentialOverview } from "@valentinkolb/cloud/services";
import { sql } from "bun";
import { migrate } from "../migrate";
import type { GridsWorkflowPrincipal } from "../workflows/contracts";
import { authorizeWorkflowBase, revalidateWorkflowPrincipal, type WorkflowAuthorizationDeps } from "./workflow-authorization";

const BASE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const SERVICE_ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
const CREDENTIAL_ID = "44444444-4444-4444-8444-444444444444";
const postgresTest = process.env.GRIDS_DB_TEST === "1" ? test : test.skip;

const user = (overrides: Partial<User> = {}): User =>
  ({
    id: USER_ID,
    accountExpires: null,
    ...overrides,
  }) as User;

const serviceAccount = (overrides: Partial<ServiceAccount> = {}): ServiceAccount => ({
  id: SERVICE_ACCOUNT_ID,
  name: "Grids base credential",
  kind: "resource_bound",
  status: "active",
  delegatedUserId: null,
  appId: "grids",
  resourceType: "base",
  resourceId: BASE_ID,
  createdBy: null,
  createdAt: "2026-07-15T00:00:00.000Z",
  ...overrides,
});

const credential = (scopes: string[] = ["grids:write"]): ServiceAccountCredentialOverview =>
  ({
    id: CREDENTIAL_ID,
    serviceAccountId: SERVICE_ACCOUNT_ID,
    name: "Workflow key",
    kind: "api_token",
    status: "active",
    tokenPrefix: "prefix",
    scopes,
    expiresAt: "2026-07-16T00:00:00.000Z",
    lastUsedAt: null,
    createdBy: null,
    createdAt: "2026-07-15T00:00:00.000Z",
    revokedAt: null,
    revokedBy: null,
    serviceAccount: serviceAccount(),
    owner: { type: "resource", appId: "grids", resourceType: "base", resourceId: BASE_ID },
  }) as ServiceAccountCredentialOverview;

const principal = (): GridsWorkflowPrincipal => ({
  userId: null,
  groupIds: [],
  serviceAccountId: SERVICE_ACCOUNT_ID,
  actorServiceAccountId: SERVICE_ACCOUNT_ID,
  credential: {
    kind: "api_token",
    id: CREDENTIAL_ID,
    scopes: ["grids:write"],
    permissionCap: "write",
    expiresAt: "2026-07-16T00:00:00.000Z",
    resourceBinding: { appId: "grids", resourceType: "base", resourceId: BASE_ID },
  },
});

const deps = (overrides: Partial<WorkflowAuthorizationDeps> = {}): WorkflowAuthorizationDeps => ({
  findCredential: mock(async () => credential()),
  getServiceAccount: mock(async () => serviceAccount()),
  getUser: mock(async () => user()),
  now: () => new Date("2026-07-15T12:00:00.000Z"),
  ...overrides,
});

describe("workflow principal revalidation", () => {
  postgresTest("revalidates permission changes in the action transaction", async () => {
    await migrate();
    const baseId = Bun.randomUUIDv7();
    const userId = Bun.randomUUIDv7();
    const accessId = Bun.randomUUIDv7();
    const suffix = crypto.randomUUID().slice(0, 8);
    const actor: GridsWorkflowPrincipal = { userId, groupIds: [], serviceAccountId: null };

    try {
      await sql`
        INSERT INTO auth.users (id, uid, provider, profile, display_name)
        VALUES (${userId}::uuid, ${`workflow-auth-${suffix}`}, 'local', 'user', 'Workflow auth test')
      `;
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, 'WA0001', 'Workflow auth test')`;
      await sql`
        INSERT INTO auth.access (id, user_id, permission)
        VALUES (${accessId}::uuid, ${userId}::uuid, 'write'::auth.permission_level)
      `;
      await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${accessId}::uuid)`;

      await sql.begin(async (tx) => {
        expect(await authorizeWorkflowBase(actor, baseId, "write", tx)).toBe(true);
        await tx`UPDATE auth.access SET permission = 'none'::auth.permission_level WHERE id = ${accessId}::uuid`;
        expect(await authorizeWorkflowBase(actor, baseId, "write", tx)).toBe(false);
      });
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
      await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("uses a user id as the canonical subject without trusting stored groups", async () => {
    const result = await revalidateWorkflowPrincipal(
      { userId: USER_ID, groupIds: ["55555555-5555-4555-8555-555555555555"], serviceAccountId: null },
      BASE_ID,
      deps(),
    );

    expect(result).toEqual({
      ok: true,
      subject: { type: "user", userId: USER_ID },
      permissionCap: "admin",
      credential: null,
    });
  });

  test("fails closed when an API credential was revoked", async () => {
    const result = await revalidateWorkflowPrincipal(principal(), BASE_ID, deps({ findCredential: mock(async () => null) }));

    expect(result).toEqual({ ok: false, reason: "Workflow API credential is revoked or inactive." });
  });

  test("fails closed when the credential overview is revoked", async () => {
    const revoked = {
      ...credential(),
      status: "revoked",
      revokedAt: "2026-07-15T11:00:00.000Z",
    } as ServiceAccountCredentialOverview;
    const result = await revalidateWorkflowPrincipal(principal(), BASE_ID, deps({ findCredential: mock(async () => revoked) }));

    expect(result).toEqual({ ok: false, reason: "Workflow API credential is revoked or inactive." });
  });

  test("fails closed when a user principal was removed or expired", async () => {
    const removed = await revalidateWorkflowPrincipal(
      { userId: USER_ID, groupIds: [], serviceAccountId: null },
      BASE_ID,
      deps({ getUser: mock(async () => null) }),
    );
    const expiredUser = await revalidateWorkflowPrincipal(
      { userId: USER_ID, groupIds: [], serviceAccountId: null },
      BASE_ID,
      deps({ getUser: mock(async () => user({ accountExpires: "2026-07-15T11:59:59.000Z" })) }),
    );

    expect(removed).toEqual({ ok: false, reason: "Workflow user is inactive." });
    expect(expiredUser).toEqual({ ok: false, reason: "Workflow user is inactive." });
  });

  test("applies the lower of accepted and current credential scopes", async () => {
    const result = await revalidateWorkflowPrincipal(
      principal(),
      BASE_ID,
      deps({ findCredential: mock(async () => credential(["grids:read"])) }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.permissionCap).toBe("read");
  });

  test("never raises the accepted permission ceiling when current credential scopes are upgraded", async () => {
    const result = await revalidateWorkflowPrincipal(
      principal(),
      BASE_ID,
      deps({ findCredential: mock(async () => credential(["grids:admin"])) }),
    );

    expect(result).toMatchObject({ ok: true, permissionCap: "write", credential: { permissionCap: "write" } });
  });

  test("rejects resource binding drift even when the new binding matches the requested base", async () => {
    const otherBase = "66666666-6666-4666-8666-666666666666";
    const result = await revalidateWorkflowPrincipal(
      principal(),
      otherBase,
      deps({ getServiceAccount: mock(async () => serviceAccount({ resourceId: otherBase })) }),
    );

    expect(result).toEqual({ ok: false, reason: "Workflow credential resource binding changed." });
  });

  test("rejects cross-base execution", async () => {
    const otherBase = "66666666-6666-4666-8666-666666666666";
    const result = await revalidateWorkflowPrincipal(principal(), otherBase, deps());

    expect(result).toEqual({ ok: false, reason: "Workflow credential is not bound to this Grids base." });
  });

  test("rejects expired OAuth snapshots even while the service account remains active", async () => {
    const oauth: GridsWorkflowPrincipal = {
      ...principal(),
      credential: {
        ...principal().credential!,
        kind: "oauth",
        id: null,
        expiresAt: "2026-07-15T11:59:59.000Z",
      },
    };

    const result = await revalidateWorkflowPrincipal(oauth, BASE_ID, deps());

    expect(result).toEqual({ ok: false, reason: "Workflow credential expired." });
  });
});
