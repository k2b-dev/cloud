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

for (const source of [
  'const route = "/app/spaces";',
  'const type = "spaces:item";',
  "const view = <span>spaces.item</span>;",
  "const pattern = /spaces\\.item/;",
  'const route = "/app/spaces?view=all";',
])
  test(`rejects app references in ${source}`, () => {
    expect(checkSource("chat.tsx", source, ["spaces"])).toHaveLength(1);
  });

test("allows common words but rejects their qualified app references", () => {
  const apps = ["mail", "tools", "core", "contacts", "assistant"];
  for (const app of apps) {
    expect(checkSource("chat.ts", `const label = "${app}";`, apps)).toEqual([]);
    expect(checkSource("chat.ts", `const type = "${app}.item";`, apps)).toHaveLength(1);
    expect(checkSource("chat.ts", `const route = "/app/${app}";`, apps)).toHaveLength(1);
  }
});

test("allows shared platform imports, API services and the app's PWA route", () => {
  const source = 'import { caller } from "@k2b/cloud/capabilities/server"; const url = "/api/accounts/entities"; const pwa = "/pwa/chat";';
  expect(checkSource("chat.ts", source, ["capabilities", "accounts", "pwa"])).toEqual([]);
});
