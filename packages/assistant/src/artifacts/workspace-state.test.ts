import { expect, test } from "bun:test";
import {
  appTab,
  closeWorkspaceTab,
  contextTab,
  fileTab,
  openWorkspaceTab,
  sourceTab,
  taskTab,
  webTab,
  workspaceSelectionFromHref,
  workspaceSelectionHref,
  workspaceTabFromKey,
  workspaceTabId,
} from "./workspace-state";

test("opening the same resource activates its existing tab without recreating peers", () => {
  const first = fileTab("chat-one", "/input.csv");
  let state = openWorkspaceTab({ tabs: [], active: null }, first);
  state = openWorkspaceTab(state, appTab("app-id", "Analysis"));
  state = openWorkspaceTab(state, fileTab("chat-one", "/input.csv"));
  expect(state.tabs).toHaveLength(2);
  expect(state.active).toBe(first.key);
  expect(openWorkspaceTab(state, fileTab("chat-two", "/input.csv")).tabs).toHaveLength(3);
});
test("closing selects a neighbor and never changes the resource identity", () => {
  const first = appTab("one", "One"),
    second = appTab("two", "Two");
  const state = closeWorkspaceTab({ tabs: [first, second], active: second.key }, second.key);
  expect(state).toEqual({ tabs: [first], active: first.key });
  expect(closeWorkspaceTab(state, first.key)).toEqual({ tabs: [], active: null });
});
test("URL selection preserves conversation and encodes file identity without execution state", () => {
  for (const tab of [
    taskTab("task01", "task01"),
    fileTab("chat", "/report name.csv"),
    sourceTab("app", "main.ts"),
    appTab("app", "app"),
    contextTab("chat", "apps", "apps"),
  ]) {
    const href = workspaceSelectionHref("/app/assistant?conversation=chat", tab);
    expect(href).toContain("conversation=chat");
    expect(workspaceSelectionFromHref(href)).toEqual(tab);
  }
  expect(workspaceSelectionFromHref("/app/assistant?workspace=broken")).toBeNull();
});

test("a tab has a stable Panes id, and stored keys open again, also the reading view and the context tab", () => {
  const web = webTab("chat-one", "https://paketdienst.example/versand/frankreich", "Versand nach Frankreich")!;
  expect(workspaceTabId(web.key)).toMatch(/^[a-z][a-z0-9_-]*$/);
  expect(workspaceTabId(web.key)).toBe(workspaceTabId(webTab("chat-one", "https://paketdienst.example/versand/frankreich")!.key));
  expect(workspaceTabId(web.key)).not.toBe(workspaceTabId(fileTab("chat-one", "/a.pdf").key));
  expect(workspaceTabFromKey(web.key, "Versand nach Frankreich")).toMatchObject({ kind: "web", url: web.kind === "web" ? web.url : "" });
  expect(workspaceTabFromKey(contextTab("chat-one", "context", "Kontext").key, "")).toMatchObject({ kind: "context", category: "context" });
  const shown = workspaceTabFromKey(JSON.stringify(["presentation", "chat-one", "00000000-0000-4000-8000-000000000009"]), "Lieferavise");
  expect(shown).toMatchObject({ kind: "presentation", presentationId: "00000000-0000-4000-8000-000000000009", title: "Lieferavise" });
  // Only web addresses open as a reading view.
  expect(workspaceTabFromKey(JSON.stringify(["web", "chat-one", "javascript:alert(1)"]), "")).toBeNull();
  expect(workspaceTabFromKey("not json", "")).toBeNull();
});

test("web tabs accept only absolute HTTP and HTTPS addresses", () => {
  for (const url of [
    "javascript:void(0)",
    "data:text/plain,hello",
    "file:///a",
    "mailto:a@example.test",
    "/relative",
    "https://",
    "https://user:pass@example.test/",
  ]) {
    expect(webTab("chat-one", url)).toBeNull();
    expect(workspaceTabFromKey(JSON.stringify(["web", "chat-one", url]), "")).toBeNull();
  }
  for (const url of ["http://example.test/a", "https://example.test/a", "HTTPS://example.test/a"]) {
    expect(webTab("chat-one", url)).toMatchObject({ kind: "web", url });
    expect(workspaceTabFromKey(JSON.stringify(["web", "chat-one", url]), "")).toMatchObject({ kind: "web", url });
  }
});
