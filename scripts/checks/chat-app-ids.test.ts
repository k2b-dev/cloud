import { expect, test } from "bun:test";
import { checkSource } from "./chat-app-ids";

test("rejects app IDs, resource type prefixes and routes while allowing tests and fixtures", () => {
  const source =
    'const a = "spaces.item"; const b = `notebooks.${id}`; const c = "inventory"; const d = "/app/inventory/items"; const e = "unsupported spaces.item";';
  expect(checkSource("chat.ts", source, ["spaces", "notebooks", "inventory"])).toHaveLength(5);
  expect(checkSource("chat.test.ts", source, ["spaces"])).toEqual([]);
  expect(checkSource("chat.browser-fixture.ts", source, ["spaces"])).toEqual([]);
  expect(checkSource("chat.ts", 'const own = "chat"; const generic = ref.type;', ["chat", "spaces"])).toEqual([]);
});

test("allows the generic PWA layout value but not app IDs in layout properties", () => {
  expect(checkSource("chat.ts", 'const page = { layout: "pwa" };', ["pwa"])).toEqual([]);
  expect(checkSource("chat.ts", 'const page = { layout: "spaces" };', ["spaces"])).toHaveLength(1);
});

test("allows sentence punctuation and relative files whose names overlap app IDs", () => {
  expect(checkSource("chat.ts", 'const text = "Includes service accounts."; import page from "./pwa.page";', ["accounts", "pwa"])).toEqual(
    [],
  );
  expect(checkSource("chat.ts", 'const prefix = "spaces.";', ["spaces"])).toHaveLength(1);
});
