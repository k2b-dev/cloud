import { expect, test } from "bun:test";
import { RailAdminInputSchema, RailAdminSchema } from "./rail-admin";

test("write budgets cover configuration rather than mutable identity display metadata", () => {
  const entry = {
    shortcut: { id: "one", kind: "app", appId: "mail" },
    access: [
      {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        principal: { type: "authenticated" },
        permission: "read",
        displayName: "x".repeat(17000),
      },
    ],
  };
  const state = RailAdminSchema.parse({ revision: 1, entries: [entry] });
  const input = RailAdminInputSchema.parse(state);
  expect(input.entries[0]?.access[0]).toEqual({ principal: { type: "authenticated" }, permission: "read" });
  expect(state.entries[0]?.access[0]?.displayName).toHaveLength(17000);
  expect(RailAdminInputSchema.safeParse({ ...input, entries: [entry, entry] }).success).toBe(false);
  expect(
    RailAdminInputSchema.safeParse({
      ...input,
      entries: Array.from({ length: 500 }, (_, i) => ({ ...entry, shortcut: { ...entry.shortcut, id: `app-${i}` } })),
    }).success,
  ).toBe(false);
});
