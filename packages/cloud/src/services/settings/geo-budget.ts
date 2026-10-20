import type { sql } from "bun";
import { HTTPException } from "hono/http-exception";
import { decryptValue } from "./crypto";
import { SETTINGS_MAP, validateSettingValue } from "./defaults";
import { SettingUnreadableError } from "./store";

const MONTH = "geo.monthly_budget_credits";
const DAY = "geo.person_daily_credits";
export class GeoBudgetSettingError extends HTTPException {
  readonly code = "geo_budget_invalid";
  constructor() {
    const message = "Daily geo credits must not exceed the monthly geo budget";
    super(400, {
      message,
      res: Response.json({ code: "geo_budget_invalid", message, errors: { [DAY]: message, [MONTH]: message } }, { status: 400 }),
    });
  }
}
/** Validate the final pair once, holding the lock until the caller commits all mutations. */
export const assertGeoBudgetPair = async (tx: typeof sql, updates: Record<string, unknown>, resets: readonly string[]): Promise<void> => {
  if (![MONTH, DAY].some((key) => Object.hasOwn(updates, key) || resets.includes(key))) return;
  await tx`SELECT pg_advisory_xact_lock(hashtextextended('core.geo.budget-settings', 0))`;
  const resolve = async (key: string): Promise<unknown> => {
    if (Object.hasOwn(updates, key)) return updates[key];
    const def = SETTINGS_MAP.get(key);
    if (resets.includes(key)) return def?.default;
    const [row] = await tx<{ value: string }[]>`SELECT value FROM settings.entries WHERE key=${key}`;
    if (!row) return def?.default;
    try {
      const value = await decryptValue(row.value);
      if (def && validateSettingValue(def, value).ok) return value;
    } catch {
      // Recovery can replace or reset a row without decrypting its old value.
    }
    throw new SettingUnreadableError(key);
  };
  const month = await resolve(MONTH);
  const day = await resolve(DAY);
  if (typeof month !== "number" || typeof day !== "number" || day > month) throw new GeoBudgetSettingError();
};
