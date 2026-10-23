import { type SQL, sql } from "bun";

/** Management is a direct grant, independent of machine membership. */
export const migrate = async (db: SQL = sql): Promise<void> => {
  await db`CREATE TABLE IF NOT EXISTS auth.group_manager_service_accounts (
    group_id UUID NOT NULL REFERENCES auth.groups(id) ON DELETE CASCADE,
    service_account_id UUID NOT NULL REFERENCES auth.service_accounts(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, service_account_id)
  )`.simple();
  await db`CREATE INDEX IF NOT EXISTS group_manager_service_accounts_account
    ON auth.group_manager_service_accounts(service_account_id)`.simple();
};
