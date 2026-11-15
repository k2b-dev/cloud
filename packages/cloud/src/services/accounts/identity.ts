import type { SQLQuery } from "bun";
import type { UserProfile, UserProvider } from "../../contracts/shared";
import { sql } from "../../runtime/clients";
import { EMERGENCY_ADMIN_UID } from "../providers/local/constants";

export type EmergencyIdentityRow = { uid: string; provider: UserProvider; emergency_admin: boolean };

/** The stored marker, local provider and reserved UID identify the emergency account together. */
export const isEmergencyIdentity = (row: EmergencyIdentityRow): boolean =>
  row.emergency_admin === true && row.provider === "local" && row.uid === EMERGENCY_ADMIN_UID;

/** SQL counterpart of isEmergencyIdentity for a user-table alias. */
export const emergencyIdentitySql = (alias: string): SQLQuery =>
  sql`(${sql(`${alias}.emergency_admin`)} AND ${sql(`${alias}.provider`)}='local' AND ${sql(`${alias}.uid`)}=${EMERGENCY_ADMIN_UID})`;

/** Update ordinary identity fields atomically; only an actual change ends the emergency marker. */
export const ordinaryAccountIdentity = (identity: { provider: UserProvider; profile: UserProfile; uid?: string }): SQLQuery =>
  sql`emergency_admin = (users.emergency_admin AND users.provider=${identity.provider} AND users.profile=${identity.profile}
      AND ${identity.uid === undefined ? sql`true` : sql`users.uid=${identity.uid}`}),
    provider=${identity.provider}, profile=${identity.profile}${identity.uid === undefined ? sql`` : sql`, uid=${identity.uid}`}`;
