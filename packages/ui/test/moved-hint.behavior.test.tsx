import { expect, spyOn, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

if (isServer) test.skip("requires browser conditions", () => {});
else {
  test("dismisses once per open period, restores entry focus, and releases Escape on close", async () => {
    const dom = createDomTestHarness();
    const { MovedHint } = await import("../src/feedback/MovedHint");
    const target = document.createElement("button");
    const previous = document.createElement("div");
    previous.tabIndex = -1;
    dom.root.append(target, previous);
    const [open, setOpen] = createSignal(true);
    let dismissals = 0;
    const dispose = render(
      () =>
        createComponent(MovedHint, {
          get open() {
            return open();
          },
          target: () => target,
          onDismiss: () => {
            dismissals++;
          },
          action: { label: "Show filters", href: "#filters" },
          children: "Tags moved.",
        }),
      dom.root,
    );
    try {
      await Promise.resolve();
      const close = dom.root.querySelector<HTMLButtonElement>(".k2b-moved-hint button")!;
      previous.focus();
      close.focus();
      close.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      expect(dismissals).toBe(1);
      expect(document.activeElement).toBe(previous);
      close.click();
      expect(dismissals).toBe(1);
      setOpen(false);
      expect(dom.root.querySelector(".k2b-moved-hint")).toBeNull();
      setOpen(true);
      target.focus();
      const next = dom.root.querySelector<HTMLButtonElement>(".k2b-moved-hint button")!;
      next.focus();
      next.click();
      expect(dismissals).toBe(2);
      expect(document.activeElement).toBe(target);
      setOpen(false);
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(dismissals).toBe(2);
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("Escape consumed by the target leaves the hint open without dismissing", async () => {
    const dom = createDomTestHarness();
    const { MovedHint } = await import("../src/feedback/MovedHint");
    const target = document.createElement("button");
    dom.root.append(target);
    Object.defineProperty(target, "getClientRects", { value: () => [target.getBoundingClientRect()] });
    Object.defineProperties(dom.window.HTMLElement.prototype, {
      showPopover: {
        configurable: true,
        value(this: HTMLElement) {
          this.dataset.shown = "true";
        },
      },
      hidePopover: {
        configurable: true,
        value(this: HTMLElement) {
          delete this.dataset.shown;
        },
      },
    });
    const consumeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") event.preventDefault();
    };
    target.addEventListener("keydown", consumeEscape);
    let dismissals = 0;
    const dispose = render(
      () =>
        createComponent(MovedHint, {
          open: true,
          target: () => target,
          onDismiss: () => {
            dismissals++;
          },
          action: { label: "Show filters", href: "#filters" },
          children: "Tags moved.",
        }),
      dom.root,
    );
    try {
      await Promise.resolve();
      const surface = dom.root.querySelector<HTMLElement>(".k2b-moved-hint")!;
      expect(surface.dataset.shown).toBe("true");
      target.focus();
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      expect(surface.dataset.shown).toBe("true");
      expect(dismissals).toBe(0);
      target.removeEventListener("keydown", consumeEscape);
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      expect(surface.dataset.shown).toBeUndefined();
      expect(dismissals).toBe(1);
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("an action dismisses before running and cannot run twice", async () => {
    const dom = createDomTestHarness();
    const { MovedHint } = await import("../src/feedback/MovedHint");
    const target = document.createElement("button");
    dom.root.append(target);
    const events: string[] = [];
    const dispose = render(
      () =>
        createComponent(MovedHint, {
          open: true,
          target: () => target,
          onDismiss: () => events.push("dismiss"),
          action: { label: "Show filters", onClick: () => events.push("action") },
          children: "Tags moved.",
        }),
      dom.root,
    );
    try {
      await Promise.resolve();
      const action = dom.root.querySelector<HTMLButtonElement>(".k2b-moved-hint button")!;
      action.click();
      action.click();
      expect(events).toEqual(["dismiss", "action"]);
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("shows only for a visible target, announces once, and stops repositioning after dismissal and cleanup", async () => {
    const dom = createDomTestHarness();
    const { MovedHint } = await import("../src/feedback/MovedHint");
    const announcements = await import("../src/feedback/announce");
    const announce = spyOn(announcements, "announce").mockImplementation(() => {});
    const target = document.createElement("button");
    dom.root.append(target);
    let visible = true;
    let shows = 0;
    let hides = 0;
    // happy-dom has no layout or Popover API; explicit geometry isolates this lifecycle.
    Object.defineProperty(target, "getClientRects", { value: () => (visible ? [target.getBoundingClientRect()] : []) });
    Object.defineProperties(dom.window.HTMLElement.prototype, {
      showPopover: {
        configurable: true,
        value(this: HTMLElement) {
          shows++;
          this.dataset.shown = "true";
        },
      },
      hidePopover: {
        configurable: true,
        value(this: HTMLElement) {
          hides++;
          delete this.dataset.shown;
        },
      },
    });
    const dispose = render(
      () =>
        createComponent(MovedHint, {
          open: true,
          target: () => target,
          onDismiss: () => {},
          action: { label: "Show filters", href: "#filters" },
          children: "Tags moved.",
        }),
      dom.root,
    );
    try {
      await Promise.resolve();
      const surface = dom.root.querySelector<HTMLElement>(".k2b-moved-hint")!;
      expect(surface.dataset.shown).toBe("true");
      expect(announce).toHaveBeenCalledTimes(1);
      expect(announce).toHaveBeenCalledWith("Tags moved.");
      visible = false;
      window.dispatchEvent(new Event("resize"));
      expect(surface.dataset.shown).toBeUndefined();
      visible = true;
      window.dispatchEvent(new Event("scroll"));
      expect(surface.dataset.shown).toBe("true");
      expect(announce).toHaveBeenCalledTimes(1);
      const link = surface.querySelector("a")!;
      const click = new MouseEvent("click", { bubbles: true, cancelable: true });
      link.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(false);
      expect(surface.dataset.shown).toBeUndefined();
      const before = [shows, hides];
      window.dispatchEvent(new Event("resize"));
      expect([shows, hides]).toEqual(before);
      dispose();
      window.dispatchEvent(new Event("scroll"));
      expect([shows, hides]).toEqual(before);
    } finally {
      dispose();
      announce.mockRestore();
      dom.cleanup();
    }
  });
}
