import { describe, expect, test } from "bun:test";
import { BaseNavigationSchema, navigationReferenceKey, visibleNavigationGroups } from "./navigation-contracts";
import { navigationMessages } from "./navigation-messages";

const group = { id: "GROUP1", name: "Finance", entries: [{ type: "view" as const, id: "VIEW01" }] };
describe("shared base navigation contract", () => {
  test("keeps references flat, typed and public; duplicate entries and groups are rejected", () => {
    expect(BaseNavigationSchema.safeParse({ revision: 0, groups: [group] }).success).toBe(true);
    for (const groups of [
      [group, group],
      [{ ...group, entries: [...group.entries, ...group.entries] }],
      [{ ...group, entries: [{ type: "table", id: "Unknown record" }] }],
      [{ ...group, children: [] }],
    ])
      expect(BaseNavigationSchema.safeParse({ revision: 0, groups }).success).toBe(false);
    expect(BaseNavigationSchema.safeParse({ revision: 0, groups: [group, { ...group, id: "GROUP2" }] }).success).toBe(true);
  });
  test("bounds configuration by bytes, including multibyte names", () => {
    const groups = Array.from({ length: 200 }, (_, i) => ({ ...group, id: i.toString().padStart(6, "0"), name: "界".repeat(200) }));
    expect(BaseNavigationSchema.safeParse({ revision: 0, groups }).success).toBe(false);
  });
  test("redacts invisible references and empty groups without modifying shared configuration", () => {
    expect(visibleNavigationGroups([group], new Set())).toEqual([]);
    expect(visibleNavigationGroups([group], new Set([navigationReferenceKey(group.entries[0]!)]))).toEqual([group]);
    expect(group.entries.length).toBe(1);
  });
  test("has matching English and German messages", () => expect(navigationMessages.check()).toEqual([]));
});
