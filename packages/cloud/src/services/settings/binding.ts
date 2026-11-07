import { createHash } from "node:crypto";
import { z } from "zod";
import { SETTINGS, SETTINGS_MAP } from "./defaults";

const envelope = z.object({ value: z.unknown(), bindings: z.record(z.string(), z.string()) });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const settingOwners = (key: string) => SETTINGS.filter((def) => def.resetOnChange?.includes(key));

/** Bind the value inside its encrypted row; no independently writable marker. */
export const bindSettingValue = async (key: string, value: unknown, resolve: (key: string) => Promise<unknown>): Promise<unknown> => {
  const owners = settingOwners(key);
  if (!owners.length) return value;
  const bindings: Record<string, string> = {};
  for (const owner of owners) bindings[owner.key] = hash(await resolve(owner.key));
  return { value, bindings };
};

export const unwrapSettingValue = (key: string, raw: unknown): unknown => {
  if (!settingOwners(key).length) return raw;
  const parsed = envelope.safeParse(raw);
  return parsed.success ? parsed.data.value : raw;
};

export const replaceSettingValue = (key: string, raw: unknown, value: unknown): unknown => {
  if (!settingOwners(key).length) return value;
  const parsed = envelope.safeParse(raw);
  return parsed.success ? { ...parsed.data, value } : value;
};

/** Missing or stale bindings require a new value, including legacy unbound rows. */
export const resolveBoundSetting = async (
  key: string,
  raw: unknown,
  resolve: (key: string) => Promise<unknown>,
): Promise<{ value: unknown; mismatch: boolean }> => {
  const owners = settingOwners(key);
  const fallback = SETTINGS_MAP.get(key)?.default;
  if (!owners.length) return { value: raw, mismatch: false };
  const parsed = envelope.safeParse(raw);
  if (!parsed.success) return { value: fallback, mismatch: true };
  for (const owner of owners) {
    if (parsed.data.bindings[owner.key] !== hash(await resolve(owner.key))) return { value: fallback, mismatch: true };
  }
  return { value: parsed.data.value, mismatch: false };
};
