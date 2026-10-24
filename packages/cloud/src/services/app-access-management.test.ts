import { afterEach, expect, setSystemTime, test } from "bun:test";
import { appAccess } from "../contracts/app-access";
import type { RequestAuthority } from "../server/middleware/auth";
import { appAccessGrantCounts, canManageAppAccess, canRepairAppAccess, requireAppAccessManager } from "./app-access-management";
import { buildProjectedUser } from "./session/user";

const user = buildProjectedUser({ id: "11111111-1111-4111-8111-111111111111", provider: "local", profile: "user", effective_admin: true });
const authority = (): RequestAuthority => ({
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  credentialKind: "session",
  scopes: [],
});
const service = (): RequestAuthority => ({
  actor: {
    kind: "service_account",
    delegatedUser: user,
    scopes: [],
    serviceAccount: {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Fictional personal key",
      kind: "user_delegated",
      status: "active",
      delegatedUserId: user.id,
      appId: null,
      resourceType: null,
      resourceId: null,
      createdBy: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  },
  accessSubject: { type: "user", userId: user.id },
  credentialKind: "api_key",
  scopes: [],
});
afterEach(() => setSystemTime());

test("repair is explicit and does not read grants or invoke the app restriction", async () => {
  await requireAppAccessManager(
    authority(),
    { id: "demo", name: "Demo", access: appAccess.grants() },
    {
      repair: true,
      canManage: () => {
        throw new Error("App restriction must not govern repair");
      },
    },
  );
  await expect(
    requireAppAccessManager(authority(), { id: "fixed", name: "Fixed", access: appAccess.signedIn() }, { repair: true }),
  ).rejects.toMatchObject({ code: "APP_ACCESS_FIXED", status: 409 });
});

test("Cloud repair retains OAuth and API-key caps and never accepts mobile admin roles", () => {
  expect(canRepairAppAccess(authority())).toBe(true);
  expect(canRepairAppAccess({ ...authority(), actor: { kind: "user", user, sessionKind: "app" } })).toBe(false);
  expect(canRepairAppAccess({ ...authority(), actor: { kind: "user", user: { ...user, roles: ["user"] } } })).toBe(false);
  for (const scopes of [[], ["read"], ["write"], ["demo:admin"], ["ai:inference", "admin"]]) {
    expect(canRepairAppAccess({ ...authority(), credentialKind: "oauth", scopes })).toBe(false);
  }
  expect(canRepairAppAccess({ ...authority(), credentialKind: "oauth", scopes: ["admin"] })).toBe(true);
  expect(canRepairAppAccess(service())).toBe(true);
  expect(canRepairAppAccess({ ...service(), scopes: ["read"] })).toBe(false);
  const invocation = authority();
  invocation.credentialKind = "invocation";
  invocation.actor.delegation = { kind: "invocation", callingAppId: "demo", credentialKind: "oauth", invocationId: "fixture" };
  expect(canRepairAppAccess(invocation)).toBe(false);
});

test("expired people, disabled service accounts and expired or resource-bound keys cannot manage", async () => {
  setSystemTime(new Date("2026-10-22T12:00:00Z"));
  const invalid: RequestAuthority[] = [
    { ...authority(), actor: { kind: "user", user: { ...user, accountExpires: "2026-10-22T11:59:59Z" } } },
  ];
  for (const mode of ["disabled", "expired", "resource_bound"] as const) {
    const a = service();
    if (a.actor.kind !== "service_account") throw new Error("fixture");
    if (mode === "disabled") a.actor.serviceAccount.status = "disabled";
    if (mode === "expired") a.actor.credentialExpiresAt = "2026-10-22T12:00:00Z";
    if (mode === "resource_bound") a.actor.serviceAccount = { ...a.actor.serviceAccount, kind: "resource_bound", appId: "demo" };
    invalid.push(a);
  }
  invalid.push({ ...authority(), credentialKind: "oauth", scopes: ["read"] });
  for (const a of invalid) {
    if (a.credentialKind !== "oauth") expect(canRepairAppAccess(a)).toBe(false);
    await expect(requireAppAccessManager(a, { id: "demo", name: "Demo", access: appAccess.grants() })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  }
});

test("repair overview counts require administration and skip fixed apps without a database query", async () => {
  await expect(appAccessGrantCounts({ ...authority(), credentialKind: "oauth", scopes: ["read"] }, [])).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  expect(await appAccessGrantCounts(authority(), [{ id: "fixed", name: "Fixed", access: appAccess.signedIn() }])).toEqual(new Map());
});

test("management visibility never invokes the app callback to bypass a fixed rule or credential cap", async () => {
  const restriction = () => {
    throw new Error("A callback cannot widen credential authority");
  };
  expect(await canManageAppAccess(authority(), { id: "fixed", name: "Fixed", access: appAccess.signedIn() }, restriction)).toBe(false);
  expect(
    await canManageAppAccess(
      { ...authority(), credentialKind: "oauth", scopes: ["read"] },
      { id: "demo", name: "Demo", access: appAccess.grants() },
      restriction,
    ),
  ).toBe(false);
});
