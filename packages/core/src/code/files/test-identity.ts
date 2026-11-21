import type { User } from "@k2b/cloud/contracts";
export function testIdentity(id: string) {
  const user: User = {
    id,
    uid: "test",
    roles: [],
    provider: "local",
    profile: "user",
    givenname: "Test",
    sn: "User",
    displayName: "Test User",
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
  return {
    credentialKind: "session" as const,
    actor: { kind: "user" as const, user },
    accessSubject: { type: "user" as const, userId: id },
    user,
  };
}
