import type { User } from "@k2b/cloud/contracts";
import type { ProfileActionsUser } from "./profile-actions";

/** What the profile's deeds need of the signed-in person, as plain data for an island. */
export const profileActionsUser = (user: User): ProfileActionsUser => ({
  provider: user.provider,
  uid: user.uid,
  givenname: user.givenname,
  sn: user.sn,
  displayName: user.displayName,
  ipa: user.ipa ? { phone: user.ipa.phone, address: user.ipa.address, sshPublicKeys: user.ipa.sshPublicKeys } : null,
});
