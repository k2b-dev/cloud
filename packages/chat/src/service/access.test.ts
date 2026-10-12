import { describe, expect, test } from "bun:test";
import { ServiceAccountSchema, UserSchema } from "@k2b/cloud/contracts";
import type { RequestActor } from "@k2b/cloud/server";
import { actingPrincipal, boundConversation, capPermission, subjectPrincipal } from "./access";

const id = "12345678-1234-4234-8234-123456789012";
const person = UserSchema.parse({
  id,
  uid: "lea",
  provider: "local",
  profile: "user",
  roles: ["user"],
  givenname: "Lea",
  sn: "Example",
  displayName: "Lea Example",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
});
const account = ServiceAccountSchema.parse({
  id: "12345678-1234-4234-8234-123456789013",
  name: "Account",
  kind: "standalone",
  status: "active",
  delegatedUserId: null,
  appId: null,
  resourceType: null,
  resourceId: null,
  createdBy: null,
  createdAt: "2026-10-09T00:00:00Z",
});
const actor = (scopes: string[], kind = account.kind): RequestActor => ({
  kind: "service_account",
  serviceAccount: { ...account, kind },
  delegatedUser: null,
  scopes,
});

describe("conversation credential authority", () => {
  test("caps every undelegated service account by scopes; scopes never grant access", () => {
    for (const kind of ["standalone", "agent", "resource_bound"] as const) {
      expect(capPermission("admin", actor(["read"], kind))).toBe("read");
      expect(capPermission("write", actor(["admin"], kind))).toBe("write");
      expect(capPermission("none", actor(["admin"], kind))).toBe("none");
      expect(capPermission("read", actor(["openid"], kind))).toBe("none");
    }
  });
  test("uses the same grants for sessions and user-delegated credentials regardless of scopes", () => {
    const session: RequestActor = { kind: "user", user: person };
    const delegated: RequestActor = {
      kind: "service_account",
      serviceAccount: { ...account, kind: "user_delegated", delegatedUserId: id },
      delegatedUser: person,
      scopes: ["openid", "read"],
    };
    for (const permission of ["none", "read", "write", "admin"] as const) {
      expect(capPermission(permission, session)).toBe(permission);
      expect(capPermission(permission, delegated)).toBe(permission);
    }
    expect(actingPrincipal(delegated)).toEqual({ type: "service_account", id: account.id });
    expect(subjectPrincipal({ type: "user", userId: id, delegatedByServiceAccountId: account.id })).toEqual({ type: "user", id });
  });
  test("requires the exact app and resource type for a resource binding", () => {
    const base = actor(["read"], "resource_bound");
    if (base.kind !== "service_account") throw new Error("Expected account");
    for (const [appId, resourceType] of [
      ["other", "conversation"],
      ["chat", "other"],
    ]) {
      expect(
        boundConversation({
          ...base,
          serviceAccount: { ...base.serviceAccount, appId: appId!, resourceType: resourceType!, resourceId: "abcdef" },
        }).ok,
      ).toBeFalse();
    }
    expect(
      boundConversation({
        ...base,
        serviceAccount: { ...base.serviceAccount, appId: "chat", resourceType: "conversation", resourceId: "abcdef" },
      }),
    ).toEqual({ ok: true, data: "abcdef" });
    expect(boundConversation(actor(["read"]))).toEqual({ ok: true, data: null });
  });
});
