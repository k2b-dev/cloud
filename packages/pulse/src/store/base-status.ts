import { sql } from "bun";
import { readBasePolicy } from "../service/base-policy";
import type { BaseStoreStatus, PulsePolicy } from "./admin-contracts";
import { BaseStoreStatusSchema } from "./admin-schemas";
import { baseStoreNames } from "./base-schema";

export const insertBaseStore = async (baseId: string, policy: PulsePolicy, db: typeof sql = sql, prefix = "pulse_") => {
  const names = baseStoreNames(baseId, prefix),
    limits = policy.defaultLimits;
  await db`INSERT INTO pulse.base_stores(base_id,state,operation,database_name,read_user,profile,values_per_minute,bytes_per_minute,storage_bytes,max_series,max_event_kinds,max_state_keys)
    VALUES(${baseId}::uuid,'provisioning','provision',${names.database},${names.readUser},${policy.defaultProfile},${limits.valuesPerMinute},${limits.bytesPerMinute},${limits.storageBytes},${limits.maxSeries},${limits.maxEventKinds},${limits.maxStateKeys}) ON CONFLICT(base_id) DO NOTHING`;
};
export const baseStoreStatus = async (baseId: string): Promise<BaseStoreStatus> => {
  const [row] =
    await sql`SELECT jsonb_build_object('state',state,'operation',operation,'errorCode',last_error,'errorAt',last_error_at,'writeBlockReason',write_block_reason,'profile',profile,
    'limits',jsonb_build_object('valuesPerMinute',values_per_minute,'bytesPerMinute',bytes_per_minute,'storageBytes',storage_bytes,'maxSeries',max_series,'maxEventKinds',max_event_kinds,'maxStateKeys',max_state_keys),
    'usage',CASE WHEN usage_measured_at IS NULL THEN NULL ELSE jsonb_build_object('bytes',usage_bytes,'rows',usage_rows,'measuredAt',usage_measured_at) END) AS status FROM pulse.base_stores WHERE base_id=${baseId}::uuid`;
  if (row) return BaseStoreStatusSchema.parse(row.status);
  const policy = await readBasePolicy();
  return {
    state: "failed",
    operation: "provision",
    errorCode: "STORE_NOT_PROVISIONED",
    errorAt: null,
    writeBlockReason: null,
    profile: policy.defaultProfile,
    limits: policy.defaultLimits,
    usage: null,
  };
};
