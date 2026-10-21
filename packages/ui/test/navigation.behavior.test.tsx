import { describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { delegateEvents, render } from "solid-js/web";
import { createNavigation, type NavigationItem } from "../src/layout/navigation-model";
import { createDomTestHarness } from "./dom";

test("container context updates in place without selecting or disabling a destination", async () => {
  const dom = createDomTestHarness();
  const { default: Navigation } = await import("../src/layout/Navigation");
  const [current, setCurrent] = createSignal("project");
  const actions: string[] = [];
  const navigation = createNavigation({
    items: () => [
      {
        id: "project",
        label: "Project",
        href: "/project",
        context: current() === "project",
        children: [{ id: "work", label: "Work", href: "/project/work", active: current() === "project" }],
      },
      { id: "other", label: "Other", action: "other", context: current() === "other" },
      { id: "help", label: "Help", href: "/help" },
    ],
    onAction: (action) => {
      actions.push(action);
      setCurrent(action);
    },
  });
  delegateEvents(["click"], dom.document);
  const dispose = render(() => <Navigation navigation={navigation} label="Projects" />, dom.root);
  try {
    const project = dom.root.querySelector<HTMLAnchorElement>('a[href="/project"]')!;
    const work = dom.root.querySelector<HTMLAnchorElement>('a[href="/project/work"]')!;
    const other = Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find((row) => row.textContent === "Other")!;
    const help = dom.root.querySelector<HTMLAnchorElement>('a[href="/help"]')!;
    expect(project.parentElement!.dataset.context).toBe("true");
    expect(project.hasAttribute("aria-current")).toBe(false);
    expect(work.getAttribute("aria-current")).toBe("page");
    expect(work.parentElement!.hasAttribute("data-context")).toBe(false);
    expect(help.parentElement!.hasAttribute("data-context")).toBe(false);
    expect(other.parentElement!.dataset.context).toBe("false");
    expect(other.disabled).toBe(false);
    other.focus();
    other.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(actions).toEqual(["other"]);
    expect(project.parentElement!.dataset.context).toBe("false");
    expect(other.parentElement!.dataset.context).toBe("true");
    expect(dom.document.activeElement).toBe(other);
    expect(work.hasAttribute("aria-current")).toBe(false);
  } finally {
    dispose();
    dom.cleanup();
  }
});

describe("Navigation", () => {
  test("keeps row focus across snapshots and performs actions only after host dismissal", async () => {
    const dom = createDomTestHarness();
    // Importing a cached component does not register its delegated click on a new document.
    delegateEvents(["click"], dom.document);
    const { default: Navigation } = await import("../src/layout/Navigation");
    const [items, setItems] = createSignal<NavigationItem[]>([{ id: "new", label: "New", action: "new", badge: 1 }]);
    const events: string[] = [];
    const dismissal = Promise.withResolvers<void>();
    const actionFinished = Promise.withResolvers<void>();
    let dismissing = false;
    const nav = createNavigation({
      items,
      onAction: (action) => {
        events.push(action);
        actionFinished.resolve();
      },
    });
    const dispose = render(
      () => (
        <Navigation
          navigation={nav}
          label="App"
          beforeSelect={async () => {
            dismissing = true;
            await dismissal.promise;
            events.push("closed");
          }}
        />
      ),
      dom.root,
    );
    try {
      const button = dom.root.querySelector<HTMLButtonElement>("button")!;
      button.focus();
      setItems([{ id: "new", label: "New", action: "new", badge: 2 }]);
      expect(dom.document.activeElement).toBe(button);
      expect(button.textContent).toContain("2");
      button.click();
      expect(dismissing).toBe(true);
      expect(events).toEqual([]);
      dismissal.resolve();
      await actionFinished.promise;
      expect(events).toEqual(["closed", "new"]);
      setItems([{ id: "new", label: "New", action: "new", disabled: true }]);
      await nav.activate("new");
      expect(events).toEqual(["closed", "new"]);
    } finally {
      dismissal.resolve();
      dispose();
      dom.cleanup();
    }
  });

  test("parent links and disclosure are separate; modified clicks stay native", async () => {
    const dom = createDomTestHarness();
    const { default: Navigation } = await import("../src/layout/Navigation");
    let dismissals = 0;
    const nav = createNavigation({
      items: () => [{ id: "parent", label: "Parent", href: "/parent", children: [{ id: "child", label: "Child", href: "/child" }] }],
    });
    const dispose = render(
      () => (
        <Navigation
          navigation={nav}
          label="App"
          beforeSelect={() => {
            dismissals++;
          }}
        />
      ),
      dom.root,
    );
    const link = dom.root.querySelector("a")!;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(dismissals).toBe(0);
    const disclosure = dom.root.querySelector<HTMLButtonElement>(".k2b-navigation__disclosure")!;
    disclosure.click();
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(dismissals).toBe(0);
    dispose();
    dom.cleanup();
  });
});

test("disabled parents block descendants and local links keep modified clicks native", async () => {
  const dom = createDomTestHarness();
  const { default: Navigation } = await import("../src/layout/Navigation");
  const [disabled, setDisabled] = createSignal(true);
  const actions: string[] = [];
  const nav = createNavigation({
    items: () => [
      {
        id: "parent",
        label: "Parent",
        disabled: disabled(),
        children: [{ id: "local", label: "Local view", href: "/local", action: "open" }],
      },
    ],
    onAction: (action) => {
      actions.push(action);
    },
  });
  const dispose = render(() => <Navigation navigation={nav} label="App" />, dom.root);
  const link = dom.root.querySelector<HTMLAnchorElement>("a")!;
  expect(link.getAttribute("aria-disabled")).toBe("true");
  link.click();
  await Bun.sleep(0);
  expect(actions).toEqual([]);
  setDisabled(false);
  const modified = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
  link.dispatchEvent(modified);
  expect(modified.defaultPrevented).toBe(false);
  expect(actions).toEqual([]);
  link.click();
  await Bun.sleep(0);
  expect(actions).toEqual(["open"]);
  dispose();
  dom.cleanup();
});

test("inline actions run their action after host dismissal and never navigate", async () => {
  const dom = createDomTestHarness();
  const { default: Navigation } = await import("../src/layout/Navigation");
  const events: string[] = [];
  const nav = createNavigation({
    items: () => [
      {
        id: "compose",
        label: "Compose",
        href: "/compose",
        inlineActions: [{ id: "details", label: "Mailbox details", icon: "ti ti-info-circle", action: "details" }],
      },
    ],
    onAction: (action) => {
      events.push(action);
    },
  });
  const dispose = render(
    () => (
      <Navigation
        navigation={nav}
        label="Mail"
        beforeSelect={() => {
          events.push("closed");
        }}
      />
    ),
    dom.root,
  );
  try {
    const button = dom.root.querySelector<HTMLButtonElement>(".k2b-navigation__inline-action")!;
    expect(button.tagName).toBe("BUTTON");
    button.click();
    await Bun.sleep(0);
    expect(events).toEqual(["closed", "details"]);
    // A destination belongs in a row, where its link keeps modified clicks and new tabs.
    const inline: NonNullable<NavigationItem["inlineActions"]>[number][] = [
      // @ts-expect-error An inline action runs an action and has no href.
      { id: "open", label: "Open", icon: "ti ti-external-link", href: "/open" },
    ];
    expect(inline).toHaveLength(1);
  } finally {
    dispose();
    dom.cleanup();
  }
});

test("an action that keeps the menu open runs without host dismissal; every other action still waits for it", async () => {
  const dom = createDomTestHarness();
  // Each test has a document of its own; the rows' click handler is delegated to the document.
  delegateEvents(["click"], dom.document);
  const { default: Navigation } = await import("../src/layout/Navigation");
  const events: string[] = [];
  const nav = createNavigation({
    items: () => [
      { id: "favorites", label: "Favorites", action: "filter", keepOpen: true },
      { id: "new", label: "New note", action: "new" },
    ],
    onAction: (action) => {
      events.push(action);
    },
  });
  const dispose = render(
    () => (
      <Navigation
        navigation={nav}
        label="Notebook"
        beforeSelect={() => {
          events.push("closed");
        }}
      />
    ),
    dom.root,
  );
  try {
    const [filter, create] = Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button"));
    filter!.click();
    await Bun.sleep(0);
    expect(events).toEqual(["filter"]);
    create!.click();
    await Bun.sleep(0);
    expect(events).toEqual(["filter", "closed", "new"]);
    // A link always lets the host close the menu first.
    const link: NavigationItem[] = [
      // @ts-expect-error Only an action can keep the menu open.
      { id: "open", label: "Open", href: "/open", keepOpen: true },
    ];
    expect(link).toHaveLength(1);
  } finally {
    dispose();
    dom.cleanup();
  }
});

test("collapsed groups disclose with a chevron without dismissing the host and preserve a user toggle", async () => {
  const dom = createDomTestHarness();
  const { default: Navigation } = await import("../src/layout/Navigation");
  const [name, setName] = createSignal("Projects");
  let dismissed = 0;
  const navigation = createNavigation({
    items: () => [
      { id: "projects", label: name(), defaultExpanded: false, children: [{ id: "one", label: "Work", href: "/project/one" }] },
    ],
  });
  const dispose = render(
    () => (
      <Navigation
        navigation={navigation}
        label="Assistant"
        beforeSelect={() => {
          dismissed++;
        }}
      />
    ),
    dom.root,
  );
  try {
    const toggle = dom.root.querySelector<HTMLButtonElement>("button")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.querySelector(".ti-chevron-right")).not.toBeNull();
    expect(dom.root.querySelector("[hidden]")).not.toBeNull();
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.querySelector(".ti-chevron-down")).not.toBeNull();
    expect(dom.root.querySelector("[hidden]")).toBeNull();
    expect(dismissed).toBe(0);
    setName("Projects updated");
    expect(dom.root.querySelector("button")).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  } finally {
    dispose();
    dom.cleanup();
  }
});

test("an owner that handles expansion keeps disclosure across renderers and reveals rows itself", async () => {
  const dom = createDomTestHarness();
  const { default: Navigation } = await import("../src/layout/Navigation");
  const [open, setOpen] = createSignal<readonly string[]>([]);
  const changes: Array<[string, boolean]> = [];
  const navigation = createNavigation({
    items: () => [
      {
        id: "guide",
        label: "Guide",
        href: "/guide",
        expanded: open().includes("guide"),
        children: [{ id: "setup", label: "Setup", href: "/setup" }],
      },
      { id: "section", label: "Section", children: [{ id: "other", label: "Other", href: "/other" }] },
    ],
    onExpandedChange: (id, expanded) => {
      changes.push([id, expanded]);
      setOpen((current) => (expanded ? [...current, id] : current.filter((entry) => entry !== id)));
    },
  });
  const mount = () => {
    const host = dom.document.createElement("div");
    dom.root.append(host);
    const dispose = render(() => <Navigation navigation={navigation} label="Book" />, host);
    const disclosure = (label: string) =>
      Array.from(host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")).find(
        (button) => button.getAttribute("aria-label") === label || button.textContent === label,
      )!;
    return { disclosure, dispose };
  };
  try {
    const first = mount();
    expect(first.disclosure("Guide").getAttribute("aria-expanded")).toBe("false");
    first.disclosure("Guide").click();
    expect(changes).toEqual([["guide", true]]);
    expect(first.disclosure("Guide").getAttribute("aria-expanded")).toBe("true");
    // Items without an owner-held state keep the renderer-local default.
    first.disclosure("Section").click();
    expect(first.disclosure("Section").getAttribute("aria-expanded")).toBe("false");
    expect(changes).toEqual([["guide", true]]);
    first.dispose();

    const reopened = mount();
    expect(reopened.disclosure("Guide").getAttribute("aria-expanded")).toBe("true");
    expect(reopened.disclosure("Section").getAttribute("aria-expanded")).toBe("true");
    setOpen([]);
    expect(reopened.disclosure("Guide").getAttribute("aria-expanded")).toBe("false");
    reopened.dispose();
  } finally {
    dom.cleanup();
  }
});

test("an item's expanded state stays with its owner even without a handler", async () => {
  const dom = createDomTestHarness();
  const { default: Navigation } = await import("../src/layout/Navigation");
  const navigation = createNavigation({
    items: () => [
      { id: "guide", label: "Guide", href: "/guide", expanded: false, children: [{ id: "setup", label: "Setup", href: "/setup" }] },
    ],
  });
  const dispose = render(() => <Navigation navigation={navigation} label="Book" />, dom.root);
  try {
    const disclosure = dom.root.querySelector<HTMLButtonElement>(".k2b-navigation__disclosure")!;
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    disclosure.click();
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  } finally {
    dispose();
    dom.cleanup();
  }
});

test("row actions keep their description, so a disabled action can say why", async () => {
  const dom = createDomTestHarness();
  const { default: Navigation } = await import("../src/layout/Navigation");
  const navigation = createNavigation({
    items: () => [
      {
        id: "plan",
        label: "Plan",
        href: "/plan",
        actions: [{ id: "delete", label: "Delete", action: "delete", description: "Only admins delete here.", disabled: true }],
      },
    ],
  });
  const dispose = render(() => <Navigation navigation={navigation} label="Notes" />, dom.root);
  try {
    const trigger = dom.root.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
    const menu = dom.document.getElementById(trigger.getAttribute("aria-controls")!)!;
    const item = menu.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    expect(item.disabled).toBe(true);
    expect(item.querySelector("small")?.textContent).toBe("Only admins delete here.");
  } finally {
    dispose();
    dom.cleanup();
  }
});

test("sections head their rows without a disclosure, and a row's status fills its kept slot in place", async () => {
  const dom = createDomTestHarness();
  const { default: Navigation } = await import("../src/layout/Navigation");
  const [running, setRunning] = createSignal(false);
  const navigation = createNavigation({
    items: () => [
      {
        id: "today",
        label: "Today",
        section: true,
        children: [
          {
            id: "offer",
            label: "Offer",
            href: "/offer",
            status: running() ? { icon: "ti ti-loader-2", label: "Running", tone: "info" } : null,
          },
          { id: "notes", label: "Notes", href: "/notes" },
        ],
      },
    ],
  });
  const dispose = render(() => <Navigation navigation={navigation} label="Chats" />, dom.root);
  try {
    expect(dom.root.querySelector(".k2b-navigation__disclosure, [aria-expanded]")).toBeNull();
    const heading = dom.root.querySelector(".k2b-navigation__heading")!;
    expect(heading.textContent).toBe("Today");
    const list = heading.nextElementSibling!;
    expect(list.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(list.querySelectorAll("a").length).toBe(2);

    const link = dom.root.querySelector<HTMLAnchorElement>('a[href="/offer"]')!;
    const slot = link.querySelector(".k2b-navigation__status")!;
    // Reserved but empty while idle; a row without `status` has no slot at all.
    expect(slot.textContent).toBe("");
    expect(dom.root.querySelector('a[href="/notes"] .k2b-navigation__status')).toBeNull();

    setRunning(true);
    expect(link.querySelector(".k2b-navigation__status")).toBe(slot);
    expect(slot.getAttribute("data-tone")).toBe("info");
    expect(slot.getAttribute("title")).toBe("Running");
    expect(link.textContent).toBe("OfferRunning");
    expect(dom.root.querySelector('a[href="/offer"] small')).toBeNull();
  } finally {
    dispose();
    dom.cleanup();
  }
});

test("a row names a meaningful icon and keeps every other icon decorative", async () => {
  const dom = createDomTestHarness();
  const { default: Navigation } = await import("../src/layout/Navigation");
  const nav = createNavigation({
    items: () => [
      { id: "home", label: "Overview", href: "/notes/home", icon: "ti ti-home", iconLabel: "Homepage" },
      { id: "rules", label: "Rules", href: "/notes/rules", icon: "ti ti-file-text" },
    ],
  });
  const dispose = render(() => <Navigation navigation={nav} label="Notes" />, dom.root);
  try {
    const [home, rules] = Array.from(dom.root.querySelectorAll(".k2b-navigation__control > i"));
    expect(home?.getAttribute("role")).toBe("img");
    expect(home?.getAttribute("aria-label")).toBe("Homepage");
    expect(home?.hasAttribute("aria-hidden")).toBe(false);
    expect(rules?.getAttribute("aria-hidden")).toBe("true");
  } finally {
    dispose();
    dom.cleanup();
  }
});
