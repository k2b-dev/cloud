import { resolveDisplayNames } from "@k2b/cloud/server";

/**
 * The names of the people who created an app's keys, by user id, in one statement for all of them. A creator whose
 * account is gone has no name, and the keys view leaves the name out.
 */
export const keyCreatorNames = async (keys: readonly { createdBy: string | null }[]): Promise<Record<string, string>> => {
  const ids = [...new Set(keys.flatMap((key) => (key.createdBy ? [key.createdBy] : [])))];
  if (ids.length === 0) return {};
  const entries = await resolveDisplayNames(ids.map((userId) => ({ principal: { type: "user" as const, userId } })));
  return Object.fromEntries(
    entries.flatMap((entry) => (entry.principal.type === "user" && entry.displayName ? [[entry.principal.userId, entry.displayName]] : [])),
  );
};
