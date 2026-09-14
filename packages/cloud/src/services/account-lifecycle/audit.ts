import { sql } from "bun";
import type { UserProfile, UserProvider } from "../../contracts/shared";

export type DeletedAccountReason =
  | "ipa_expired_demoted"
  | "ipa_expired_deleted"
  | "sync_out_of_scope_demoted"
  | "sync_out_of_scope_deleted"
  | "guest_expired_deleted"
  | "local_user_expired_deleted"
  | "manual_delete"
  | "manual_demote";

type SqlExecutor = typeof sql;

export const writeDeletedAccountAudit = async (config: {
  userId: string;
  uid: string;
  mail: string | null;
  displayName: string | null;
  previousProvider: UserProvider;
  previousProfile: UserProfile;
  reason: DeletedAccountReason;
  meta?: Record<string, unknown>;
  db?: SqlExecutor;
}): Promise<void> => {
  const db = config.db ?? sql;
  await db`
    INSERT INTO auth.deleted_accounts (deleted_user_id, uid, mail, display_name, previous_provider, previous_profile, reason, meta)
    VALUES (
      ${config.userId}::uuid,
      ${config.uid},
      ${config.mail},
      ${config.displayName},
      ${config.previousProvider},
      ${config.previousProfile},
      ${config.reason},
      ${JSON.stringify(config.meta ?? {})}::text::jsonb
    )
  `;
};
