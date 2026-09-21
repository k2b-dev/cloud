import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

(isServer ? test.skip : test)("pill tabs keep close and trailing controls separate and restore keyboard focus", async () => {
  const dom = createDomTestHarness();
  const { Tabs } = await import("../src/actions/Tabs");
  const [value, setValue] = createSignal("one");
  const [ids, setIds] = createSignal(["one", "two", "three"]);
  const trailing = dom.document.createElement("button");
  trailing.textContent = "+";
  const dispose = render(
    () =>
      createComponent(Tabs, {
        ariaLabel: "Files",
        variant: "pill",
        value,
        onValueChange: setValue,
        trailing,
        get options() {
          return ids().map((id) => ({
            value: id,
            label: id,
            onClose: () => {
              setIds((ids) => ids.filter((item) => item !== id));
              setValue("one");
            },
          }));
        },
      }),
    dom.root,
  );
  try {
    expect(dom.root.querySelector('[data-variant="pill"]')).not.toBeNull();
    expect(dom.root.querySelector('[role="tablist"]')?.contains(trailing)).toBe(false);
    const tabs = () => Array.from(dom.root.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    tabs()[0]!.focus();
    tabs()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await Promise.resolve();
    expect(value()).toBe("two");
    expect(dom.document.activeElement).toBe(tabs()[1]!);
    tabs()[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    await Promise.resolve();
    expect(ids()).toEqual(["one", "three"]);
    expect(dom.document.activeElement).toBe(tabs()[0]!);
    expect(dom.root.querySelector('[role="tab"] button')).toBeNull();
  } finally {
    dispose();
    dom.cleanup();
  }
});

(isServer ? test.skip : test)("trailing content is constructed once and keeps its interactive state", async () => {
  const dom = createDomTestHarness();
  const { Tabs } = await import("../src/actions/Tabs");
  let constructed = 0;
  const [value, setValue] = createSignal("one");
  const dispose = render(
    () =>
      createComponent(Tabs, {
        ariaLabel: "Files",
        value,
        onValueChange: setValue,
        options: [
          { value: "one", label: "One" },
          { value: "two", label: "Two" },
        ],
        get trailing() {
          constructed++;
          const button = dom.document.createElement("button");
          button.textContent = "+";
          button.onclick = () => {
            button.textContent = "Open";
          };
          return button;
        },
      }),
    dom.root,
  );
  try {
    expect(constructed).toBe(1);
    const trigger = dom.root.querySelector<HTMLButtonElement>(".k2b-tabs__trailing button")!;
    trigger.click();
    setValue("two");
    expect(dom.root.querySelector(".k2b-tabs__trailing button")).toBe(trigger);
    expect(trigger.textContent).toBe("Open");
  } finally {
    dispose();
    dom.cleanup();
  }
});
