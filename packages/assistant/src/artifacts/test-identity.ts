import type { User } from "@k2b/cloud/contracts";
import type { ArtifactIdentity } from "./service";
export function testIdentity(id: string): ArtifactIdentity & { user: User } {
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
  };
}
