import { expect, test } from "bun:test";
import { RAIL_PREFERENCES_MAX_BYTES, RailPreferencesSchema, RailSnapshotSchema } from "./rail-preferences";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Settings without `showNames` whose size at the highest revision is exactly the page budget. */
const savedAtBudget = () => {
  const value = { revision: 2_147_483_647, visibility: {} as Record<string, boolean>, shortcuts: [] };
  // Each entry `"<key>":false,` costs its key length plus 9 bytes; keys are at most 120 characters.
  for (let index = 0; bytes(value) + 125 < RAIL_PREFERENCES_MAX_BYTES; index += 1)
    value.visibility[`app-${index}-`.padEnd(110, "x")] = false;
  const rest = RAIL_PREFERENCES_MAX_BYTES - bytes(value) - 9;
  value.visibility["last-".padEnd(rest, "x")] = false;
  return value;
};

test("settings saved at the page budget before the names flag existed still load, with names on", () => {
  const legacy = savedAtBudget();
  expect(bytes(legacy)).toBe(RAIL_PREFERENCES_MAX_BYTES);
  expect(RailPreferencesSchema.parse(legacy).showNames).toBe(true);
  expect(RailPreferencesSchema.safeParse({ ...legacy, showNames: false }).success).toBe(true);
  expect(RailSnapshotSchema.parse({ ...legacy, managedShortcuts: [] }).showNames).toBe(true);
  // One more byte of choices is still over the budget.
  expect(RailPreferencesSchema.safeParse({ ...legacy, visibility: { ...legacy.visibility, a: false } }).success).toBe(false);
});
