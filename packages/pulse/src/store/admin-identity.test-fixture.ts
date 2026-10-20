import type { User } from "@k2b/cloud/contracts";
import type { StoreIdentity } from "./service";
export const adminFixtureIdentity = (id = "11111111-1111-4111-8111-111111111111", admin = true): StoreIdentity => {
  const user: User = {
    id,
    uid: "pulse-fixture",
    provider: "local",
    profile: "user",
    roles: admin ? ["user", "admin"] : ["user"],
    givenname: "Pulse",
    sn: "Fixture",
    displayName: "Pulse fixture",
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
  return { actor: { kind: "user", user }, accessSubject: { type: "user", userId: id } };
};
