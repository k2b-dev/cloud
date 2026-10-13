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

test("an inline action sits in its row as a square icon button and waits for its owner", async () => {
  const dom = createDomTestHarness();
  delegateEvents(["click"], dom.document);
  const { createNavigation, Navigation } = await import("@k2b/ui");
  const { readWorkspaceNavigation } = await import("./workspace-navigation");
  const compose = {
    id: "compose",
    label: "Compose",
    href: "/compose",
    inlineActions: [{ id: "details", label: "Mailbox details", icon: "ti ti-info-circle", action: "details" }],
  };
  const host = dom.document.createElement("div");
  dom.root.append(host);
  const actions: string[] = [];
  const [loading, setLoading] = createSignal(false);
  const owned = createNavigation({
    items: () => [{ ...compose, inlineActions: compose.inlineActions.map((action) => ({ ...action, disabled: loading() })) }],
    onAction: (action) => void actions.push(action),
  });
  const dispose = render(() => <Navigation navigation={owned} label="Mail" />, host);
  try {
    const row = host.querySelector(".k2b-navigation__row")!;
    const button = row.querySelector<HTMLButtonElement>(".k2b-navigation__inline-action")!;
    // The action shares the destination's row instead of hiding in the row menu.
    expect(row.querySelector(".k2b-navigation__control")?.textContent).toBe("Compose");
    expect(button.getAttribute("aria-label")).toBe("Mailbox details");
    expect(button.querySelector("i")?.className).toBe("ti ti-info-circle");
    expect(row.querySelector("[aria-haspopup]")).toBeNull();
    button.click();
    await Bun.sleep(0);
    expect(actions).toEqual(["details"]);
    // A model update keeps the button, and with it keyboard focus.
    setLoading(true);
    expect(row.querySelector(".k2b-navigation__inline-action")).toBe(button);
    expect(button.disabled).toBe(true);
  } finally {
    dispose();
  }

  // Before the owner hydrates, the server snapshot keeps the link and disables the action it cannot run yet.
  dom.root.innerHTML = `<script data-cloud-workspace-navigation type="application/json">${JSON.stringify({ label: "Mail", items: [compose] })}</script>`;
  const [snapshot] = readWorkspaceNavigation()!.navigation.items();
  expect(snapshot?.disabled).toBe(false);
  expect(snapshot?.inlineActions?.[0]?.disabled).toBe(true);
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

test("the snapshot keeps only the switcher's presentation before its owner takes over", async () => {
  const dom = createDomTestHarness();
  const { createNavigation, Navigation } = await import("@k2b/ui");
  const { default: WorkspaceNavigationProvider } = await import("./WorkspaceNavigationProvider");
  const { readWorkspaceNavigation } = await import("./workspace-navigation");
  const presentation = {
    currentId: "team",
    label: "Team </script> notebook",
    description: "Shared notes",
    icon: "ti ti-notebook",
    color: "#123456",
    switchLabel: "Switch notebook",
  };
  const owned = createNavigation({
    items: () => [{ id: "notes", label: "Notes", href: "/notes" }],
    switcher: () => ({
      ...presentation,
      options: [{ id: "team", label: presentation.label, href: "/team" }],
      actions: [{ id: "new", label: "New notebook", icon: "ti-plus", action: () => {} }],
      onLoad: () => {},
      error: "An old error",
      class: "flex-1",
    }),
  });
  const dispose = render(() => <WorkspaceNavigationProvider navigation={owned} label="Notes" />, dom.root);
  let disposeMenu = () => {};
  try {
    const script = dom.root.querySelector("script")!;
    expect(script.textContent).not.toContain("</script>");
    expect(JSON.parse(script.textContent ?? "")).toEqual({ label: "Notes", items: owned.items(), switcher: presentation });
    delete window.__cloudWorkspaceNavigation;
    const snapshot = readWorkspaceNavigation()!;
    expect(snapshot.navigation.switcher?.()).toEqual(presentation);
    expect(snapshot.navigation.switcher?.().options).toBeUndefined();
    expect(snapshot.navigation.switcher?.().actions).toBeUndefined();
    expect(snapshot.navigation.switcher?.().onLoad).toBeUndefined();
    const [navigation, setNavigation] = createSignal(snapshot.navigation);
    const host = dom.document.createElement("div");
    dom.root.append(host);
    disposeMenu = render(() => <Navigation navigation={navigation()} label="Notes" />, host);
    const before = host.querySelector(".k2b-sidebar-switcher__trigger")!;
    const head = before.outerHTML;
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Loading...");
    expect(host.querySelector("nav")?.firstElementChild?.classList.contains("k2b-sidebar-switcher")).toBe(true);
    setNavigation(owned);
    expect(host.querySelectorAll(".k2b-sidebar-switcher__trigger")).toHaveLength(1);
    const after = host.querySelector(".k2b-sidebar-switcher__trigger")!;
    expect(after.getAttribute("aria-label")).toBe(before.getAttribute("aria-label"));
    // Each render owns its IDs; the visible head keeps the same content.
    expect(after.outerHTML.replace(/k2b-sidebar-switcher-[\w-]+/g, "switcher-id")).toBe(
      head.replace(/k2b-sidebar-switcher-[\w-]+/g, "switcher-id"),
    );
    expect(host.textContent).not.toContain("Loading...");
  } finally {
    disposeMenu();
    dispose();
    dom.cleanup();
  }
});

test("a snapshot without a switcher adds no head", async () => {
  const dom = createDomTestHarness();
  const { createNavigation, Navigation } = await import("@k2b/ui");
  const { default: WorkspaceNavigationProvider } = await import("./WorkspaceNavigationProvider");
  const { readWorkspaceNavigation } = await import("./workspace-navigation");
  const navigation = createNavigation({ items: () => [{ id: "notes", label: "Notes", href: "/notes" }] });
  const dispose = render(() => <WorkspaceNavigationProvider navigation={navigation} label="Notes" />, dom.root);
  let disposeMenu = () => {};
  try {
    expect(JSON.parse(dom.root.querySelector("script")?.textContent ?? "")).toEqual({ label: "Notes", items: navigation.items() });
    delete window.__cloudWorkspaceNavigation;
    const snapshot = readWorkspaceNavigation()!;
    expect(snapshot.navigation.switcher).toBeUndefined();
    const host = dom.document.createElement("div");
    dom.root.append(host);
    disposeMenu = render(() => <Navigation navigation={snapshot.navigation} label="Notes" />, host);
    expect(host.querySelector(".k2b-sidebar-switcher")).toBeNull();
    expect(host.querySelector("a")?.getAttribute("href")).toBe("/notes");
  } finally {
    disposeMenu();
    dispose();
    dom.cleanup();
  }
});

test("invalid switcher fields are ignored without dropping the navigation", async () => {
  const dom = createDomTestHarness();
  const { readWorkspaceNavigation } = await import("./workspace-navigation");
  const valid = { currentId: "team", label: "Team", icon: "ti-notebook", switchLabel: "Switch notebook" };
  try {
    const invalid = [
      null,
      [],
      "Team",
      {},
      ...Object.keys(valid).map((key) => ({ ...valid, [key]: 42 })),
      { ...valid, description: false },
      { ...valid, color: {} },
      { ...valid, description: null },
    ];
    for (const switcher of invalid) {
      dom.root.innerHTML = `<script data-cloud-workspace-navigation type="application/json">${JSON.stringify({
        label: "Notes",
        items: [{ id: "notes", label: "Notes", href: "/notes" }],
        switcher,
      })}</script>`;
      const snapshot = readWorkspaceNavigation()!;
      expect(snapshot.label).toBe("Notes");
      expect(snapshot.navigation.items()).toHaveLength(1);
      expect(snapshot.navigation.switcher).toBeUndefined();
    }
    dom.root.innerHTML = `<script data-cloud-workspace-navigation type="application/json">${JSON.stringify({
      items: [],
      switcher: { ...valid, options: [{ id: "hidden", label: "Hidden", href: "/hidden" }], actions: [], onLoad: "load" },
    })}</script>`;
    expect(readWorkspaceNavigation()?.navigation.switcher?.()).toEqual(valid);
  } finally {
    dom.cleanup();
  }
});
