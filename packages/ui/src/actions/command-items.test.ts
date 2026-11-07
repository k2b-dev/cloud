import { describe, expect, test } from "bun:test";
import { type CommandItem, filterCommandItems, groupCommandItems, resolveCommandSource } from "./command-items";

const noop = () => undefined;
const items: CommandItem[] = [
  { group: "Kinds", label: "Phone call", hint: "/telefonat", keywords: ["anruf"], onSelect: noop },
  { group: "Kinds", label: "Confirm appointment", hint: "/termin", disabled: "Only with an announcement", onSelect: noop },
  { group: "Snippets", label: "Photos requested", text: "Please send us a few photos." },
  { group: "Actions", label: "Zuständig ändern", keywords: ["Straße"], onSelect: noop },
  { group: "Kinds", label: "Internal note", onSelect: noop },
];
const labels = (list: readonly CommandItem[]) => list.map((item) => item.label);

describe("command items", () => {
  test("a blank query keeps every entry in its order", () => {
    expect(filterCommandItems(items, "  ")).toBe(items);
  });

  test("label, hint without its slash, and keywords find an entry", () => {
    expect(labels(filterCommandItems(items, "phone"))).toEqual(["Phone call"]);
    expect(labels(filterCommandItems(items, "telef"))).toEqual(["Phone call"]);
    expect(labels(filterCommandItems(items, "ANRUF"))).toEqual(["Phone call"]);
  });

  test("matching ignores accents and accepts the spelled-out umlaut", () => {
    for (const query of ["zuständig", "zustandig", "zustaendig", "Zustaendig aendern", "strasse", "straße"]) {
      expect(labels(filterCommandItems(items, query))).toEqual(["Zuständig ändern"]);
    }
  });

  test("every word of the query has to match", () => {
    expect(labels(filterCommandItems(items, "photos req"))).toEqual(["Photos requested"]);
    expect(filterCommandItems(items, "photos call")).toEqual([]);
  });

  test("unavailable entries stay findable", () => {
    expect(labels(filterCommandItems(items, "termin"))).toEqual(["Confirm appointment"]);
  });

  test("groups keep the order they first appear in and number entries as shown", () => {
    const groups = groupCommandItems(items);
    expect(groups.map((group) => group.label)).toEqual(["Kinds", "Snippets", "Actions"]);
    expect(groups[0]!.entries.map((entry) => [entry.item.label, entry.index])).toEqual([
      ["Phone call", 0],
      ["Confirm appointment", 1],
      ["Internal note", 2],
    ]);
    expect(groups[2]!.entries[0]!.index).toBe(4);
  });

  test("a function source filters itself", () => {
    const seen: string[] = [];
    const source = (query: string) => {
      seen.push(query);
      return items.slice(0, 1);
    };
    expect(labels(resolveCommandSource(source, "xyz"))).toEqual(["Phone call"]);
    expect(seen).toEqual(["xyz"]);
  });

  test("an entry changed in place is found by its new words", () => {
    const entry: CommandItem = { label: "Alpha", onSelect: noop };
    expect(filterCommandItems([entry], "alpha")).toHaveLength(1);
    entry.label = "Beta";
    expect(filterCommandItems([entry], "alpha")).toHaveLength(0);
    expect(filterCommandItems([entry], "beta")).toHaveLength(1);
  });
});
