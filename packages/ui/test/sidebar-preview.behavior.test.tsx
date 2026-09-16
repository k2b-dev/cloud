import { expect, test } from "bun:test";
import { delegateEvents, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

// Happy DOM lacks the native popover implementation; expose its toggle events.
function popover(panel: HTMLElement) {
  let opened = false;
  const toggle = (newState: "open" | "closed") => {
    opened = newState === "open";
    const event = new Event("toggle");
    Object.defineProperty(event, "newState", { value: newState });
    panel.dispatchEvent(event);
  };
  panel.showPopover = () => toggle("open");
  panel.hidePopover = () => toggle("closed");
  return () => opened;
}

test("row preview shares hover and click opening, stays pinned, closes on selection, and restores keyboard focus", async () => {
  const dom = createDomTestHarness();
  delegateEvents(["click"], dom.document);
  const { default: AppWorkspace } = await import("../src/layout/AppWorkspace");
  const openings: boolean[] = [];
  let selected = 0;
  const dispose = render(() => <AppWorkspace.SidebarItem icon="ti ti-folders" preview={{
    label: "Projects", trigger: "row", onOpenChange: (open) => openings.push(open),
    content: (close) => <button on:click={() => { close(); selected++; }}>Choose project</button>,
  }}>Projects</AppWorkspace.SidebarItem>, dom.root);
  try {
    const row = dom.root.querySelector<HTMLElement>(".k2b-app-workspace__sidebar-item")!;
    const main = row.querySelector<HTMLButtonElement>(".k2b-app-workspace__sidebar-item-main")!;
    const panel = row.querySelector<HTMLElement>('[role="dialog"]')!;
    const isOpen = popover(panel);
    const scroll = panel.querySelector<HTMLElement>('[data-scroll-fade-mode="both"]')!;
    expect(scroll).not.toBeNull();
    Object.defineProperties(scroll, { scrollHeight: { value: 400 }, clientHeight: { value: 200 } });
    scroll.dispatchEvent(new Event("scroll"));
    expect(scroll.getAttribute("data-scroll-fade")).toBe("bottom");
    scroll.scrollTop = 80;
    scroll.dispatchEvent(new Event("scroll"));
    expect(scroll.getAttribute("data-scroll-fade")).toBe("both");
    scroll.scrollTop = 200;
    scroll.dispatchEvent(new Event("scroll"));
    expect(scroll.getAttribute("data-scroll-fade")).toBe("top");
    expect(panel.hasAttribute("data-scroll-fade")).toBe(false);
    expect(main.getAttribute("aria-controls")).toBe(panel.id);
    expect(main.getAttribute("aria-haspopup")).toBe("dialog");
    expect(row.querySelector(".ti-chevron-right")).not.toBeNull();
    const hover = new Event("pointerenter");
    Object.defineProperty(hover, "pointerType", { value: "mouse" });
    row.dispatchEvent(hover);
    await Bun.sleep(280);
    expect(isOpen()).toBe(true);
    main.click();
    expect(main.getAttribute("aria-expanded")).toBe("true");
    expect(dom.document.activeElement).toBe(panel);
    row.dispatchEvent(new Event("pointerleave"));
    await Bun.sleep(200);
    expect(isOpen()).toBe(true);
    panel.querySelector<HTMLButtonElement>("button")!.click();
    expect(selected).toBe(1);
    expect(isOpen()).toBe(false);
    main.click();
    expect(isOpen()).toBe(true);
    dom.document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(isOpen()).toBe(false);
    expect(dom.document.activeElement).toBe(main);
    await Bun.sleep(280);
    expect(isOpen()).toBe(false);
    expect(openings).toEqual([true, false, true, false]);
  } finally { dispose(); dom.cleanup(); }
});

test("ordinary preview rows keep their independent navigation action", async () => {
  const dom = createDomTestHarness();
  delegateEvents(["click"], dom.document);
  const { default: AppWorkspace } = await import("../src/layout/AppWorkspace");
  let navigated = 0;
  const dispose = render(() => <AppWorkspace.SidebarItem onClick={() => navigated++} preview={{ label: "Details", content: "Details" }}>Chat</AppWorkspace.SidebarItem>, dom.root);
  try {
    const main = dom.root.querySelector<HTMLButtonElement>(".k2b-app-workspace__sidebar-item-main")!;
    const isOpen = popover(dom.root.querySelector<HTMLElement>('[role="dialog"]')!);
    main.click();
    expect(navigated).toBe(1);
    expect(isOpen()).toBe(false);
    expect(main.hasAttribute("aria-haspopup")).toBe(false);
    dom.root.querySelector<HTMLButtonElement>('[aria-label="Details"]')!.click();
    expect(navigated).toBe(1);
    expect(isOpen()).toBe(true);
  } finally { dispose(); dom.cleanup(); }
});
