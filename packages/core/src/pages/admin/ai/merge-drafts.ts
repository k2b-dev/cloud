export const DEFAULT_CONFLICT_CHOICE = "mine";

const same = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/** Fields both sides changed to different values; everything else merges on its own. */
export const conflictingFields = <T extends Record<string, unknown>>(base: T, mine: T, theirs: T, fields: readonly (keyof T)[]) =>
  fields.filter((field) => !same(mine[field], base[field]) && !same(theirs[field], base[field]) && !same(mine[field], theirs[field]));

/** Their stored version plus my changes; `choices` decides each field both changed. */
export const mergeDrafts = <T extends Record<string, unknown>>(
  base: T,
  mine: T,
  theirs: T,
  fields: readonly (keyof T)[],
  choices: Partial<Record<keyof T, "mine" | "theirs">>,
): T => {
  const merged = { ...theirs };
  for (const field of fields) {
    if (same(mine[field], base[field])) continue;
    const both = !same(theirs[field], base[field]) && !same(mine[field], theirs[field]);
    if (!both || (choices[field] ?? DEFAULT_CONFLICT_CHOICE) === "mine") merged[field] = mine[field];
  }
  return merged;
};
