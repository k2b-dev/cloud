import type { AccessSubject } from "../server";
import type { AiResourceContext } from "./projects-authorization";

/** Complete user actor for service fixtures; machine fixtures must supply their actual credential. */
export const userResourceContext = (
  subject: Extract<AccessSubject, { type: "user" }>,
  roles: string[] = ["user"],
): AiResourceContext => ({
  accessSubject: subject,
  actor: {
    kind: "user",
    user: {
      id: subject.userId,
      uid: subject.userId,
      roles,
      provider: "local",
      profile: "user",
      givenname: "Test",
      sn: "User",
      displayName: "Test user",
      mail: null,
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
    },
  },
});
