import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { openViewTabsInPlace } from "./mail-view-tabs";

test.skipIf(isServer)("tab links open in place only for an unmodified left click and clean up their listener", () => {
  const dom = createDomTestHarness();
  const opens: string[] = [];
  const href = "/app/mail/Box001?view=mine";
  const dispose = render(
    () =>
      createComponent(() => {
        openViewTabsInPlace(
          () => [{ id: "mine", label: "Mine", href }],
          (next) => opens.push(next),
        );
        return (
          <>
            <a href={href}>
              <span>Mine</span>
            </a>
            <a href="/app/mail/Box002">Other mailbox</a>
          </>
        );
      }, {}),
    dom.root,
  );
  const click = (target: Element, options: MouseEventInit = {}) => {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...options });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  try {
    const label = dom.root.querySelector("span")!;
    expect(click(label)).toBe(true);
    expect(opens).toEqual([href]);
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])
      expect(click(label, modifiers)).toBe(false);
    expect(click(dom.root.querySelectorAll("a")[1]!)).toBe(false);
    const prevented = new MouseEvent("click", { bubbles: true, cancelable: true });
    prevented.preventDefault();
    label.dispatchEvent(prevented);
    expect(opens).toEqual([href]);
    dispose();
    const remaining = document.createElement("a");
    remaining.href = href;
    dom.root.append(remaining);
    expect(click(remaining)).toBe(false);
    expect(opens).toEqual([href]);
  } finally {
    dispose();
    dom.cleanup();
  }
});
