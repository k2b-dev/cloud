import { describe, expect, test } from "bun:test";
import { UserSchema, type User } from "@k2b/cloud/contracts";
import type { MailRequestContext } from "./auth";
import { isCurrentPlatformAdmin } from "./access";

const user = (roles: User["roles"], provider: User["provider"] = "ipa"): User =>
  UserSchema.parse({
    id: "00000000-0000-4000-8000-000000000001",
    uid: "admin",
    provider,
    profile: "user",
    displayName: "Admin",
    givenname: "Admin",
    sn: "User",
    mail: "admin@example.com",
    roles,
    avatarHash: null,
    memberofGroupIds: [],
    memberofGroup: [],
    manages: [],
    managesGroupIds: [],
    accountExpires: null,
    lastLoginLocal: null,
    ipa:
      provider === "ipa"
        ? {
            uidNumber: null,
            phone: null,
            employeeType: null,
            mobile: null,
            address: { street: null, postalCode: null, city: null, state: null },
            passwordExpires: null,
            lastLoginIpa: null,
            syncedAt: null,
            sshPublicKeys: [],
            sshFingerprints: [],
          }
        : null,
  });

const contextFor = (currentUser: User): MailRequestContext => ({
  actor: { kind: "user", user: currentUser },
  accessSubject: { type: "user", userId: currentUser.id },
  requestId: "platform-admin-test",
});

describe("Mail platform administration", () => {
  test("accepts the current provider-independent Cloud admin role", async () => {
    const ipaAdmin = user(["ipa", "ipa/user", "user", "admin"]);

    expect(await isCurrentPlatformAdmin(contextFor(ipaAdmin), async () => ipaAdmin)).toBe(true);
  });

  test("rejects an admin role that has been revoked since authentication", async () => {
    const authenticatedAdmin = user(["local", "local/user", "user", "admin"], "local");
    const currentUser = user(["local", "local/user", "user"], "local");

    expect(await isCurrentPlatformAdmin(contextFor(authenticatedAdmin), async () => currentUser)).toBe(false);
  });
});
