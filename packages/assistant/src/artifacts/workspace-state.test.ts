import { expect, test } from "bun:test";
import { taskTab, appTab, contextTab, fileTab, sourceTab, openWorkspaceTab, closeWorkspaceTab, workspaceSelectionFromHref, workspaceSelectionHref } from "./workspace-state";

test("opening the same resource activates its existing tab without recreating peers", () => {
  const first = fileTab("chat-one","/input.csv");
  let state = openWorkspaceTab({ tabs: [],active: null },first);
  state = openWorkspaceTab(state,appTab("app-id","Analysis"));
  state = openWorkspaceTab(state,fileTab("chat-one","/input.csv"));
  expect(state.tabs).toHaveLength(2);
  expect(state.active).toBe(first.key);
  expect(openWorkspaceTab(state,fileTab("chat-two","/input.csv")).tabs).toHaveLength(3);
});
test("closing selects a neighbor and never changes the resource identity", () => {
  const first = appTab("one","One"), second = appTab("two","Two");
  const state = closeWorkspaceTab({ tabs: [first,second],active: second.key },second.key);
  expect(state).toEqual({ tabs: [first],active: first.key });
  expect(closeWorkspaceTab(state,first.key)).toEqual({ tabs: [],active: null });
});
test("URL selection preserves conversation and encodes file identity without execution state", () => {
  for (const tab of [taskTab("task01", "task01"),fileTab("chat","/report name.csv"),sourceTab("app","main.ts"),appTab("app","app"), contextTab("chat", "apps", "apps")]) {
    const href = workspaceSelectionHref("/app/assistant?conversation=chat",tab);
    expect(href).toContain("conversation=chat");
    expect(workspaceSelectionFromHref(href)).toEqual(tab);
  }
  expect(workspaceSelectionFromHref("/app/assistant?workspace=broken")).toBeNull();
});
