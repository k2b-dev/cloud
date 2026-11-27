import { expect, test } from "bun:test";
import { findTools } from "./catalog-search";
import { resolveRegistry } from "./tools/registry";

const registry = resolveRegistry("de");
const find = (search: string) => findTools(search, registry.tools, registry.searchText).map((tool) => tool.id);

test("a search finds the tools whose text holds every word, not every tool with a few of its letters", () => {
  expect(find("uuid")).toEqual(["uuid"]);
  expect(find("qr code")).toEqual(["qr"]);
  expect(find("  ")).toHaveLength(registry.tools.length);
});

test("a typo still finds its tool through the fuzzy matches", () => {
  expect(find("pasword")[0]).toBe("password");
});

test("a search without any match finds nothing", () => {
  expect(find("zzzzzzzzzzzz")).toEqual([]);
});
