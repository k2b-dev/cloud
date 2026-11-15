import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "./dom";

// The phone sheets' code arrives as its own chunks; here every attempt to load them fails, as after a deploy or offline.
let attempts = 0;
mock.module("../src/actions/menu-sheet", () => {
  attempts++;
  throw new Error("the sheet's chunk did not load");
});
mock.module("../src/layout/BottomSheet", () => {
  throw new Error("the sheet's chunk did not load");
});

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check: () => unknown) => {
  for (let turn = 0; turn < 50 && !check(); turn++) await settle(5);
};

if (isServer) test.skip("requires browser conditions", () => {});
else
  describe("a phone sheet whose code does not load", () => {
    let dom: DomTestHarness;
    let dispose: (() => void) | undefined;
    let reported: ReturnType<typeof spyOn<typeof globalThis, "reportError">>;
    const restore: (() => void)[] = [];
    const define = (target: object, key: string, value: unknown) => {
      const previous = Object.getOwnPropertyDescriptor(target, key);
      Object.defineProperty(target, key, { configurable: true, writable: true, value });
      restore.push(() => (previous ? Object.defineProperty(target, key, previous) : Reflect.deleteProperty(target, key)));
    };

    beforeEach(() => {
      attempts = 0;
      dom = createDomTestHarness();
      dom.window.happyDOM.setWindowSize({ width: 390, height: 844 });
      define(globalThis, "matchMedia", dom.window.matchMedia.bind(dom.window));
      define(dom.window, "innerWidth", 390);
      define(globalThis, "DOMRect", dom.window.DOMRect);
      // happy-dom has no popovers; this follows the browser's order: the state now, the toggle event after.
      const popovers = new WeakSet<HTMLElement>();
      const matches = HTMLElement.prototype.matches;
      const toggle = (element: HTMLElement, open: boolean) => {
        const oldState = popovers.has(element) ? "open" : "closed";
        if (open) popovers.add(element);
        else popovers.delete(element);
        const event = new Event("toggle");
        Object.defineProperties(event, { oldState: { value: oldState }, newState: { value: open ? "open" : "closed" } });
        setTimeout(() => element.dispatchEvent(event));
      };
      define(HTMLElement.prototype, "matches", function (this: HTMLElement, selector: string) {
        return selector === ":popover-open" ? popovers.has(this) : matches.call(this, selector);
      });
      define(HTMLElement.prototype, "showPopover", function (this: HTMLElement) {
        toggle(this, true);
      });
      define(HTMLElement.prototype, "hidePopover", function (this: HTMLElement) {
        toggle(this, false);
      });
      reported = spyOn(globalThis, "reportError").mockImplementation(() => {});
    });
    afterEach(async () => {
      dispose?.();
      dispose = undefined;
      await settle(10);
      reported.mockRestore();
      for (const undo of restore.splice(0).reverse()) undo();
      dom.cleanup();
    });

    test("a dropdown opens its menu in place, works, reports once, and tries the sheet again next time", async () => {
      const { Dropdown } = await import("../src/actions/Dropdown");
      const { dialogCore } = await import("../src/feedback/dialog-core");
      const ran: string[] = [];
      const heard: boolean[] = [];
      dispose = render(
        () => (
          <Dropdown.Root
            phone="sheet"
            label="Note actions"
            onOpenChange={(open) => heard.push(open)}
            items={[{ label: "Duplicate", action: () => ran.push("duplicate") }]}
          >
            <Dropdown.Trigger>Note actions</Dropdown.Trigger>
          </Dropdown.Root>
        ),
        dom.root,
      );
      const trigger = dom.root.querySelector<HTMLButtonElement>("button")!;
      const menu = dom.root.querySelector<HTMLElement>("[role='menu']")!;
      const shown = () => menu.matches(":popover-open");

      trigger.click();
      await until(shown);
      // The person still chooses: the menu that is always in the page opens instead of the sheet.
      expect(shown()).toBe(true);
      expect(dialogCore.isOpen()).toBe(false);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(reported).toHaveBeenCalledTimes(1);
      await settle(10);
      // The owner hears one open, not one for the sheet and one for the menu.
      expect(heard).toEqual([true]);
      // A phone also tried in the background when the menus loaded; that failure stays quiet until someone opens.
      const tried = attempts;
      expect(tried).toBeGreaterThan(0);

      menu.querySelector<HTMLElement>("[role='menuitem']")!.click();
      await until(() => !shown());
      await settle(10);
      expect(ran).toEqual(["duplicate"]);
      expect(heard).toEqual([true, false]);
      expect(trigger.getAttribute("aria-expanded")).toBe("false");

      // The next open tries the sheet's code once more, and nothing keeps retrying in between.
      trigger.click();
      await until(shown);
      expect(shown()).toBe(true);
      expect(attempts).toBe(tried + 1);
      await settle(50);
      expect(attempts).toBe(tried + 1);
      expect(reported).toHaveBeenCalledTimes(2);
    });

    test("a second tap while the sheet's code loads cancels it, and the owner hears both ends", async () => {
      const { Dropdown } = await import("../src/actions/Dropdown");
      const heard: boolean[] = [];
      dispose = render(
        () => (
          <Dropdown.Root
            phone="sheet"
            label="Note actions"
            onOpenChange={(open) => heard.push(open)}
            items={[{ label: "Duplicate", action: () => {} }]}
          >
            <Dropdown.Trigger>Note actions</Dropdown.Trigger>
          </Dropdown.Root>
        ),
        dom.root,
      );
      const trigger = dom.root.querySelector<HTMLButtonElement>("button")!;
      const menu = dom.root.querySelector<HTMLElement>("[role='menu']")!;
      trigger.click();
      trigger.click();
      // At once, before the import settles, as when a download stalls.
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(heard).toEqual([true, false]);
      await settle(50);
      // Neither a late sheet nor the menu in its place opens after the second tap.
      expect(menu.matches(":popover-open")).toBe(false);
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(heard).toEqual([true, false]);
    });

    test("a menu disabled while the sheet's code loads ends at once and opens again once enabled", async () => {
      const { Dropdown } = await import("../src/actions/Dropdown");
      const heard: boolean[] = [];
      const [disabled, setDisabled] = createSignal(false);
      dispose = render(
        () => (
          <Dropdown.Root
            phone="sheet"
            label="Note actions"
            disabled={disabled()}
            onOpenChange={(open) => heard.push(open)}
            items={[{ label: "Duplicate", action: () => {} }]}
          >
            <Dropdown.Trigger>Note actions</Dropdown.Trigger>
          </Dropdown.Root>
        ),
        dom.root,
      );
      const trigger = dom.root.querySelector<HTMLButtonElement>("button")!;
      const menu = dom.root.querySelector<HTMLElement>("[role='menu']")!;
      trigger.click();
      setDisabled(true);
      // At once, before the import settles, as when a download stalls.
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(heard).toEqual([true, false]);
      await settle(50);
      expect(menu.matches(":popover-open")).toBe(false);

      setDisabled(false);
      trigger.click();
      await until(() => menu.matches(":popover-open"));
      expect(menu.matches(":popover-open")).toBe(true);
    });

    test("All opens the same sidebar in the prompt dialog instead, and it closes", async () => {
      const { default: AppWorkspace } = await import("../src/layout/AppWorkspace");
      const { dialogCore } = await import("../src/feedback/dialog-core");
      // happy-dom lays nothing out; All shows, as in a chip row on a phone.
      define(HTMLElement.prototype, "getClientRects", () => [new DOMRect(0, 0, 80, 32)]);
      dispose = render(
        () => (
          <AppWorkspace controller={false}>
            <AppWorkspace.Sidebar label="Folders" mobile="stacked">
              <AppWorkspace.SidebarDesktop>
                <a href="#inbox">Inbox</a>
              </AppWorkspace.SidebarDesktop>
            </AppWorkspace.Sidebar>
            <AppWorkspace.Content>
              <AppWorkspace.Main>Message</AppWorkspace.Main>
            </AppWorkspace.Content>
          </AppWorkspace>
        ),
        dom.root,
      );
      const all = dom.root.querySelector<HTMLButtonElement>(".k2b-app-workspace__sidebar-all")!;
      const sheet = () => dom.document.querySelector<HTMLElement>("dialog nav.k2b-app-workspace__sidebar-sheet");
      all.click();
      await until(sheet);
      expect(sheet()?.querySelector("a[href='#inbox']")?.textContent).toBe("Inbox");
      expect(dom.document.querySelector("dialog .k2b-dialog__header h2")?.textContent).toBe("Folders");
      expect(dom.document.querySelector("dialog .k2b-bottom-sheet")).toBeNull();
      expect(all.getAttribute("aria-expanded")).toBe("true");
      expect(reported).toHaveBeenCalledTimes(1);

      dom.document.querySelector<HTMLButtonElement>("dialog .k2b-dialog__close")!.click();
      await until(() => !dialogCore.isOpen());
      await settle(10);
      expect(dialogCore.isOpen()).toBe(false);
      expect(all.getAttribute("aria-expanded")).toBe("false");
    });

    test("a long press opens the menu beside the finger instead, once, and it works", async () => {
      const { GestureMenu } = await import("../src/actions/GestureMenu");
      const { dialogCore } = await import("../src/feedback/dialog-core");
      let copied = 0;
      let opens = 0;
      dispose = render(
        () => (
          <GestureMenu label="Message from Nora" onOpen={() => opens++} items={[{ label: "Copy text", action: () => copied++ }]}>
            <p class="text">Hello</p>
          </GestureMenu>
        ),
        dom.root,
      );
      const text = dom.root.querySelector<HTMLElement>(".text")!;
      const win = dom.window as unknown as { PointerEvent: typeof PointerEvent; Event: typeof Event };
      const pointer = (type: string) =>
        text.dispatchEvent(
          new win.PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 3,
            pointerType: "touch",
            isPrimary: true,
            clientX: 120,
            clientY: 40,
          }),
        );
      const menu = () => dom.document.querySelector<HTMLElement>(".k2b-context-menu[role='menu']");

      pointer("pointerdown");
      await settle(550);
      await until(menu);
      expect(menu()).not.toBeNull();
      expect(menu()!.style.left).toBe("120px");
      expect(dialogCore.isOpen()).toBe(false);
      expect(opens).toBe(1);
      expect(reported).toHaveBeenCalledTimes(1);
      pointer("pointerup");
      text.dispatchEvent(new win.Event("touchend", { bubbles: true, cancelable: true }));
      await settle(20);

      menu()!.querySelector<HTMLElement>("[role='menuitem']")!.click();
      await settle(10);
      expect(copied).toBe(1);
    });

    test("inside a modal dialog the menu in place of the sheet stays in that dialog, in the top layer, and works", async () => {
      const { GestureMenu } = await import("../src/actions/GestureMenu");
      let copied = 0;
      const dialog = dom.document.createElement("dialog");
      dom.document.body.append(dialog);
      dialog.showModal();
      dispose = render(
        () => (
          <GestureMenu label="Message from Nora" items={[{ label: "Copy text", action: () => copied++ }]}>
            <p class="text">Hello</p>
          </GestureMenu>
        ),
        dialog,
      );
      const text = dialog.querySelector<HTMLElement>(".text")!;
      const win = dom.window as unknown as { PointerEvent: typeof PointerEvent; Event: typeof Event };
      const pointer = (type: string) =>
        text.dispatchEvent(
          new win.PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 3,
            pointerType: "touch",
            isPrimary: true,
            clientX: 120,
            clientY: 40,
          }),
        );
      const menu = () => dom.document.querySelector<HTMLElement>(".k2b-context-menu[role='menu']");

      pointer("pointerdown");
      await settle(550);
      await until(() => menu()?.matches(":popover-open"));
      // Outside the dialog the page is inert; inside it, and above it in the top layer, the menu takes taps.
      expect(dialog.contains(menu())).toBe(true);
      expect(menu()!.matches(":popover-open")).toBe(true);
      expect(reported).toHaveBeenCalledTimes(1);
      pointer("pointerup");
      text.dispatchEvent(new win.Event("touchend", { bubbles: true, cancelable: true }));
      await settle(20);

      menu()!.querySelector<HTMLElement>("[role='menuitem']")!.click();
      await settle(10);
      expect(copied).toBe(1);
      expect(menu()).toBeNull();
      dispose?.();
      dispose = undefined;
      dialog.close();
    });
  });
