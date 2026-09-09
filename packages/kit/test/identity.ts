import type { CapabilityExecutionContext, User } from "@k2b/cloud/contracts";
export function testIdentity(id: string): CapabilityExecutionContext {
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
    actor: { kind: "user", user },
    accessSubject: { type: "user", userId: id },
    user,
    locale: "de",
    signal: new AbortController().signal,
  };
}
