import { describe, expect, test } from "bun:test";
import { EditorSelection } from "@codemirror/state";
import { runScopeHandlers } from "@codemirror/view";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { TextEditorController } from "../src/text-editor/engine";
import { editTableSource, formatActiveCell, type MenuAction, runMenuAction, runTableAction } from "../src/text-editor/table";
import { createDomTestHarness } from "./dom";

const doc = "Before\n\n| Value |\n| --- |\n| =SUM(1,2) |\n\nAfter";

if (isServer) test.skip("requires browser conditions", () => {});
else
  describe("approved read-only tables", () => {
    const mount = async (phone = false, readonly = true, toolbar = true) => {
      const dom = createDomTestHarness();
      dom.root.className = "k2b-ui";
      dom.window.happyDOM.setWindowSize({ width: phone ? 390 : 1280, height: 900 });
      const css = dom.document.createElement("style");
      css.textContent = await Bun.file(new URL("../src/styles/text-editor.css", import.meta.url)).text();
      dom.document.head.append(css);
      const savedMatchMedia = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
      Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: dom.window.matchMedia.bind(dom.window) });
      const prototype = HTMLElement.prototype;
      const matches = prototype.matches;
      const open = new WeakSet<HTMLElement>();
      Object.defineProperty(prototype, "matches", {
        configurable: true,
        value(this: HTMLElement, selector: string) {
          return selector === ":popover-open" ? open.has(this) : matches.call(this, selector);
        },
      });
      const toggle = (element: HTMLElement, next: boolean) => {
        const event = new Event("toggle");
        Object.defineProperties(event, {
          oldState: { value: open.has(element) ? "open" : "closed" },
          newState: { value: next ? "open" : "closed" },
        });
        if (next) open.add(element);
        else open.delete(element);
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
      const [readOnly, setReadOnly] = createSignal(readonly);
      const changes: string[] = [];
      const actions: string[] = [];
      let editor!: TextEditorController;
      const dispose = render(
        () => (
          <TextEditor
            label="Note"
            initialValue={doc}
            readOnly={readOnly()}
            toolbar={toolbar}
            maxLength={10_000}
            host={{
              structure: {
                available: () => true,
                perform: async (action) => {
                  actions.push(action);
                },
              },
              undo: () => {
                actions.push("undo");
              },
              redo: () => {
                actions.push("redo");
              },
              renderCell(element, raw) {
                element.innerHTML = raw.startsWith("=") ? "<span>3</span>" : `<span>${raw}</span>`;
              },
            }}
            onReady={(value) => {
              editor = value;
            }}
            onChange={(text) => changes.push(text)}
          />
        ),
        dom.root,
      );
      const cell = () => dom.root.querySelector<HTMLElement>('.k2b-ste-cell[data-r="1"]')!;
      const wrap = () => dom.root.querySelector<HTMLElement>(".k2b-ste-table")!;
      const menu = () => {
        if (phone) return dom.document.querySelector<HTMLElement>("dialog [role='menu']")!;
        const trigger = dom.root.querySelector<HTMLElement>(".k2b-dropdown__trigger[aria-expanded='true']");
        return dom.document.getElementById(trigger?.getAttribute("aria-controls") ?? "")!;
      };
      const key = (key: string, extra: KeyboardEventInit = {}) => {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra });
        cell().dispatchEvent(event);
        return event;
      };
      return {
        dom,
        editor,
        actions,
        changes,
        cell,
        wrap,
        menu,
        key,
        setReadOnly,
        dialogCore,
        async cleanup() {
          if (dialogCore.isOpen()) {
            dialogCore.close();
            await Bun.sleep(30);
          }
          dispose();
          await Promise.resolve();
          if (savedMatchMedia) Object.defineProperty(globalThis, "matchMedia", savedMatchMedia);
          else Reflect.deleteProperty(globalThis, "matchMedia");
          dom.cleanup();
        },
      };
    };

    test("desktop context and keyboard menus offer only copy, preserving computed presentation and selection", async () => {
      const h = await mount();
      const texts: string[] = [];
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            texts.push(text);
          },
        },
      });
      try {
        h.cell().focus();
        expect(h.cell().textContent).toBe("3");
        expect(h.cell().contentEditable).toBe("false");
        expect(h.cell().getAttribute("aria-readonly")).toBe("true");
        expect(h.wrap().querySelector("table")!.getAttribute("aria-readonly")).toBe("true");
        expect(getComputedStyle(h.dom.root.querySelector(".k2b-ste-copy-menu")!).visibility).toBe("hidden");
        const text = h.cell().querySelector("span")!.firstChild!;
        h.dom.document.getSelection()!.setBaseAndExtent(text, 0, text, 1);
        expect(h.key("a", { ctrlKey: true }).defaultPrevented).toBe(false);
        const nativeCopy = new Event("copy", { bubbles: true, cancelable: true });
        h.cell().dispatchEvent(nativeCopy);
        expect(nativeCopy.defaultPrevented).toBe(false);
        expect(h.dom.document.getSelection()!.toString()).toBe("3");
        for (const trigger of ["context", "shiftF10", "contextKey"]) {
          if (trigger === "context") h.cell().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
          else h.key(trigger === "shiftF10" ? "F10" : "ContextMenu", { shiftKey: trigger === "shiftF10" });
          await Promise.resolve();
          const items = [...h.menu().querySelectorAll<HTMLButtonElement>("[role^='menuitem']")];
          expect(items.map((item) => item.textContent)).toEqual(["Copy table", "Copy as Markdown"]);
          expect(items.every((item) => !item.disabled)).toBe(true);
          expect(h.cell().textContent).toBe("3");
          expect(h.cell().querySelector("span")!.firstChild === text).toBe(true);
          expect(h.dom.document.getSelection()!.toString()).toBe("3");
          items[trigger === "context" ? 0 : 1]!.click();
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
          h.cell().focus();
        }
        expect(texts).toEqual([
          "Value\n3",
          doc.slice(doc.indexOf("| Value"), doc.indexOf("\n\nAfter")),
          doc.slice(doc.indexOf("| Value"), doc.indexOf("\n\nAfter")),
        ]);
        expect(h.changes).toEqual([]);
        expect(h.actions).toEqual([]);
      } finally {
        await h.cleanup();
      }
    });

    test("an open phone sheet closes on permission loss even without a toolbar, then offers only copy", async () => {
      const h = await mount(true, false, false);
      try {
        h.cell().focus();
        h.key("F10", { shiftKey: true });
        await Promise.resolve();
        expect(h.menu().textContent).toContain("Edit as Markdown");
        h.setReadOnly(true);
        await Bun.sleep(30);
        expect(h.dialogCore.isOpen()).toBe(false);
        h.cell().focus();
        h.key("F10", { shiftKey: true });
        await Promise.resolve();
        expect([...h.menu().querySelectorAll("[role^='menuitem']")].map((item) => item.textContent)).toEqual([
          "Copy table",
          "Copy as Markdown",
        ]);
        expect(h.changes).toEqual([]);
        expect(h.actions).toEqual([]);
      } finally {
        await h.cleanup();
      }
    });

    test("keyboard entry from prose keeps a read-only formula computed", async () => {
      const h = await mount();
      const moveVertically = h.editor.view.moveVertically;
      try {
        h.editor.view.dispatch({ selection: { anchor: doc.indexOf("\n\nAfter") + 1 } });
        h.editor.view.focus();
        // DOM-only tests have no rendered line geometry; model the visual step
        // while exercising the installed public ArrowUp keymap.
        h.editor.view.moveVertically = () => EditorSelection.cursor(0);
        expect(runScopeHandlers(h.editor.view, new KeyboardEvent("keydown", { key: "ArrowUp" }), "editor")).toBe(true);
        expect(h.dom.document.activeElement === h.cell()).toBe(true);
        expect(h.cell().textContent).toBe("3");
        expect(h.cell().dataset.editing).toBe("0");
        expect(h.editor.view.state.doc.toString()).toBe(doc);
      } finally {
        h.editor.view.moveVertically = moveVertically;
        await h.cleanup();
      }
    });

    test("phone exposes its copy control under the selected table with no edit affordances", async () => {
      const h = await mount(true);
      try {
        expect(h.dom.root.querySelector(".k2b-ste-copy-menu")).toBeNull();
        Object.defineProperty(h.wrap(), "getBoundingClientRect", {
          value: () => ({ left: 0, right: 300, top: 10, bottom: 210, height: 200 }),
        });
        h.cell().focus();
        const copy = h.dom.root.querySelector<HTMLButtonElement>(".k2b-ste-copy-menu")!;
        expect(copy.textContent).toBe("Copy table");
        expect(copy.disabled).toBe(false);
        expect(getComputedStyle(copy).visibility).toBe("visible");
        expect(getComputedStyle(copy).minHeight).toBe("44px");
        const control = copy.closest<HTMLElement>(".k2b-ste-floating-menu")!;
        expect(getComputedStyle(control).display).toBe("block");
        expect(Number.parseFloat(control.style.top)).toBe(166);
        expect(h.dom.root.querySelector(".k2b-ste-toolbar")).toBeNull();
        for (const button of h.wrap().querySelectorAll<HTMLButtonElement>(".k2b-ste-grip, .k2b-ste-table-add button")) {
          expect(button.disabled).toBe(true);
          expect(button.hidden).toBe(true);
        }
        expect(getComputedStyle(h.wrap().querySelector(".k2b-ste-table-add")!).display).toBe("none");
        copy.click();
        expect(h.dialogCore.isOpen()).toBe(true);
        expect([...h.menu().querySelectorAll("[role^='menuitem']")].map((item) => item.textContent)).toEqual([
          "Copy table",
          "Copy as Markdown",
        ]);
        expect(h.cell().textContent).toBe("3");
        expect(h.editor.view.state.doc.toString()).toBe(doc);
        expect(getComputedStyle(h.cell()).maxWidth).toBe("136px");
        expect(getComputedStyle(h.cell().parentElement!).maxWidth).toBe("224px");
      } finally {
        await h.cleanup();
      }
    });

    test("all mutation paths refuse read-only input, structure, history, formatting and source editing", async () => {
      const h = await mount();
      try {
        h.cell().focus();
        for (const [key, extra] of [
          ["Enter", {}],
          ["Tab", {}],
          ["ArrowDown", { altKey: true }],
          ["ArrowRight", { altKey: true }],
          ["b", { ctrlKey: true }],
          ["z", { ctrlKey: true }],
          ["y", { ctrlKey: true }],
        ] as const)
          h.key(key, extra);
        for (const inputType of ["insertText", "deleteContentBackward", "historyUndo", "historyRedo"]) {
          const event = new Event("beforeinput", { bubbles: true, cancelable: true });
          Object.defineProperty(event, "inputType", { value: inputType });
          h.cell().dispatchEvent(event);
          expect(event.defaultPrevented).toBe(true);
        }
        for (const type of ["input", "paste", "compositionstart", "compositionend"])
          h.cell().dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
        const mutations: MenuAction[] = [
          "rowAbove",
          "rowBelow",
          "colLeft",
          "colRight",
          "deleteRow",
          "deleteCol",
          "moveRowUp",
          "moveRowDown",
          "moveColLeft",
          "moveColRight",
          "toggleHeader",
          "deleteTable",
          "alignLeft",
          "alignCenter",
          "alignRight",
          "completeColumns",
        ];
        for (const action of mutations) {
          runMenuAction(h.editor.view, h.wrap(), action);
          runTableAction(h.editor.view, doc.indexOf("| Value"), 1, 0, action);
        }
        expect(formatActiveCell(h.editor.view, "bold")).toBe(false);
        editTableSource(h.editor.view, h.wrap());
        expect(h.wrap().querySelector(".k2b-ste-table-source")).toBeNull();
        expect(h.editor.view.state.doc.toString()).toBe(doc);
        expect(h.cell().textContent).toBe("3");
        expect(h.actions).toEqual([]);
        expect(h.changes).toEqual([]);
      } finally {
        await h.cleanup();
      }
    });

    test("losing edit access restores the computed value and regaining access restores controls", async () => {
      const h = await mount(false, false);
      try {
        h.cell().focus();
        expect(h.cell().textContent).toBe("=SUM(1,2)");
        h.setReadOnly(true);
        expect(h.cell().textContent).toBe("3");
        expect(h.cell().contentEditable).toBe("false");
        expect(h.dom.root.querySelector(".k2b-ste-toolbar")).toBeNull();
        h.editor.view.dispatch({ changes: { from: doc.indexOf("=SUM(1,2)"), to: doc.indexOf("=SUM(1,2)") + 9, insert: "=SUM(2,1)" } });
        expect(h.cell().textContent).toBe("3");
        h.setReadOnly(false);
        expect(h.dom.root.querySelector(".k2b-ste-toolbar")).not.toBeNull();
        expect(h.dom.document.activeElement === h.cell()).toBe(true);
        expect(h.cell().textContent).toBe("=SUM(2,1)");
        for (const button of h.wrap().querySelectorAll<HTMLButtonElement>(".k2b-ste-grip, .k2b-ste-table-add button"))
          expect(button.hidden).toBe(false);
        expect(h.cell().contentEditable).not.toBe("false");
      } finally {
        await h.cleanup();
      }
    });

    test("desktop add-column occupies the table's side track, with add-row below and approved widths intact", async () => {
      const h = await mount(false, false);
      try {
        const column = h.wrap().querySelector<HTMLButtonElement>(".k2b-ste-addColumn")!;
        const row = h.wrap().querySelector<HTMLButtonElement>(".k2b-ste-addRow")!;
        expect(column.textContent).toBe("+");
        expect(column.getAttribute("aria-label")).toBe("Add column");
        expect(getComputedStyle(column).gridColumn).toBe("2");
        expect(getComputedStyle(column).gridRow).toBe("1");
        expect(getComputedStyle(row).gridRow).toBe("2");
        expect(getComputedStyle(h.cell()).minWidth).toBe("72px");
        expect(getComputedStyle(h.cell()).maxWidth).toBe("288px");
      } finally {
        await h.cleanup();
      }
    });
  });
