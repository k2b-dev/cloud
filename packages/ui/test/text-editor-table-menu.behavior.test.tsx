import { describe, expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

const doc = "Before\n\n| Name | Value |\n| --- | --- |\n| Paper | 4 |\n| Ink | 2 |\n\nAfter";

if (isServer) test.skip("requires browser conditions", () => {});
else
  describe("approved table menu", () => {
    const mount = async (phone = false) => {
      const dom = createDomTestHarness();
      dom.window.happyDOM.setWindowSize({ width: phone ? 390 : 1280, height: 900 });
      const previousMatchMedia = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
      Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: dom.window.matchMedia.bind(dom.window) });
      const popovers = new WeakSet<HTMLElement>();
      const prototype = HTMLElement.prototype;
      const matches = prototype.matches;
      Object.defineProperty(prototype, "matches", {
        configurable: true,
        value(this: HTMLElement, selector: string) {
          return selector === ":popover-open" ? popovers.has(this) : matches.call(this, selector);
        },
      });
      const toggle = (element: HTMLElement, open: boolean) => {
        const oldState = popovers.has(element) ? "open" : "closed";
        if (open) popovers.add(element);
        else popovers.delete(element);
        const event = new Event("toggle");
        Object.defineProperties(event, { oldState: { value: oldState }, newState: { value: open ? "open" : "closed" } });
        element.dispatchEvent(event);
      };
      prototype.showPopover = function () {
        toggle(this, true);
      };
      prototype.hidePopover = function () {
        toggle(this, false);
      };
      const { TextEditor } = await import("../src/text-editor/TextEditor");
      const { dialogCore } = await import("../src/feedback/dialog-core");
      const dispose = render(() => <TextEditor label="Note" initialValue={doc} maxLength={10_000} />, dom.root);
      const cell = (r: number, c: number) => dom.root.querySelector<HTMLElement>(`.k2b-ste-cell[data-r="${r}"][data-c="${c}"]`)!;
      // Grips, right-click and keys open the cell menu without a trigger; find the open one.
      const menu = () => {
        if (phone) return dom.document.querySelector<HTMLElement>("dialog [role='menu']")!;
        return [...dom.document.querySelectorAll<HTMLElement>(".k2b-ste-table-menu")].find((element) => element.matches(":popover-open"))!;
      };
      const item = (label: string) =>
        [...menu().querySelectorAll<HTMLButtonElement>("[role^='menuitem']")].find(
          (element) => element.querySelector(".k2b-dropdown__copy > span")?.textContent === label,
        )!;
      const open = () => {
        cell(1, 0).focus();
        dom.root.querySelector<HTMLButtonElement>(".k2b-ste-table-tool")!.click();
      };
      return {
        dom,
        cell,
        menu,
        item,
        open,
        dialogCore,
        async cleanup() {
          if (dialogCore.isOpen()) {
            dialogCore.close();
            await Bun.sleep(30);
          }
          dispose();
          await Promise.resolve();
          if (previousMatchMedia) Object.defineProperty(globalThis, "matchMedia", previousMatchMedia);
          else Reflect.deleteProperty(globalThis, "matchMedia");
          dom.cleanup();
        },
      };
    };

    test("every trigger exposes the full shared inventory, boundary states and header checkbox", async () => {
      const h = await mount();
      try {
        h.open();
        const labels = () =>
          [...h.menu().querySelectorAll("[role^='menuitem'] .k2b-dropdown__copy > span")].map((node) => node.textContent);
        const inventory = labels();
        expect(inventory).toEqual([
          "Insert row above",
          "Insert row below",
          "Move row up",
          "Move row down",
          "Delete row",
          "Insert column left",
          "Insert column right",
          "Move column left",
          "Move column right",
          "Left",
          "Center",
          "Right",
          "Delete column",
          "Header row",
          "Edit as Markdown",
          "Copy table",
          "Copy as Markdown",
          "Delete table",
        ]);
        expect([...h.menu().querySelectorAll(".k2b-dropdown__label")].map((node) => node.textContent)).toEqual([
          "Row 1 · Column “Name”",
          "Row 1",
          "Column “Name”",
          "Alignment",
          "Table",
        ]);
        expect(h.menu().dataset.variant).toBe("default");
        expect(h.menu().classList.contains("k2b-ste-table-menu")).toBe(true);
        expect(h.item("Move row up").disabled).toBe(true);
        expect(h.item("Move column left").disabled).toBe(true);
        expect(h.item("Move row down").disabled).toBe(false);
        expect(h.item("Header row").getAttribute("role")).toBe("menuitemcheckbox");
        expect(h.item("Header row").getAttribute("aria-checked")).toBe("true");
        const move = h.item("Move row down");
        move.focus();
        move.click();
        await Promise.resolve();
        await Promise.resolve();
        expect(h.item("Move row down") === move).toBe(true);
        expect(move.disabled).toBe(true);
        expect(h.menu().contains(h.dom.document.activeElement)).toBe(true);
        h.item("Move row up").click();
        await Promise.resolve();

        h.dom.root.querySelector<HTMLButtonElement>(".k2b-ste-table-tool")!.click();
        await Promise.resolve();
        // A row grip shows row and table actions, a column grip column, alignment and table actions;
        // right-click and keys show everything. No cell or header carries a menu button.
        const table = inventory.slice(-5);
        const scoped: Record<string, { entries: string[]; headings: string[] }> = {
          row: { entries: [...inventory.slice(0, 5), ...table], headings: ["Row 1", "Table"] },
          column: { entries: [...inventory.slice(5, 13), ...table], headings: ["Column “Name”", "Alignment", "Table"] },
          context: { entries: inventory, headings: ["Row 1 · Column “Name”", "Row 1", "Column “Name”", "Alignment", "Table"] },
          keyboard: { entries: inventory, headings: ["Row 1 · Column “Name”", "Row 1", "Column “Name”", "Alignment", "Table"] },
        };
        expect(h.dom.root.querySelectorAll(".k2b-ste-table .k2b-dropdown__trigger, .k2b-ste-table .ti-dots")).toHaveLength(0);
        for (const trigger of ["row", "column", "context", "keyboard"]) {
          h.cell(1, 0).focus();
          if (trigger === "row") h.cell(1, 0).parentElement!.querySelector<HTMLButtonElement>(".k2b-ste-rowMenu")!.click();
          else if (trigger === "column") h.cell(0, 0).parentElement!.querySelector<HTMLButtonElement>(".k2b-ste-columnMenu")!.click();
          else if (trigger === "context") h.cell(1, 0).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
          else h.cell(1, 0).dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }));
          await Promise.resolve();
          expect(h.menu() !== undefined, trigger).toBe(true);
          expect(labels(), trigger).toEqual(scoped[trigger]!.entries);
          expect(
            [...h.menu().querySelectorAll(".k2b-dropdown__label")].map((node) => node.textContent),
            trigger,
          ).toEqual(scoped[trigger]!.headings);
          h.menu().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
          await Promise.resolve();
          expect(h.menu(), trigger).toBeUndefined();
        }
      } finally {
        await h.cleanup();
      }
    });

    test("phone movement keeps the sheet open and updates boundary states in place", async () => {
      const h = await mount(true);
      try {
        h.open();
        expect(h.dialogCore.isOpen()).toBe(true);
        expect(h.item("Move up").disabled).toBe(true);
        const down = h.item("Move down");
        down.click();
        await Promise.resolve();
        expect(h.dialogCore.isOpen()).toBe(true);
        expect(h.item("Move down").disabled).toBe(true);
        expect(h.item("Move up").disabled).toBe(false);
        expect(h.cell(2, 0).textContent).toBe("Paper");
        expect(h.menu().querySelectorAll(".k2b-dropdown__label")[1]!.textContent).toBe("Row 2");
        h.item("Move right").click();
        await Promise.resolve();
        expect(h.dialogCore.isOpen()).toBe(true);
        expect(h.item("Move right").disabled).toBe(true);
        expect(h.item("Move left").disabled).toBe(false);
        h.item("Move up").click();
        await Promise.resolve();
        expect(h.cell(1, 1).textContent).toBe("Paper");
        expect(h.item("Move up").disabled).toBe(true);
      } finally {
        await h.cleanup();
      }
    });

    test("copy reports pending, confirmed success and permission failure through the actual clipboard path", async () => {
      const h = await mount();
      let finish: (() => void) | undefined;
      let reject = false;
      const values: string[] = [];
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: (text: string) => {
            values.push(text);
            if (reject) return Promise.reject(new Error("permission denied"));
            return new Promise<void>((resolve) => {
              finish = resolve;
            });
          },
        },
      });
      try {
        h.open();
        h.item("Copy as Markdown").click();
        expect(values).toEqual([doc.slice(doc.indexOf("| Name"), doc.indexOf("\n\nAfter"))]);
        expect(h.dom.root.querySelector(".k2b-ste-notice")?.textContent).toContain("Copying table");
        expect(h.dom.root.querySelector(".k2b-ste-notice")?.textContent).not.toContain("Markdown copied");
        finish!();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(h.dom.root.querySelector(".k2b-ste-notice")?.textContent).toContain("Markdown copied");
        reject = true;
        h.open();
        h.item("Copy as Markdown").click();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(h.dom.root.querySelector(".k2b-ste-notice")?.textContent).toContain("Could not copy");
        expect(h.dom.root.querySelector(".k2b-ste-notice")?.textContent).not.toContain("Markdown copied");
      } finally {
        await h.cleanup();
      }
    });
  });
