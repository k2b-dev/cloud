import { type SQL, sql } from "bun";

/** Cloud recipient membership does not create a Unix or directory identity. */
export const migrate = async (db: SQL = sql): Promise<void> => {
  await db`CREATE TABLE IF NOT EXISTS auth.service_account_groups (
    service_account_id UUID NOT NULL REFERENCES auth.service_accounts(id) ON DELETE CASCADE,
    group_id UUID NOT NULL REFERENCES auth.groups(id) ON DELETE CASCADE,
    PRIMARY KEY (service_account_id, group_id)
  )`.simple();
  await db`CREATE INDEX IF NOT EXISTS service_account_groups_group_id
    ON auth.service_account_groups(group_id)`.simple();
};
