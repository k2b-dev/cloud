import type { UserProfile, UserProvider } from "../../contracts/shared";

/** Ordinary provider/profile writes end the emergency identity in the same account update. */
export const ordinaryAccountIdentity = (identity: { provider: UserProvider; profile: UserProfile; uid?: string }) => ({
  ...identity,
  emergency_admin: false,
});
