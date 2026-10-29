import { sql } from "bun";
import type { ActivityEntry } from "../activity-contracts";

export type RecoveryRecord = {
  id: string;
  action: string;
  state: ActivityEntry["state"];
  server_url: string;
  root: string;
  base_id: string | null;
  path_before: string | null;
  trash_id: string | null;
};

/** Call only after the shared history reader authorizes this entry. Recovery exposes a trash reference only after authorizing that trash item too. */
export async function activityRecoveryRecord(id: string): Promise<RecoveryRecord | null> {
  const [row] = await sql<RecoveryRecord[]>`SELECT id,action,state,server_url,root,base_id,path_before,trash_id
    FROM filesv2.activity WHERE id=${id}::uuid`;
  return row ?? null;
}
