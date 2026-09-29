import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { delegateEvents, render } from "solid-js/web";
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

test("before hydration an owner's folds only set where the menu's disclosure starts", async () => {
  const dom = createDomTestHarness();
  // Solid binds delegated clicks to the document of the first import, an earlier test's.
  delegateEvents(["click"], dom.document);
  const { Navigation } = await import("@k2b/ui");
  const { readWorkspaceNavigation } = await import("./workspace-navigation");
  const guide = {
    id: "guide",
    label: "Guide",
    href: "/guide",
    expanded: false,
    children: [{ id: "setup", label: "Setup", href: "/setup" }],
  };
  dom.root.innerHTML = `<script data-cloud-workspace-navigation type="application/json">${JSON.stringify({
    label: "Book",
    items: [{ id: "book", label: "Book", expanded: true, children: [guide] }],
  })}</script>`;
  const navigation = readWorkspaceNavigation()!.navigation;
  const [book] = navigation.items();
  expect([book?.expanded, book?.defaultExpanded]).toEqual([undefined, true]);
  expect([book?.children?.[0]?.expanded, book?.children?.[0]?.defaultExpanded]).toEqual([undefined, false]);
  const host = dom.document.createElement("div");
  dom.root.append(host);
  const dispose = render(() => <Navigation navigation={navigation} label="Book" />, host);
  try {
    const disclosure = host.querySelector<HTMLButtonElement>(".k2b-navigation__disclosure")!;
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    disclosure.click();
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  } finally {
    dispose();
    dom.cleanup();
  }
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
