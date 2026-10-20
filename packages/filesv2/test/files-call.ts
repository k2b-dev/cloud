import type { RequestActor } from "@k2b/cloud/server";
import type { UserFilesCall } from "../src/service/activity";

/** Explicit transport context for service fixtures that do not enter through Hono. */
export function testCall(actor: RequestActor): UserFilesCall {
  return {
    kind: "user",
    actor,
    accessSubject:
      actor.kind === "user"
        ? { type: "user", userId: actor.user.id }
        : actor.delegatedUser
          ? { type: "user", userId: actor.delegatedUser.id }
          : { type: "service_account", serviceAccountId: actor.serviceAccount.id },
    via: "web",
    requestId: null,
    origin: null,
    invocationId: null,
    callingApp: null,
  };
}

export const testActor: RequestActor = {
  kind: "user",
  user: {
    id: "10000000-0000-4000-8000-000000000001",
    uid: "alice",
    provider: "local",
    profile: "user",
    roles: ["user"],
    givenname: "Alice",
    sn: "Example",
    displayName: "Alice",
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
};
