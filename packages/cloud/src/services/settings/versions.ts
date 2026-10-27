import { sql } from "bun";
import { ConfigConflict } from "../config-conflict";
import { SETTINGS_MAP } from "./defaults";
import { readKeyState } from "./store";

/** Lock missing keys as well as existing rows, so first writes have the same conflict guarantee. */
export const assertSettingVersions = async (expected: Record<string, string | null>, db = sql): Promise<void> => {
  for (const key of Object.keys(expected).sort()) {
    await db`SELECT pg_advisory_xact_lock(hashtext(${`settings:${key}`}))`;
    const [row] = await db<
      { updated_at: Date; updated_by: string | null }[]
    >`SELECT updated_at,updated_by FROM settings.entries WHERE key=${key} FOR UPDATE`;
    if ((row?.updated_at.toISOString() ?? null) === expected[key]) continue;
    const [who] = row?.updated_by
      ? await db<
          { id: string; name: string }[]
        >`SELECT id,COALESCE(NULLIF(display_name,''),uid) AS name FROM auth.users WHERE id=${row.updated_by}::uuid`
      : [];
    throw new ConfigConflict(
      SETTINGS_MAP.get(key)?.kind === "secret" ? "" : (await readKeyState(key, db)).value,
      who ?? null,
      row?.updated_at.toISOString() ?? new Date(0).toISOString(),
      key,
    );
  }
};
