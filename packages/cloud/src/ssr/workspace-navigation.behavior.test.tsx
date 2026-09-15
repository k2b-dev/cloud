import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

test("SSR links work before hydration while local actions wait for their owner", async () => {
  const dom = createDomTestHarness();
  const { createNavigation } = await import("@k2b/ui");
  const { default: WorkspaceNavigationProvider } = await import("./WorkspaceNavigationProvider");
  const { observeWorkspaceNavigation, readWorkspaceNavigation } = await import("./workspace-navigation");
  dom.root.innerHTML =
    '<script data-cloud-workspace-navigation type="application/json">{"label":"App","items":[{"id":"link","label":"Link","href":"/app","action":"open"},{"id":"new","label":"New","action":"new"}]}</script>';
  const items = readWorkspaceNavigation()!.navigation.items();
  expect(items[0]?.disabled).toBe(false);
  expect(items[0]?.action).toBeUndefined();
  expect(items[1]?.disabled).toBe(true);
  dom.cleanup();
});

test("live snapshots update and old owner cleanup cannot remove a newer workspace", async () => {
  const dom = createDomTestHarness();
  const { createNavigation } = await import("@k2b/ui");
  const { default: WorkspaceNavigationProvider } = await import("./WorkspaceNavigationProvider");
  const { observeWorkspaceNavigation, readWorkspaceNavigation } = await import("./workspace-navigation");
  const other = dom.document.createElement("div");
  dom.document.body.append(other);
  const [badge, setBadge] = createSignal(1);
  let changes = 0;
  const stop = observeWorkspaceNavigation(() => changes++);
  const first = createNavigation({ items: () => [{ id: "inbox", label: "Inbox", href: "/inbox", badge: badge() }] });
  const disposeFirst = render(() => <WorkspaceNavigationProvider navigation={first} label="First" />, dom.root);
  await Bun.sleep(0);
  expect(readWorkspaceNavigation()?.navigation).toBe(first);
  setBadge(2);
  expect(readWorkspaceNavigation()?.navigation.items()[0]?.badge).toBe(2);
  expect(changes).toBeGreaterThan(1);
  const second = createNavigation({ items: () => [{ id: "second", label: "Second", href: "/second" }] });
  const disposeSecond = render(() => <WorkspaceNavigationProvider navigation={second} label="Second" />, other);
  await Bun.sleep(0);
  disposeFirst();
  expect(readWorkspaceNavigation()?.navigation).toBe(second);
  disposeSecond();
  expect(readWorkspaceNavigation()).toBeUndefined();
  stop();
  other.remove();
  dom.cleanup();
});
