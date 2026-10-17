import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { DropdownAction } from "../src/actions/Dropdown";
import type { GestureMenuItem } from "../src/actions/GestureMenu";
import { createDomTestHarness, type DomTestHarness } from "./dom";

type Calls = { reply: number; react: number; copy: number; archive: number };

let dom: DomTestHarness;
let dispose: (() => void) | undefined;

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const LONG_PRESS = 550;

async function mount(
  options: { items?: (calls: Calls) => GestureMenuItem[]; sheetTop?: boolean; locale?: string; onOpen?: () => void } = {},
) {
  const { GestureMenu } = await import("../src/actions/GestureMenu");
  const { LocaleProvider } = await import("../src/intl/locale");
  const calls: Calls = { reply: 0, react: 0, copy: 0, archive: 0 };
  const items = options.items?.(calls) ?? [
    { label: "Reply", icon: "ti ti-arrow-back-up", action: () => calls.reply++, gesture: "swipe-right" },
    { label: "React with thumbs up", icon: "ti ti-thumb-up", action: () => calls.react++, gesture: "double-tap" },
    { label: "Copy text", icon: "ti ti-copy", action: () => calls.copy++ },
  ];
  dispose = render(
    () => (
      <LocaleProvider locale={options.locale ?? "en"}>
        <GestureMenu
          label="Message from Nora"
          items={items}
          onOpen={options.onOpen}
          sheetTop={
            options.sheetTop
              ? (close) => (
                  <button type="button" class="quick" on:click={() => close()}>
                    👍
                  </button>
                )
              : undefined
          }
        >
          <p class="text">
            Hello <a href="https://example.com">link</a>
          </p>
          <pre class="code">let x = 1;</pre>
          <div class="card" data-gesture-ignore>
            Card
          </div>
        </GestureMenu>
      </LocaleProvider>
    ),
    dom.root,
  );
  const host = dom.root.querySelector<HTMLElement>("[role='group']")!;
  const surface = host.querySelector<HTMLElement>(".k2b-gesture-menu")!;
  const text = surface.querySelector<HTMLElement>(".text")!;
  const link = surface.querySelector<HTMLElement>("a")!;
  const code = surface.querySelector<HTMLElement>(".code")!;
  const card = surface.querySelector<HTMLElement>(".card")!;
  const win = dom.window as unknown as {
    PointerEvent: typeof PointerEvent;
    MouseEvent: typeof MouseEvent;
    KeyboardEvent: typeof KeyboardEvent;
    Event: typeof Event;
  };
  const pointer = (type: string, target: HTMLElement, x: number, y: number, init: Partial<PointerEventInit> = {}) => {
    const event = new win.PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 3,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      clientX: x,
      clientY: y,
      ...init,
    });
    target.dispatchEvent(event);
    return event;
  };
  const tap = (target: HTMLElement, x = 120, y = 40) => {
    pointer("pointerdown", target, x, y);
    pointer("pointerup", target, x, y);
  };
  /** A touch from `from` through every point of `path`, released at the last one. */
  const drag = (
    target: HTMLElement,
    from: [number, number],
    path: [number, number][],
    end: "pointerup" | "pointercancel" = "pointerup",
  ) => {
    pointer("pointerdown", target, ...from);
    for (const point of path) pointer("pointermove", target, ...point);
    const last = path.at(-1) ?? from;
    pointer(end, target, ...last);
  };
  const touchEnd = (target: HTMLElement) => {
    const event = new win.Event("touchend", { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const mouse = (type: string, target: HTMLElement, detail: number) => {
    const event = new win.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, detail, clientX: 120, clientY: 40 });
    target.dispatchEvent(event);
    return event;
  };
  const offset = () => surface.style.getPropertyValue("--k2b-gesture-menu-offset");
  const sheet = () => dom.document.querySelector<HTMLElement>(".k2b-gesture-menu__sheet-menu");
  return { calls, host, surface, text, link, code, card, pointer, tap, drag, touchEnd, mouse, offset, sheet, win };
}

const closeSheets = async () => {
  const { dialogCore } = await import("../src/feedback/dialog-core");
  while (dialogCore.isOpen()) {
    dialogCore.close();
    await settle(10);
  }
};

if (isServer) test.skip("requires browser conditions", () => {});
else
  describe("GestureMenu", () => {
    beforeAll(() => {
      dom = createDomTestHarness();
      Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 390 });
      // ContextMenu measures its menu.
      Object.defineProperty(globalThis, "DOMRect", { configurable: true, writable: true, value: dom.window.DOMRect });
    });
    afterEach(async () => {
      await closeSheets();
      dispose?.();
      dispose = undefined;
      Reflect.deleteProperty(dom.window, "matchMedia");
    });
    afterAll(() => {
      Reflect.deleteProperty(globalThis, "DOMRect");
      dom.cleanup();
    });

    test("declares its touch behavior from the items and stays a named group with a menu", async () => {
      const view = await mount();
      expect(view.host.getAttribute("aria-label")).toBe("Message from Nora");
      expect(view.host.getAttribute("aria-haspopup")).toBe("menu");
      expect(view.surface.dataset.active).toBe("");
      expect(view.surface.dataset.touch).toBe("swipe");
      dispose?.();

      const tapOnly = await mount({ items: (calls) => [{ label: "React", action: () => calls.react++, gesture: "double-tap" }] });
      expect(tapOnly.surface.dataset.touch).toBe("tap");
      dispose?.();

      const plain = await mount({ items: (calls) => [{ label: "Copy", action: () => calls.copy++ }] });
      expect(plain.surface.dataset.touch).toBeUndefined();
      dispose?.();

      const empty = await mount({ items: () => [] });
      expect(empty.surface.dataset.active).toBeUndefined();
      expect(empty.host.getAttribute("aria-disabled")).toBe("true");
    });

    test("vertical scrolling never turns into a swipe", async () => {
      const view = await mount();
      // Straight down, then a steep diagonal: both belong to the page.
      view.drag(
        view.text,
        [120, 100],
        [
          [122, 115],
          [126, 160],
          [180, 220],
        ],
      );
      view.drag(
        view.text,
        [120, 100],
        [
          [150, 125],
          [200, 160],
        ],
      );
      expect(view.surface.dataset.swipe).toBeUndefined();
      // The browser takes a touch that scrolls; nothing runs afterwards either.
      view.drag(view.text, [120, 100], [[121, 108]], "pointercancel");
      expect(view.calls).toEqual({ reply: 0, react: 0, copy: 0, archive: 0 });
      expect(view.offset()).toBe("0px");
    });

    test("a horizontal swipe follows the finger and runs its action only past the threshold", async () => {
      const view = await mount();
      view.pointer("pointerdown", view.text, 120, 40);
      view.pointer("pointermove", view.text, 150, 42);
      expect(view.surface.dataset.swipe).toBe("right");
      expect(view.offset()).toBe("30px");
      expect(view.surface.dataset.armed).toBeUndefined();
      expect(view.surface.querySelector(".k2b-gesture-menu__swipe i")?.className).toBe("ti ti-arrow-back-up");
      view.pointer("pointermove", view.text, 200, 44);
      expect(view.surface.dataset.armed).toBe("");
      // Past the threshold the content follows at a quarter of the travel, up to 96 px.
      expect(view.offset()).toBe("68px");
      view.pointer("pointermove", view.text, 400, 44);
      expect(view.offset()).toBe("96px");
      view.pointer("pointerup", view.text, 400, 44);
      expect(view.calls.reply).toBe(1);
      expect(view.touchEnd(view.text)).toBe(true);
      expect(view.surface.dataset.settling).toBe("");
      expect(view.offset()).toBe("0px");
      await settle(200);
      expect(view.surface.dataset.swipe).toBeUndefined();

      // Released short of the threshold: it snaps back without running.
      view.drag(
        view.text,
        [120, 40],
        [
          [150, 40],
          [170, 40],
        ],
      );
      expect(view.calls.reply).toBe(1);
      expect(view.touchEnd(view.text)).toBe(false);
      await settle(200);
      // Without a swipe-left item a swipe to the left does nothing.
      view.drag(
        view.text,
        [200, 40],
        [
          [150, 40],
          [60, 40],
        ],
      );
      expect(view.surface.dataset.swipe).toBeUndefined();
      expect(view.calls.reply).toBe(1);
    });

    test("swipes do not start at the screen's edge, on links, code, or marked regions, or for a disabled item", async () => {
      const view = await mount();
      view.drag(
        view.text,
        [8, 40],
        [
          [60, 40],
          [140, 40],
        ],
      );
      view.drag(view.link, [120, 40], [[200, 40]]);
      view.drag(view.code, [120, 40], [[200, 40]]);
      view.drag(view.card, [120, 40], [[200, 40]]);
      expect(view.calls.reply).toBe(0);
      dispose?.();

      const disabled = await mount({
        items: (calls) => [{ label: "Reply", action: () => calls.reply++, gesture: "swipe-right", disabled: true }],
      });
      disabled.drag(disabled.text, [120, 40], [[200, 40]]);
      expect(disabled.surface.dataset.swipe).toBeUndefined();
      expect(disabled.calls.reply).toBe(0);
    });

    test("the release decides a swipe: where the finger lifts, and whether its item is still enabled", async () => {
      let disabled = false;
      const view = await mount({
        items: (calls) => [
          {
            label: "Reply",
            action: () => calls.reply++,
            gesture: "swipe-right",
            get disabled() {
              return disabled;
            },
          },
        ],
      });
      // Armed at the last move, but lifted short of the threshold.
      view.pointer("pointerdown", view.text, 120, 40);
      view.pointer("pointermove", view.text, 190, 40);
      expect(view.surface.dataset.armed).toBe("");
      view.pointer("pointerup", view.text, 180, 40);
      expect(view.calls.reply).toBe(0);
      expect(view.touchEnd(view.text)).toBe(false);
      await settle(200);
      // The item was disabled while the finger was down.
      view.pointer("pointerdown", view.text, 120, 40);
      view.pointer("pointermove", view.text, 200, 40);
      disabled = true;
      view.pointer("pointerup", view.text, 200, 40);
      expect(view.calls.reply).toBe(0);
    });

    test("another finger anywhere ends the gesture", async () => {
      const view = await mount();
      const elsewhere = { pointerId: 4, isPrimary: false };
      // Two fingers held still open no sheet.
      view.pointer("pointerdown", view.text, 120, 40);
      view.pointer("pointerdown", dom.document.body as unknown as HTMLElement, 300, 600, elsewhere);
      await settle(LONG_PRESS);
      expect(view.sheet()).toBeNull();
      view.pointer("pointerup", view.text, 120, 40);
      // An armed swipe runs nothing once another finger landed outside the element.
      view.pointer("pointerdown", view.text, 120, 40);
      view.pointer("pointermove", view.text, 200, 40);
      expect(view.surface.dataset.armed).toBe("");
      view.pointer("pointerdown", dom.document.body as unknown as HTMLElement, 300, 600, elsewhere);
      view.pointer("pointerup", view.text, 200, 40);
      expect(view.calls.reply).toBe(0);
    });

    test("with reduced motion the content stays put while the swipe still works", async () => {
      Object.defineProperty(dom.window, "matchMedia", {
        configurable: true,
        writable: true,
        value: (query: string) => ({ matches: query === "(prefers-reduced-motion: reduce)", media: query }),
      });
      const view = await mount({
        items: (calls) => [{ label: "Archive", icon: "ti ti-archive", action: () => calls.archive++, gesture: "swipe-left" }],
      });
      view.pointer("pointerdown", view.text, 300, 40);
      view.pointer("pointermove", view.text, 200, 40);
      expect(view.surface.dataset.swipe).toBe("left");
      expect(view.surface.dataset.armed).toBe("");
      expect(view.offset()).toBe("0px");
      expect(view.surface.style.getPropertyValue("--k2b-gesture-menu-progress")).toBe("1");
      view.pointer("pointerup", view.text, 200, 40);
      expect(view.calls.archive).toBe(1);
      // No snap back to wait for.
      expect(view.surface.dataset.swipe).toBeUndefined();
      expect(view.surface.dataset.settling).toBeUndefined();
    });

    test("a double tap on the text reacts, but not on links, code, or marked regions", async () => {
      const view = await mount();
      view.tap(view.text);
      expect(view.calls.react).toBe(0);
      view.tap(view.text, 126, 44);
      expect(view.calls.react).toBe(1);
      expect(view.touchEnd(view.text)).toBe(true);
      // A third tap starts over.
      view.tap(view.text);
      expect(view.calls.react).toBe(1);

      for (const target of [view.link, view.code, view.card]) {
        view.tap(target);
        view.tap(target);
      }
      expect(view.calls.react).toBe(1);

      // Too far apart, or too slow.
      view.tap(view.text, 40, 40);
      view.tap(view.text, 200, 40);
      expect(view.calls.react).toBe(1);
      view.tap(view.text);
      await settle(350);
      view.tap(view.text);
      expect(view.calls.react).toBe(1);
    });

    test("a press on a link or with a mouse between two taps ends the double tap", async () => {
      const view = await mount();
      view.tap(view.text);
      view.tap(view.link);
      view.tap(view.text);
      expect(view.calls.react).toBe(0);
      view.tap(view.text, 300, 40);
      view.pointer("pointerdown", view.text, 300, 40, { pointerType: "mouse" });
      view.tap(view.text, 300, 40);
      expect(view.calls.react).toBe(0);
    });

    test("the click after a pen gesture is cancelled, a keyboard click is not", async () => {
      const view = await mount();
      let clicks = 0;
      const count = () => clicks++;
      dom.root.addEventListener("click", count);
      for (let index = 0; index < 2; index++) {
        view.pointer("pointerdown", view.text, 120, 40, { pointerType: "pen" });
        view.pointer("pointerup", view.text, 120, 40, { pointerType: "pen" });
      }
      expect(view.calls.react).toBe(1);
      // A pen sends no touch events, so its click arrives.
      const click = new view.win.MouseEvent("click", { bubbles: true, cancelable: true, detail: 2 });
      view.text.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
      expect(clicks).toBe(0);
      view.text.dispatchEvent(new view.win.MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));
      expect(clicks).toBe(1);
      dom.root.removeEventListener("click", count);
    });

    test("a mouse double-click reacts instead of selecting a word, and keeps the link's own", async () => {
      const view = await mount();
      view.pointer("pointerdown", view.text, 120, 40, { pointerType: "mouse" });
      expect(view.mouse("mousedown", view.text, 1).defaultPrevented).toBe(false);
      expect(view.mouse("mousedown", view.text, 2).defaultPrevented).toBe(true);
      view.mouse("dblclick", view.text, 2);
      expect(view.calls.react).toBe(1);

      expect(view.mouse("mousedown", view.link, 2).defaultPrevented).toBe(false);
      view.mouse("dblclick", view.link, 2);
      expect(view.calls.react).toBe(1);

      // A browser's dblclick after a touch double tap does not react twice.
      view.tap(view.text);
      view.tap(view.text);
      view.mouse("dblclick", view.text, 2);
      expect(view.calls.react).toBe(2);
    });

    test("a long press opens the menu as a bottom sheet with the caller's top row", async () => {
      const view = await mount({ sheetTop: true });
      view.pointer("pointerdown", view.text, 120, 40);
      await settle(LONG_PRESS);
      const menu = view.sheet();
      expect(menu?.getAttribute("role")).toBe("menu");
      expect(menu?.getAttribute("aria-label")).toBe("Message from Nora");
      expect(dom.document.querySelector("dialog")?.getAttribute("aria-label")).toBe("Message from Nora");
      expect(dom.document.querySelector("dialog .quick")).not.toBeNull();
      expect([...(menu?.querySelectorAll("[role='menuitem']") ?? [])].map((item) => item.textContent)).toEqual([
        "Reply",
        "React with thumbs up",
        "Copy text",
      ]);
      view.pointer("pointerup", view.text, 120, 40);
      expect(view.touchEnd(view.text)).toBe(true);
      expect(view.calls).toEqual({ reply: 0, react: 0, copy: 0, archive: 0 });

      // Focus starts on the sheet itself; the arrow keys of a connected keyboard move from there into the menu.
      await settle(20);
      const dialog = dom.document.querySelector("dialog")!;
      expect(dom.document.activeElement).toBe(dialog);
      const items = [...(menu?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? [])];
      expect(items).toHaveLength(3);
      const key = (target: Element, name: string) =>
        target.dispatchEvent(new view.win.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
      key(dialog, "ArrowDown");
      expect(dom.document.activeElement).toBe(items[0]!);
      key(items[0]!, "ArrowUp");
      expect(dom.document.activeElement).toBe(items[2]!);
      dialog.focus();
      key(dialog, "ArrowUp");
      expect(dom.document.activeElement).toBe(items[2]!);
      dialog.focus();
      key(dialog, "End");
      expect(dom.document.activeElement).toBe(items[2]!);

      items[2]!.click();
      await settle(20);
      expect(view.calls.copy).toBe(1);
      expect(view.sheet()).toBeNull();
    });

    test("the sheet closes with its element", async () => {
      const view = await mount();
      view.pointer("pointerdown", view.text, 120, 40);
      await settle(LONG_PRESS);
      expect(view.sheet()).not.toBeNull();
      view.pointer("pointerup", view.text, 120, 40);
      // For example, the message was deleted while its sheet was open.
      dispose?.();
      dispose = undefined;
      await settle(20);
      expect(view.sheet()).toBeNull();
      const { dialogCore } = await import("../src/feedback/dialog-core");
      expect(dialogCore.isOpen()).toBe(false);
    });

    describe("long press from 48rem", () => {
      beforeEach(() => {
        Object.defineProperty(dom.window, "matchMedia", {
          configurable: true,
          writable: true,
          value: (query: string) => ({ matches: query === "(min-width: 48rem)", media: query }),
        });
      });

      const menu = () => dom.document.querySelector<HTMLElement>(".k2b-context-menu[role='menu']");

      test("opens the same items at the press point once and consumes the release", async () => {
        let opens = 0;
        const view = await mount({ sheetTop: true, onOpen: () => opens++ });
        view.pointer("pointerdown", view.text, 120, 40);
        await settle(LONG_PRESS);
        expect(menu()).not.toBeNull();
        expect([...menu()!.querySelectorAll("[role='menuitem']")].map((item) => item.textContent)).toEqual([
          "Reply",
          "React with thumbs up",
          "Copy text",
        ]);
        expect(menu()!.style.left).toBe("120px");
        expect(menu()!.style.top).toBe("40px");
        expect(view.sheet()).toBeNull();
        expect(dom.document.querySelector(".quick")).toBeNull();
        expect(view.host.getAttribute("aria-expanded")).toBe("true");
        expect(opens).toBe(1);
        expect(dom.document.activeElement).toBe(menu()!.querySelector("[role='menuitem']"));
        view.pointer("pointerup", view.text, 120, 40);
        expect(view.touchEnd(view.text)).toBe(true);
        await settle(20);
        expect(menu()).not.toBeNull();
        expect(view.calls).toEqual({ reply: 0, react: 0, copy: 0, archive: 0 });
        expect(opens).toBe(1);
      });

      test("a touch context-menu event opens at the press point immediately", async () => {
        let opens = 0;
        const view = await mount({ onOpen: () => opens++ });
        view.pointer("pointerdown", view.text, 120, 40);
        const event = new view.win.PointerEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          pointerType: "touch",
          clientX: 200,
          clientY: 80,
        });
        view.text.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(menu()).not.toBeNull();
        expect(menu()!.style.left).toBe("120px");
        expect(menu()!.style.top).toBe("40px");
        expect(view.sheet()).toBeNull();
        await settle(LONG_PRESS);
        expect(opens).toBe(1);
        view.pointer("pointerup", view.text, 120, 40);
        expect(view.touchEnd(view.text)).toBe(true);
      });

      test("moving more than 10 px before the hold opens nothing", async () => {
        const view = await mount();
        view.pointer("pointerdown", view.text, 120, 40);
        view.pointer("pointermove", view.text, 120, 52);
        await settle(LONG_PRESS);
        expect(menu()).toBeNull();
        expect(view.sheet()).toBeNull();
        expect(view.host.getAttribute("aria-expanded")).toBe("false");
        view.pointer("pointerup", view.text, 120, 52);
        expect(view.touchEnd(view.text)).toBe(false);
      });

      test("touch movement scrolls freely before the hold and is prevented only while held afterwards", async () => {
        const view = await mount();
        const move = (cancelable = true) => {
          const event = new view.win.Event("touchmove", { bubbles: true, cancelable });
          view.text.dispatchEvent(event);
          return event.defaultPrevented;
        };
        expect(move()).toBe(false);
        view.pointer("pointerdown", view.text, 120, 40);
        expect(move()).toBe(false);
        await settle(LONG_PRESS);
        view.pointer("pointermove", view.text, 120, 120);
        expect(move()).toBe(true);
        expect(move(false)).toBe(false);
        expect(menu()).not.toBeNull();
        expect(view.surface.dataset.swipe).toBeUndefined();
        view.pointer("pointerup", view.text, 120, 120);
        expect(move()).toBe(false);
        expect(view.touchEnd(view.text)).toBe(true);
      });

      test("Escape closes the popover and returns focus to the host", async () => {
        const view = await mount();
        view.pointer("pointerdown", view.text, 120, 40);
        await settle(LONG_PRESS);
        view.pointer("pointerup", view.text, 120, 40);
        view.touchEnd(view.text);
        const first = menu()!.querySelector<HTMLElement>("[role='menuitem']")!;
        expect(dom.document.activeElement).toBe(first);
        first.dispatchEvent(new view.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        expect(menu()).toBeNull();
        expect(view.host.getAttribute("aria-expanded")).toBe("false");
        expect(dom.document.activeElement).toBe(view.host);
      });

      test("chooses the width when the hold fires, rather than when the component mounts or the press starts", async () => {
        Reflect.deleteProperty(dom.window, "matchMedia");
        const view = await mount();
        view.pointer("pointerdown", view.text, 120, 40);
        Object.defineProperty(dom.window, "matchMedia", {
          configurable: true,
          value: (query: string) => ({ matches: query === "(min-width: 48rem)", media: query }),
        });
        await settle(LONG_PRESS);
        expect(menu()).not.toBeNull();
        expect(view.sheet()).toBeNull();
        view.pointer("pointerup", view.text, 120, 40);
        view.touchEnd(view.text);
      });
    });

    test("a sheet action runs once the sheet has closed and left the history, so it may navigate", async () => {
      const { dialogCore } = await import("../src/feedback/dialog-core");
      const marker = () => (history.state as { k2bDialog?: number } | null)?.k2bDialog;
      let seen: { open: boolean; marker: number | undefined } | undefined;
      const view = await mount({
        items: () => [
          {
            label: "Open thread",
            action: () => {
              seen = { open: dialogCore.isOpen(), marker: marker() };
              history.pushState({ thread: 1 }, "", "/thread");
            },
          },
        ],
      });
      view.pointer("pointerdown", view.text, 120, 40);
      await settle(LONG_PRESS);
      view.pointer("pointerup", view.text, 120, 40);
      view.sheet()?.querySelector<HTMLElement>("[role='menuitem']")?.click();
      await settle(50);
      expect(seen).toEqual({ open: false, marker: undefined });
      // Back from the thread returns to the page itself, not to a leftover entry of the sheet.
      const back = new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
      history.back();
      await back;
      expect(location.pathname).toBe("/");
      expect(marker()).toBeUndefined();
    });

    test("a sheet action that stays open runs synchronously and updates its getters in the same row", async () => {
      const { dialogCore } = await import("../src/feedback/dialog-core");
      const marker = () => (history.state as { k2bDialog?: number } | null)?.k2bDialog;
      const settings = [
        ["System", "ti ti-device-laptop"],
        ["Light", "ti ti-sun-high"],
        ["Dark", "ti ti-moon"],
      ] as const;
      const [setting, setSetting] = createSignal(0);
      const view = await mount({
        items: (calls) => {
          const item: DropdownAction = {
            get label() {
              return settings[setting()]![0];
            },
            get ariaLabel() {
              return `Appearance: ${settings[setting()]![0]}`;
            },
            get icon() {
              return settings[setting()]![1];
            },
            closeOnSelect: false,
            action: () => {
              calls.copy++;
              setSetting((current) => (current + 1) % settings.length);
            },
          };
          return [item];
        },
      });
      view.pointer("pointerdown", view.text, 120, 40);
      await settle(LONG_PRESS);
      view.pointer("pointerup", view.text, 120, 40);
      const sheet = view.sheet()!;
      const row = sheet.querySelector<HTMLElement>("[role='menuitem']")!;
      const sheetMarker = marker();
      expect(sheetMarker).toBeDefined();
      expect(row.textContent).toBe("System");
      expect(row.getAttribute("aria-label")).toBe("Appearance: System");
      expect(row.querySelector("i")?.className).toBe("ti ti-device-laptop");
      for (const [index, [label, icon]] of settings.entries()) {
        if (index === 0) continue;
        row.click();
        expect(view.calls.copy).toBe(index);
        expect(dialogCore.isOpen()).toBe(true);
        expect(marker()).toBe(sheetMarker);
        expect(view.sheet()).toBe(sheet);
        expect(sheet.querySelector("[role='menuitem']")).toBe(row);
        expect(row.textContent).toBe(label);
        expect(row.getAttribute("aria-label")).toBe(`Appearance: ${label}`);
        expect(row.querySelector("i")?.className).toBe(icon);
      }
      await settle(50);
      expect(view.calls.copy).toBe(2);
      expect(dialogCore.isOpen()).toBe(true);
      expect(marker()).toBe(sheetMarker);
      expect(view.sheet()).toBe(sheet);
    });

    test("the sheet speaks the locale the element inherits", async () => {
      const view = await mount({ locale: "de" });
      view.pointer("pointerdown", view.text, 120, 40);
      await settle(LONG_PRESS);
      expect(dom.document.querySelector(".k2b-bottom-sheet__handle")?.getAttribute("aria-label")).toBe("Schließen");
      view.pointer("pointerup", view.text, 120, 40);
    });

    test("moving or lifting the finger before the long press ends it, and links keep their own", async () => {
      const view = await mount();
      view.pointer("pointerdown", view.text, 120, 40);
      view.pointer("pointermove", view.text, 120, 60);
      await settle(LONG_PRESS);
      expect(view.sheet()).toBeNull();
      view.pointer("pointerup", view.text, 120, 60);

      view.pointer("pointerdown", view.text, 120, 40);
      await settle(200);
      view.pointer("pointerup", view.text, 120, 40);
      await settle(LONG_PRESS - 200);
      expect(view.sheet()).toBeNull();

      view.pointer("pointerdown", view.link, 120, 40);
      await settle(LONG_PRESS);
      expect(view.sheet()).toBeNull();
      view.pointer("pointerup", view.link, 120, 40);
    });

    test("a touch context-menu event opens the sheet at once; a right-click goes to the menu beside the element", async () => {
      const view = await mount();
      view.pointer("pointerdown", view.text, 120, 40);
      const touch = new view.win.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      view.text.dispatchEvent(touch);
      expect(touch.defaultPrevented).toBe(true);
      expect(view.sheet()).not.toBeNull();
      await settle(LONG_PRESS);
      expect(dom.document.querySelectorAll(".k2b-gesture-menu__sheet-menu")).toHaveLength(1);
      view.pointer("pointerup", view.text, 120, 40);
      await closeSheets();

      // A mouse right-click passes the surface on to ContextMenu, which opens its menu at the pointer.
      view.pointer("pointerdown", view.text, 120, 40, { pointerType: "mouse", button: 2 });
      const right = new view.win.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 30 });
      view.text.dispatchEvent(right);
      await settle(10);
      expect(view.sheet()).toBeNull();
      expect(view.host.getAttribute("aria-expanded")).toBe("true");
      expect(dom.document.querySelector(".k2b-context-menu")?.textContent).toContain("Copy text");

      // On a link the browser's own menu stays.
      const onLink = new view.win.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      view.link.dispatchEvent(onLink);
      expect(onLink.defaultPrevented).toBe(false);
      expect(onLink.cancelBubble).toBe(true);
      dispose?.();

      // Without items, a long press keeps the browser's own menu everywhere.
      const empty = await mount({ items: () => [] });
      const inactive = new view.win.PointerEvent("contextmenu", { bubbles: true, cancelable: true, pointerType: "touch" });
      empty.text.dispatchEvent(inactive);
      expect(inactive.defaultPrevented).toBe(false);
    });
  });
