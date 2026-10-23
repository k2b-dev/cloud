import { expect, test } from "bun:test";
import type { User } from "../contracts/shared";
import type { PermissionLevel } from "../server/services/access";
import type { ServiceAccount } from "../services/service-accounts";
import {
  type AiResourceContext,
  AiResourceCredentialError,
  aiResourcePermissionCap,
  capAiResourcePermission,
  requireAiResourceCreation,
} from "./projects-authorization";

const machine = (kind: ServiceAccount["kind"], scopes: string[]): AiResourceContext => ({
  actor: {
    kind: "service_account",
    delegatedUser: null,
    scopes,
    serviceAccount: {
      id: "machine",
      name: "Test machine",
      kind,
      status: "active",
      delegatedUserId: null,
      appId: kind === "resource_bound" ? "assistant" : null,
      resourceType: kind === "resource_bound" ? "project" : null,
      resourceId: kind === "resource_bound" ? "project" : null,
      createdBy: null,
      createdAt: new Date(0).toISOString(),
    },
  },
  accessSubject: { type: "service_account", serviceAccountId: "machine" },
});

for (const kind of ["standalone", "agent"] as const) {
  test(`${kind} scopes only lower grants and do not create access`, () => {
    const permissions: PermissionLevel[] = ["none", "read", "write", "admin"];
    for (const [index, permission] of permissions.entries()) {
      const subject = machine(kind, permission === "none" ? ["openid"] : ["openid", permission]);
      expect(aiResourcePermissionCap(subject)).toBe(permission);
      for (const [grantIndex, grant] of permissions.entries()) {
        expect(capAiResourcePermission(grant, subject)).toBe(permissions[Math.min(index, grantIndex)]!);
      }
      if (permission === "none" || permission === "read") {
        expect(() => requireAiResourceCreation(subject)).toThrow(AiResourceCredentialError);
      } else {
        expect(() => requireAiResourceCreation(subject)).not.toThrow();
      }
    }
  });
}

test("bare machine subjects and unsupported resource bindings fail closed", () => {
  const bare = { type: "service_account" as const, serviceAccountId: "machine" };
  expect(Reflect.apply(aiResourcePermissionCap, undefined, [bare])).toBe("none");
  expect(() => Reflect.apply(requireAiResourceCreation, undefined, [bare])).toThrow(AiResourceCredentialError);
  for (const subject of [machine("resource_bound", ["admin"]), machine("user_delegated", ["admin"]), null]) {
    expect(aiResourcePermissionCap(subject)).toBe("none");
    expect(capAiResourcePermission("admin", subject)).toBe("none");
    if (subject) expect(() => requireAiResourceCreation(subject)).toThrow(AiResourceCredentialError);
  }
});

test("a credential cannot authorize another account's grants", () => {
  const subject = machine("agent", ["admin"]);
  if (!("actor" in subject)) throw new Error("Missing fixture actor");
  expect(aiResourcePermissionCap({ ...subject, accessSubject: { type: "service_account", serviceAccountId: "other-machine" } })).toBe(
    "none",
  );
  expect(aiResourcePermissionCap({ ...subject, accessSubject: { type: "user", userId: "owner" } })).toBe("none");
});

test("user and delegated-user contexts keep user grants without machine scope caps", () => {
  const user: User = {
    id: "owner",
    uid: "owner",
    roles: ["user"],
    provider: "local",
    profile: "user",
    givenname: "Test",
    sn: "Owner",
    displayName: "Test owner",
    mail: null,
    avatarHash: null,
    ipa: null,
    accountExpires: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
  };
  const subject = machine("user_delegated", ["read"]);
  if (!("actor" in subject) || subject.actor.kind !== "service_account") throw new Error("Missing fixture credential");
  const accessSubject = { type: "user" as const, userId: user.id };
  const contexts: AiResourceContext[] = [
    { actor: { kind: "user", user }, accessSubject },
    {
      actor: { ...subject.actor, delegatedUser: user, serviceAccount: { ...subject.actor.serviceAccount, delegatedUserId: user.id } },
      accessSubject,
    },
  ];
  for (const context of contexts) {
    expect(capAiResourcePermission("admin", context)).toBe("admin");
    expect(capAiResourcePermission("none", context)).toBe("none");
    expect(() => requireAiResourceCreation(context)).not.toThrow();
  }
});
