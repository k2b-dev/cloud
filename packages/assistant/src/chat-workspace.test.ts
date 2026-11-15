import { expect, test } from "bun:test";
import { createPanesLayout } from "@k2b/ui";
import { type ChatWorkspaceState, ChatWorkspaceStateSchema, SaveChatWorkspaceSchema } from "./chat-workspace";

const tab = (id: string) => ({ id, key: JSON.stringify({ file: `/${id}.md` }), title: id });
const workspace = (): ChatWorkspaceState => ({
  tabs: [tab("tab_a"), { ...tab("tab_b"), pinned: true }],
  layout: createPanesLayout(["tab_a", "tab_b"]),
  front: "tab_b",
});

test("valid workspace keeps opaque keys, layout and front tab", () => {
  const state = workspace();
  expect(ChatWorkspaceStateSchema.parse(state)).toEqual(state);
  expect(ChatWorkspaceStateSchema.parse({ tabs: [], layout: null, front: null })).toEqual({ tabs: [], layout: null, front: null });
  expect(ChatWorkspaceStateSchema.safeParse({ ...state, layout: null }).success).toBe(true);
  expect(
    ChatWorkspaceStateSchema.safeParse({
      ...state,
      layout: {
        version: 2,
        root: {
          type: "split",
          direction: "horizontal",
          ratio: 0.5,
          first: { type: "group", items: ["tab_a"], active: "tab_a" },
          second: { type: "group", items: ["tab_b"], active: "tab_b" },
        },
      },
    }).success,
  ).toBe(true);
  expect(
    ChatWorkspaceStateSchema.safeParse({
      ...state,
      tabs: [{ ...tab("short"), key: "k".repeat(600), title: "" }],
      layout: null,
      front: null,
    }).success,
  ).toBe(true);
});

test("at most 24 tabs", () => {
  const state = { tabs: Array.from({ length: 24 }, (_, i) => tab(`tab_${i}`)), layout: null, front: null };
  expect(ChatWorkspaceStateSchema.safeParse(state).success).toBe(true);
  expect(ChatWorkspaceStateSchema.safeParse({ ...state, tabs: [...state.tabs, tab("extra")] }).success).toBe(false);
});

test("layout ids must exactly match open tab ids", () => {
  expect(ChatWorkspaceStateSchema.safeParse({ ...workspace(), layout: createPanesLayout(["unknown"]) }).success).toBe(false);
  expect(ChatWorkspaceStateSchema.safeParse({ ...workspace(), layout: createPanesLayout(["tab_a"]) }).success).toBe(false);
  expect(ChatWorkspaceStateSchema.safeParse({ ...workspace(), layout: createPanesLayout([]) }).success).toBe(false);
});

test("duplicate ids and duplicate opaque keys are rejected", () => {
  const a = tab("tab_a");
  expect(ChatWorkspaceStateSchema.safeParse({ tabs: [a, { ...a, key: "different" }], layout: null, front: null }).success).toBe(false);
  expect(ChatWorkspaceStateSchema.safeParse({ tabs: [a, { ...a, id: "tab_b" }], layout: null, front: null }).success).toBe(false);
});

test("front must name an open tab id", () => {
  expect(ChatWorkspaceStateSchema.safeParse({ ...workspace(), front: "missing" }).success).toBe(false);
  expect(ChatWorkspaceStateSchema.safeParse({ ...workspace(), front: tab("tab_b").key }).success).toBe(false);
});

test("invalid Panes layouts are rejected", () => {
  for (const layout of [
    undefined,
    {},
    { version: 1, root: null },
    { version: 2, root: { type: "group", items: ["tab_a", "tab_a"], active: "tab_a" } },
    {
      version: 2,
      root: {
        type: "split",
        direction: "horizontal",
        ratio: 0.5,
        first: { type: "group", items: ["tab_a"], active: "tab_a" },
        second: { type: "group", items: ["tab_a"], active: "tab_a" },
      },
    },
  ])
    expect(ChatWorkspaceStateSchema.safeParse({ ...workspace(), layout }).success).toBe(false);
});

test("tab field bounds and stable id characters are validated", () => {
  for (const invalid of [
    { id: "" },
    { id: "a".repeat(161) },
    { id: "tab/invalid" },
    { key: "" },
    { key: "k".repeat(601) },
    { title: "t".repeat(201) },
  ])
    expect(ChatWorkspaceStateSchema.safeParse({ tabs: [{ ...tab("tab_a"), ...invalid }], layout: null, front: null }).success).toBe(false);
});

test("serialized state is limited to 32 KiB of UTF-8, including JSON escapes", () => {
  const state = {
    tabs: Array.from({ length: 24 }, (_, i) => ({ id: `tab_${i}`, key: `${i}${"界".repeat(590)}`, title: "t".repeat(200) })),
    layout: null,
    front: null,
  };
  expect(JSON.stringify(state).length).toBeLessThan(32 * 1024);
  expect(ChatWorkspaceStateSchema.safeParse(state).success).toBe(false);
  const escaped = { ...state, tabs: state.tabs.map((entry) => ({ ...entry, key: `${entry.id}${"\u0000".repeat(590)}` })) };
  expect(ChatWorkspaceStateSchema.safeParse(escaped).success).toBe(false);
});

test("revision is a nonnegative safe integer", () => {
  for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
    expect(SaveChatWorkspaceSchema.safeParse({ state: workspace(), revision }).success).toBe(false);
  expect(SaveChatWorkspaceSchema.safeParse({ state: workspace(), revision: 0 }).success).toBe(true);
});

test("stored web tabs accept only absolute HTTP and HTTPS addresses", () => {
  const state = (url: string) => ({
    tabs: [{ id: "web", key: JSON.stringify(["web", "chat", url]), title: "Page" }],
    layout: null,
    front: "web",
  });
  for (const url of [
    "javascript:void(0)",
    "data:text/plain,hello",
    "file:///a",
    "/relative",
    "https://",
    "https://user:pass@example.test/",
  ])
    expect(ChatWorkspaceStateSchema.safeParse(state(url)).success).toBe(false);
  for (const url of ["http://example.test/", "https://example.test/", "HTTPS://example.test/"])
    expect(ChatWorkspaceStateSchema.safeParse(state(url)).success).toBe(true);
});
