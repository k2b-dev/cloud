import { sql } from "bun";
import {
  type AccountCategory,
  type AccountCategoryPolicy,
  accountCategory,
  DEFAULT_ACCOUNT_CATEGORY_POLICY,
} from "../contracts/account-categories";
import { decryptValue } from "./settings/crypto";

const prefix = "user.category.";

// Authorization reads the durable value directly. A stale settings cache must
// not re-enable a category after an operator has disabled it.
const readValue = async (key: string, fallback: boolean | string, db: typeof sql): Promise<boolean | string> => {
  const [row] = await db<{ value: string }[]>`SELECT value FROM settings.entries WHERE key = ${prefix + key}`;
  if (!row) return fallback;
  const value: unknown = await decryptValue(row.value);
  if (typeof value !== typeof fallback) throw new Error("Invalid account category configuration");
  if (typeof value !== "string" && typeof value !== "boolean") throw new Error("Invalid account category configuration");
  return value;
};

export const isAccountCategoryAllowed = async (
  user: { provider: "local" | "ipa"; profile: "guest" | "user" },
  db: typeof sql = sql,
): Promise<boolean> => (await readValue(`${accountCategory(user)}.enabled`, true, db)) === true;

export const readAccountCategoryPolicy = async (db: typeof sql = sql): Promise<AccountCategoryPolicy> => {
  const policy = structuredClone(DEFAULT_ACCOUNT_CATEGORY_POLICY);
  const rows = await db<
    { key: string; value: string }[]
  >`SELECT key, value FROM settings.entries WHERE key IN ('user.category.guest.enabled', 'user.category.guest.visible', 'user.category.login.enabled', 'user.category.login.visible', 'user.category.login.label', 'user.category.freeipa.enabled', 'user.category.freeipa.visible')`;
  const values = new Map(
    await Promise.all(rows.map(async (row) => [row.key.slice(prefix.length), await decryptValue(row.value)] as const)),
  );
  for (const category of ["guest", "login", "freeipa"] satisfies AccountCategory[]) {
    for (const field of ["enabled", "visible"] as const) {
      const key = `${category}.${field}`;
      if (!values.has(key)) continue;
      const value = values.get(key);
      if (typeof value !== "boolean") throw new Error("Invalid account category configuration");
      policy[category][field] = value;
    }
  }
  if (values.has("login.label")) {
    const label = values.get("login.label");
    if (typeof label !== "string") throw new Error("Invalid account category configuration");
    policy.login.label = label.trim() || "Login";
  }
  return policy;
};
