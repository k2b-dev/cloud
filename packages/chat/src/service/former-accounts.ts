import { toPgUuidArray } from "@k2b/cloud/services";
import type { sql } from "bun";

/** The accounts among `ids` that no longer exist; Chat shows them as "Former account" wherever it names them. */
export const deletedPeople = async (db: typeof sql, ids: string[], type: "user" | "service_account" = "user") => {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Set<string>();
  const found =
    type === "user"
      ? await db<{ id: string }[]>`SELECT id FROM auth.users WHERE id = ANY(${toPgUuidArray(unique)}::uuid[])`
      : await db<{ id: string }[]>`SELECT id FROM auth.service_accounts WHERE id = ANY(${toPgUuidArray(unique)}::uuid[])`;
  const existing = new Set(found.map((row) => row.id));
  return new Set(unique.filter((id) => !existing.has(id)));
};
