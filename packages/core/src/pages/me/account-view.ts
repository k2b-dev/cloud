import { cloudAvatarImage } from "@k2b/cloud/account/ui";
import { accountCategoryLabel, type User } from "@k2b/cloud/contracts";
import type { AccountMessages } from "./messages";

/** The person in the head of an account page, as the server read them: plain data an island takes as props. */
export type AccountUserView = {
  name: string;
  uid: string;
  image: string | undefined;
  /** The account's category, its extra roles and "Expired", in that order. */
  kinds: string[];
};

export const accountUserView = (user: User, loginLabel: string, t: AccountMessages, now = new Date()): AccountUserView => {
  const roles = user.roles.filter((role) => role === "admin" || role === "group-manager");
  const expired = user.accountExpires ? new Date(user.accountExpires) < now : false;
  return {
    name: user.displayName || user.uid,
    uid: user.uid,
    image: cloudAvatarImage({ kind: "user", userId: user.id, avatarHash: user.avatarHash }),
    kinds: [
      accountCategoryLabel(user, loginLabel),
      ...roles.map((role) => (role === "group-manager" ? t.roleGroupManager : t.roleAdmin)),
      ...(expired ? [t.expired] : []),
    ],
  };
};
