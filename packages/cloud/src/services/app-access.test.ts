import { afterEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { sql } from "bun";
import { bindAppAccessRequest } from "../_internal/app-access-request";
import { bindResourceAppAccess, resourceAppAccess } from "../_internal/app-access-resources";
import { appAccess, compileAppAccess } from "../contracts/app-access";
import type { User } from "../contracts/shared";
import type { RequestAuthority } from "../server/middleware/auth";
import { canUseApp, evaluateAppAccess, usableAppIds } from "./app-access";

const user: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "anna",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Anna",
  sn: "Example",
  displayName: "Anna Example",
  mail: null,
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
};
const person = (overrides: Partial<Pick<User, "roles" | "profile">> = {}): RequestAuthority => ({
  actor: { kind: "user", user: { ...user, ...overrides } },
  accessSubject: { type: "user", userId: user.id },
  credentialKind: "session",
  scopes: [],
});
const service = (): RequestAuthority => ({
  actor: {
    kind: "service_account",
    delegatedUser: null,
    scopes: ["read"],
    serviceAccount: {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Test agent",
      kind: "agent",
      status: "active",
      delegatedUserId: null,
      appId: null,
      resourceType: null,
      resourceId: null,
      createdBy: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  },
  accessSubject: { type: "service_account", serviceAccountId: "22222222-2222-4222-8222-222222222222" },
  credentialKind: "api_key",
  scopes: ["read"],
});
afterEach(() => setSystemTime());

describe("application entry rules", () => {
  test("legacy applications retain entry behavior; declared rules require resolved identity", async () => {
    expect(await canUseApp(null, { id: "legacy" })).toBe(true);
    expect(await canUseApp(null, { id: "declared", access: appAccess.signedIn() })).toBe(false);
    expect(await canUseApp(person(), { id: "declared", access: appAccess.signedIn() })).toBe(true);
  });
  test("no guests admits roleless service accounts but excludes a delegated guest", () => {
    const app = { id: "test", access: appAccess.noGuests() };
    expect(evaluateAppAccess(service(), app)).toBe(true);
    expect(evaluateAppAccess(person({ profile: "guest", roles: ["guest"] }), app)).toBe(false);
    const delegated = service();
    if (delegated.actor.kind !== "service_account") throw new Error("fixture");
    delegated.actor = { ...delegated.actor, delegatedUser: { ...user, profile: "guest", roles: ["guest"] } };
    expect(evaluateAppAccess(delegated, app)).toBe(false);
  });
  test("fixed roles use effective roles, with no admin inference from subject IDs", () => {
    const app = { id: "ops", access: appAccess.roles(["admin"]) };
    expect(evaluateAppAccess(person(), app)).toBe(false);
    expect(evaluateAppAccess(person({ roles: ["admin"] }), app)).toBe(true);
    const phone = person();
    if (phone.actor.kind !== "user") throw new Error("fixture");
    phone.actor.sessionKind = "app";
    expect(evaluateAppAccess(phone, app)).toBe(false);
    expect(evaluateAppAccess(service(), app)).toBe(false);
  });
  test("configured grants never bypass the list for an installation administrator", () => {
    const app = { id: "invoices", access: appAccess.grants({ until: appAccess.signedIn() }) };
    const configured = { app_id: app.id, configured: true, permission: null };
    expect(evaluateAppAccess(person({ roles: ["admin"] }), app, configured)).toBe(false);
    expect(evaluateAppAccess(person(), app, { ...configured, permission: "read" })).toBe(true);
    expect(evaluateAppAccess(person(), app, { ...configured, permission: "admin" })).toBe(true);
  });
  test("unconfigured access retains exactly the predecessor and stops on first save", () => {
    const app = { id: "ops", access: appAccess.grants({ until: appAccess.roles(["admin"]) }) };
    expect(evaluateAppAccess(person(), app)).toBe(false);
    expect(evaluateAppAccess(person({ roles: ["admin"] }), app)).toBe(true);
    expect(evaluateAppAccess(person({ roles: ["admin"] }), app, { app_id: app.id, configured: true, permission: null })).toBe(false);
    expect(evaluateAppAccess(person(), { id: "new", access: appAccess.grants() })).toBe(false);
  });
  test("credential scope, resource binding and expiry cap all rules", () => {
    setSystemTime(new Date("2026-10-22T12:00:00Z"));
    const authority = service();
    const app = { id: "invoices", access: appAccess.signedIn() };
    expect(evaluateAppAccess({ ...authority, scopes: [] }, app)).toBe(false);
    expect(evaluateAppAccess({ ...authority, scopes: ["ai:inference"] }, app)).toBe(false);
    if (authority.actor.kind !== "service_account") throw new Error("fixture");
    authority.actor.serviceAccount = { ...authority.actor.serviceAccount, kind: "resource_bound", appId: "files" };
    expect(evaluateAppAccess(authority, app)).toBe(false);
    authority.actor.serviceAccount.appId = "invoices";
    expect(evaluateAppAccess(authority, app)).toBe(true);
    authority.actor.credentialExpiresAt = "2026-10-22T12:00:00Z";
    expect(evaluateAppAccess(authority, app)).toBe(false);
  });
  test("personal full-access API keys keep their empty-scope meaning; prefixed scopes remain bounded", () => {
    const authority = service();
    const app = { id: "invoices", access: appAccess.signedIn() };
    expect(evaluateAppAccess({ ...authority, scopes: ["invoices:read"] }, app)).toBe(true);
    expect(evaluateAppAccess({ ...authority, scopes: ["files:read"] }, app)).toBe(false);
    if (authority.actor.kind !== "service_account") throw new Error("fixture");
    authority.actor = {
      ...authority.actor,
      delegatedUser: user,
      serviceAccount: { ...authority.actor.serviceAccount, kind: "user_delegated", delegatedUserId: user.id },
    };
    expect(evaluateAppAccess({ ...authority, scopes: [] }, app)).toBe(true);
    expect(evaluateAppAccess({ ...authority, scopes: ["read", "ai:inference"] }, app)).toBe(false);
  });
  test("registry declarations contain no code and reject malformed policies", () => {
    const canManage = () => true;
    expect(compileAppAccess(appAccess.grants({ canManage, until: appAccess.noGuests() }))).toEqual({
      kind: "grants",
      until: { kind: "noGuests" },
    });
    expect(() => compileAppAccess(appAccess.roles([]))).toThrow();
    expect(() => compileAppAccess(appAccess.signedIn({ publicRoutes: ["//other.example/path"] }))).toThrow();
  });
  test("fixed decisions batch without touching a database", async () => {
    expect(
      await usableAppIds(person(), [
        { id: "legacy" },
        { id: "notes", access: appAccess.signedIn() },
        { id: "ops", access: appAccess.roles(["admin"]) },
      ]),
    ).toEqual(new Set(["legacy", "notes"]));
  });
});

describe("resource-derived app access", () => {
  test("compiles only adapter names; a missing existence query fails at startup", () => {
    const hasAnyRight = mock(async () => true);
    const declaration = appAccess.resources({ adapters: { workspace: { hasAnyRight } }, publicRoutes: ["/shared/:token"] });
    expect(compileAppAccess(declaration)).toEqual({ kind: "resources", adapters: ["workspace"], publicRoutes: ["/shared/:token"] });
    expect(() => compileAppAccess(appAccess.resources({ adapters: {} }))).toThrow();
    // A JavaScript consumer must get the same startup validation as TypeScript.
    expect(() => compileAppAccess(JSON.parse('{"kind":"resources","adapters":{"workspace":{}}}'))).toThrow("hasAnyRight");
    expect(hasAnyRight).not.toHaveBeenCalled();
  });

  test("any selected scope suffices; no identity or admin role grants access by itself", async () => {
    let right = false;
    const hasAnyRight = mock(async () => right);
    const declaration = appAccess.resources({ adapters: { workspace: { hasAnyRight }, project: { hasAnyRight: async () => false } } });
    const app = { id: "resource-unit", access: compileAppAccess(declaration) };
    const stop = bindResourceAppAccess(app.id, declaration);
    try {
      expect(await canUseApp(null, app)).toBe(false);
      expect(hasAnyRight).not.toHaveBeenCalled();
      expect(await canUseApp(person({ roles: ["admin"] }), app)).toBe(false);
      right = true;
      expect(await canUseApp(person(), app)).toBe(true);
      expect(await canUseApp(person({ profile: "guest", roles: ["guest"] }), app)).toBe(true);
      expect(await canUseApp(service(), app)).toBe(true);
      right = false;
      expect(await canUseApp(person(), app)).toBe(false);
    } finally {
      stop();
    }
  });

  test("credential ceilings are checked before the adapter; a bound account selects only its resource type", async () => {
    setSystemTime(new Date("2026-10-28T12:00:00Z"));
    const workspace = mock(async () => true);
    const project = mock(async () => true);
    const declaration = appAccess.resources({ adapters: { workspace: { hasAnyRight: workspace }, project: { hasAnyRight: project } } });
    const app = { id: "resource-unit", access: compileAppAccess(declaration) };
    const stop = bindResourceAppAccess(app.id, declaration);
    const authority = service();
    if (authority.actor.kind !== "service_account") throw new Error("fixture");
    try {
      for (const scopes of [[], ["other:read"], ["ai:inference"]]) expect(await canUseApp({ ...authority, scopes }, app)).toBe(false);
      expect(workspace).not.toHaveBeenCalled();
      authority.actor.serviceAccount = {
        ...authority.actor.serviceAccount,
        kind: "resource_bound",
        appId: "other",
        resourceType: "project",
        resourceId: "one",
      };
      expect(await canUseApp(authority, app)).toBe(false);
      authority.actor.serviceAccount.appId = app.id;
      expect(await canUseApp(authority, app)).toBe(true);
      expect(workspace).not.toHaveBeenCalled();
      expect(project).toHaveBeenCalledTimes(1);
      authority.actor.credentialExpiresAt = "2026-10-28T12:00:00Z";
      expect(await canUseApp(authority, app)).toBe(false);
      expect(project).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  test("shares one decision only within a request; transactions and new requests read again", async () => {
    let right = true;
    const hasAnyRight = mock(async (_subject: import("../server/services/access").AccessSubject, context: { db: typeof sql }) => {
      expect(context.db).toBe(sql);
      return right;
    });
    const declaration = appAccess.resources({ adapters: { workspace: { hasAnyRight } } });
    const app = { id: "resource-unit", access: compileAppAccess(declaration) };
    const stop = bindResourceAppAccess(app.id, declaration);
    const request = new Request("http://app.test/");
    const authority = bindAppAccessRequest(person(), request);
    try {
      expect(await canUseApp(authority, app)).toBe(true);
      right = false;
      expect(await canUseApp(bindAppAccessRequest(person(), request), app)).toBe(true);
      expect(hasAnyRight).toHaveBeenCalledTimes(1);
      expect(await canUseApp(authority, app, { db: sql })).toBe(false);
      expect(await canUseApp(bindAppAccessRequest(person(), new Request(request)), app)).toBe(false);
      expect(hasAnyRight).toHaveBeenCalledTimes(3);
    } finally {
      stop();
    }
  });

  test("adapter failures deny entry and discovery", async () => {
    const declaration = appAccess.resources({
      adapters: {
        workspace: {
          hasAnyRight: async () => {
            throw new Error("unavailable");
          },
        },
      },
    });
    const app = { id: "resource-unit", access: compileAppAccess(declaration) };
    const stop = bindResourceAppAccess(app.id, declaration);
    try {
      expect(await usableAppIds(person(), [app])).toEqual(new Set());
    } finally {
      stop();
    }
  });
});

test("an aborted existence check releases the caller and starts no further scope", async () => {
  const controller = new AbortController();
  const second = mock(async () => true);
  let observed = false;
  const declaration = appAccess.resources({
    adapters: {
      workspace: {
        hasAnyRight: async (_subject, { signal }) =>
          new Promise<boolean>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                observed = true;
                resolve(false);
              },
              { once: true },
            );
          }),
      },
      project: { hasAnyRight: second },
    },
  });
  const app = { id: "resource-abort", access: compileAppAccess(declaration) };
  const stop = bindResourceAppAccess(app.id, declaration);
  try {
    const pending = resourceAppAccess(person(), app, { signal: controller.signal });
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    expect(observed).toBe(true);
    expect(second).not.toHaveBeenCalled();
  } finally {
    stop();
  }
});
