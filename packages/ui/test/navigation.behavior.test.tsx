import { describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createNavigation, type NavigationItem } from "../src/layout/navigation-model";
import { createDomTestHarness } from "./dom";

describe("Navigation", () => {
  test("keeps row focus across snapshots and performs actions only after host dismissal", async () => {
    const dom = createDomTestHarness();
    const { default: Navigation } = await import("../src/layout/Navigation");
    const [items, setItems] = createSignal<NavigationItem[]>([{ id: "new", label: "New", action: "new", badge: 1 }]);
    const events: string[] = [];
    const nav = createNavigation({
      items,
      onAction: (action) => {
        events.push(action);
      },
    });
    const dispose = render(
      () => (
        <Navigation
          navigation={nav}
          label="App"
          beforeSelect={() => {
            events.push("closed");
          }}
        />
      ),
      dom.root,
    );
    const button = dom.root.querySelector<HTMLButtonElement>("button")!;
    button.focus();
    setItems([{ id: "new", label: "New", action: "new", badge: 2 }]);
    expect(dom.document.activeElement).toBe(button);
    expect(button.textContent).toContain("2");
    button.click();
    await Bun.sleep(0);
    expect(events).toEqual(["closed", "new"]);
    setItems([{ id: "new", label: "New", action: "new", disabled: true }]);
    await nav.activate("new");
    expect(events).toEqual(["closed", "new"]);
    dispose();
    dom.cleanup();
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
