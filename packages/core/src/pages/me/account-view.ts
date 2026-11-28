import { cloudAvatarImage } from "@k2b/cloud/account/ui";
import { accountCategory, type User } from "@k2b/cloud/contracts";
import type { AccountMessages } from "./messages";

/** The person in the head of an account page, as the server read them: plain data an island takes as props. */
export type AccountUserView = {
  name: string;
  uid: string;
  image: string | undefined;
  /** Only an exception stands beside the name: "Expired". The category and roles are facts of the profile. */
  kinds: string[];
};

/** The account's category in Core's words; Login keeps the name the operator gave it. */
export const accountCategoryWords = (user: User, loginLabel: string, t: AccountMessages): string => {
  const category = accountCategory(user);
  return category === "freeipa" ? t.accountCategoryFreeIpa : category === "guest" ? t.accountCategoryGuest : loginLabel.trim() || "Login";
};

/** The extra roles of the account in words, such as "Admin". */
export const accountRoles = (user: User, t: AccountMessages): string[] =>
  user.roles
    .filter((role) => role === "admin" || role === "group-manager")
    .map((role) => (role === "group-manager" ? t.roleGroupManager : t.roleAdmin));

export const accountUserView = (user: User, t: AccountMessages, now = new Date()): AccountUserView => {
  const expired = user.accountExpires ? new Date(user.accountExpires) < now : false;
  return {
    name: user.displayName || user.uid,
    uid: user.uid,
    image: cloudAvatarImage({ kind: "user", userId: user.id, avatarHash: user.avatarHash }),
    kinds: expired ? [t.expired] : [],
  };
};
