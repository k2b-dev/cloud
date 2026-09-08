import { sql } from "bun";
import { decryptValue } from "../settings/crypto";

/** Read durable policy so disabling new requests is not delayed by the settings cache. */
export const accountRequestsEnabled = async (db: typeof sql = sql): Promise<boolean> => {
  const [row] = await db<{ value: string }[]>`SELECT value FROM settings.entries WHERE key = 'user.account_requests.enabled'`;
  if (!row) return false;
  const value: unknown = await decryptValue(row.value);
  if (typeof value !== "boolean") throw new Error("Invalid account request policy");
  return value;
};
