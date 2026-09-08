import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { gridsService } from "../service";
import {
  currentActorUserId,
  currentActorViewer,
  currentResourceBoundBaseId,
  gateAt,
  gateCredentialScope,
  gridsAccessContext,
  resolveBaseWithGrantsForAccess,
  resolveCustomAppWithGrantsForAccess,
  workflowPrincipalFor,
} from "./permissions";

let resolvedLevel: "none" | "read" | "write" | "admin" = "none";
let lastBaseLoad: unknown = null;
let lastAppLoad: unknown = null;

const baseId = "22222222-2222-4222-8222-222222222222";
const customAppId = "33333333-3333-4333-8333-333333333333";
const user = { id: "11111111-1111-4111-8111-111111111111", roles: ["admin", "user"], memberofGroupIds: [] };
const userContext = {
  get: (key: string) => {
    if (key === "actor") return { kind: "user", user };
    if (key === "accessSubject") return { type: "user", userId: user.id };
    return undefined;
  },
};
const resourceServiceAccount = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "Grids API",
  kind: "resource_bound",
  status: "active",
  delegatedUserId: null,
  appId: "grids",
  resourceType: "base",
  resourceId: baseId,
  createdBy: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};
const serviceAccountContext = {
  get: (key: string) => {
    if (key === "actor") {
      return { kind: "service_account", serviceAccount: resourceServiceAccount, delegatedUser: null, scopes: ["grids:read"] };
    }
    if (key === "accessSubject") return { type: "service_account", serviceAccountId: resourceServiceAccount.id };
    return undefined;
  },
};

describe("Grids API permissions", () => {
  beforeEach(() => {
    lastBaseLoad = null;
    lastAppLoad = null;
    spyOn(gridsService.permission, "loadBaseGrantsForSubject").mockImplementation(async (params) => {
      lastBaseLoad = params;
      return [];
    });
    spyOn(gridsService.permission, "loadCustomAppGrantsForSubject").mockImplementation(async (params) => {
      lastAppLoad = params;
      return [];
    });
    spyOn(gridsService.permission, "resolve").mockImplementation(() => resolvedLevel);
  });

  afterEach(() => mock.restore());

  test("Cloud roles do not bypass base grants", async () => {
    resolvedLevel = "none";
    expect((await gateAt(userContext as never, { baseId }, "read")).ok).toBe(false);
  });

  test("loads only the exact base grant and applies its level", async () => {
    resolvedLevel = "write";
    const resolved = await resolveBaseWithGrantsForAccess(gridsAccessContext(userContext as never), baseId);
    expect(resolved.level).toBe("write");
    expect(lastBaseLoad).toEqual({ baseId, subject: { type: "user", userId: user.id } });
    expect(lastAppLoad).toBeNull();
  });

  test("loads Grids App grants independently from base grants", async () => {
    resolvedLevel = "read";
    const resolved = await resolveCustomAppWithGrantsForAccess(gridsAccessContext(userContext as never), customAppId);
    expect(resolved.level).toBe("read");
    expect(lastAppLoad).toEqual({ customAppId, subject: { type: "user", userId: user.id } });
    expect(lastBaseLoad).toBeNull();
  });

  test("resource-bound credentials are capped and cannot cross bases or enter Grids Apps", async () => {
    resolvedLevel = "admin";
    expect(currentResourceBoundBaseId(serviceAccountContext as never)).toBe(baseId);
    expect((await gateAt(serviceAccountContext as never, { baseId }, "read")).ok).toBe(true);
    expect((await gateAt(serviceAccountContext as never, { baseId }, "write")).ok).toBe(false);
    expect((await gateAt(serviceAccountContext as never, { baseId: customAppId }, "read")).ok).toBe(false);
    expect((await gateCredentialScope(serviceAccountContext as never, "write")).ok).toBe(false);
    expect((await resolveCustomAppWithGrantsForAccess(gridsAccessContext(serviceAccountContext as never), customAppId)).level).toBe("none");
  });

  test("preserves actor identity for audit and relation display", () => {
    expect(currentActorUserId(userContext as never)).toBe(user.id);
    expect(currentActorViewer(serviceAccountContext as never)).toEqual({
      userId: null,
      userGroups: [],
      serviceAccountId: resourceServiceAccount.id,
    });
  });

  test("workflow principals preserve credential caps and resource bindings", () => {
    const access = gridsAccessContext(serviceAccountContext as never);
    expect(workflowPrincipalFor(access)).toEqual({
      userId: null,
      groupIds: [],
      serviceAccountId: resourceServiceAccount.id,
      actorServiceAccountId: resourceServiceAccount.id,
      credential: {
        kind: "oauth",
        id: null,
        scopes: ["grids:read"],
        permissionCap: "read",
        expiresAt: null,
        resourceBinding: { appId: "grids", resourceType: "base", resourceId: baseId },
      },
    });
    if (access.actor?.kind !== "service_account") throw new Error("Expected service-account fixture");
    const credentialId = "55555555-5555-4555-8555-555555555555";
    expect(
      workflowPrincipalFor({
        ...access,
        actor: { ...access.actor, credentialId, credentialExpiresAt: "2027-01-01T00:00:00.000Z" },
      }).credential,
    ).toMatchObject({ kind: "api_token", id: credentialId, expiresAt: "2027-01-01T00:00:00.000Z", permissionCap: "read" });
    expect(workflowPrincipalFor(gridsAccessContext(userContext as never))).toEqual({
      userId: user.id,
      groupIds: [],
      serviceAccountId: null,
      actorServiceAccountId: null,
      credential: null,
    });
    const userAccess = gridsAccessContext(userContext as never);
    if (userAccess.actor?.kind !== "user") throw new Error("Expected user fixture");
    expect(
      workflowPrincipalFor({
        accessSubject: userAccess.accessSubject,
        actor: {
          ...access.actor,
          serviceAccount: {
            ...access.actor.serviceAccount,
            kind: "user_delegated",
            delegatedUserId: user.id,
            appId: null,
            resourceType: null,
            resourceId: null,
          },
          delegatedUser: userAccess.actor.user,
        },
      }),
    ).toMatchObject({
      userId: user.id,
      serviceAccountId: null,
      actorServiceAccountId: resourceServiceAccount.id,
      credential: { permissionCap: "read", resourceBinding: null, scopes: ["grids:read"] },
    });
  });
});
