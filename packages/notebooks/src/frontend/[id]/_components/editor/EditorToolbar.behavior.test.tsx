import { describe, expect, spyOn, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

describe("editor toolbar phone viewport and menus", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  const mount = async (coarse = true, height = 508) => {
    const dom = createDomTestHarness();
    const viewport = Object.assign(new dom.window.EventTarget(), { height, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    Object.defineProperty(dom.document.documentElement, "clientHeight", { configurable: true, value: 844 });
    const media = window.matchMedia("(pointer: coarse)");
    Object.defineProperty(media, "matches", { value: coarse });
    const matchMedia = spyOn(window, "matchMedia").mockReturnValue(media);
    let flowBottom = 844;
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const rectangles = spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains("notebooks-editor-toolbar")) return originalRect.call(this);
      return new dom.window.DOMRect(0, flowBottom - Number.parseFloat(this.style.marginBottom || "0") - 44, 390, 44);
    });
    const { EditorState } = await import("@codemirror/state");
    const { EditorView } = await import("@codemirror/view");
    const { markdownExtension } = await import("../../../lib/editor/markdown");
    const { caretFormat } = await import("./editor-actions");
    const { default: EditorToolbar } = await import("./EditorToolbar");
    const { LocaleProvider } = await import("@k2b/ui");
    const editorHost = dom.document.createElement("div");
    dom.root.append(editorHost);
    const view = new EditorView({
      parent: editorHost,
      state: EditorState.create({ doc: "word here", selection: { anchor: 1, head: 4 }, extensions: [markdownExtension()] }),
    });
    // Focus and keyboard precede the toolbar's listeners, as when switching notes while typing.
    view.focus();
    const dispose = render(
      () => (
        <LocaleProvider locale="en">
          <EditorToolbar
            connected
            editorView={view}
            notebookId="Book01"
            noteId="Note01"
            initialPanelOpen={false}
            format={caretFormat(view.state)}
            onUndo={() => {}}
            onRedo={() => {}}
          />
        </LocaleProvider>
      ),
      dom.root,
    );
    const toolbar = dom.root.querySelector<HTMLDivElement>(".notebooks-editor-toolbar");
    if (!toolbar) throw new Error("Missing toolbar");
    // Happy DOM has no native popovers. Keep the shim on these menu elements only.
    for (const menu of toolbar.querySelectorAll<HTMLElement>("[popover]")) {
      let open = false;
      const matches = menu.matches.bind(menu);
      Object.defineProperty(menu, "matches", {
        configurable: true,
        value: (selector: string) => (selector === ":popover-open" ? open : matches(selector)),
      });
      menu.showPopover = () => {
        open = true;
      };
      menu.hidePopover = () => {
        open = false;
      };
    }
    return {
      dom,
      view,
      toolbar,
      viewport(values: { height?: number; offsetTop?: number; scale?: number }, event = "resize") {
        Object.assign(viewport, values);
        viewport.dispatchEvent(new dom.window.Event(event));
      },
      windowEvent(event: string, bottom: number) {
        flowBottom = bottom;
        window.dispatchEvent(new Event(event));
      },
      cleanup() {
        dispose();
        view.destroy();
        rectangles.mockRestore();
        matchMedia.mockRestore();
        dom.cleanup();
      },
    };
  };

  test("mounting with editor focus and an open keyboard lifts immediately", async () => {
    const app = await mount();
    try {
      expect(app.view.hasFocus).toBe(true);
      expect(app.toolbar.style.marginBottom).toBe("336px");
    } finally {
      app.cleanup();
    }
  });

  test("zooming returns to flow and panning never lifts or scrolls the caret", async () => {
    const app = await mount();
    const dispatch = spyOn(app.view, "dispatch");
    try {
      expect(app.toolbar.style.marginBottom).toBe("336px");
      for (const scale of [2, 0.8]) {
        for (const height of [422, 254]) {
          for (const offsetTop of [0, 300, 80]) {
            app.viewport({ scale, height, offsetTop }, "scroll");
            expect(app.toolbar.style.marginBottom).toBe("");
          }
        }
      }
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      dispatch.mockRestore();
      app.cleanup();
    }
  });

  test("the hardware-keyboard shortcuts bar and fine pointers stay in flow", async () => {
    for (const [coarse, height] of [
      [true, 789],
      [false, 508],
    ] as const) {
      const app = await mount(coarse, height);
      try {
        expect(app.toolbar.style.marginBottom).toBe("");
      } finally {
        app.cleanup();
      }
    }
  });

  test("window resize and document scroll refresh the lift", async () => {
    const app = await mount();
    try {
      app.windowEvent("resize", 800);
      expect(app.toolbar.style.marginBottom).toBe("292px");
      app.windowEvent("scroll", 760);
      expect(app.toolbar.style.marginBottom).toBe("252px");
    } finally {
      app.cleanup();
    }
  });

  test.each([true, false])("menu taps preserve editor focus only on coarse pointers (%s)", async (coarse) => {
    const app = await mount(coarse);
    try {
      for (const [label, itemLabel, expectedDoc] of [
        ["Text style: Normal", "Heading 2", "## word here"],
        ["More", "Info", "## word here\n\n:::info\n\n:::\n"],
      ] as const) {
        const trigger = app.toolbar.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
        if (!trigger) throw new Error(`Missing ${label}`);
        trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        trigger.click();
        await Promise.resolve();
        const menu = app.dom.document.getElementById(trigger.getAttribute("aria-controls") || "");
        const item = Array.from(menu?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((button) =>
          button.textContent?.includes(itemLabel),
        );
        if (!item) throw new Error(`Missing ${itemLabel}`);
        expect(app.view.hasFocus).toBe(coarse);
        expect(app.view.state.selection.main.anchor).toBe(label === "More" ? 4 : 1);
        expect(app.view.state.selection.main.head).toBe(label === "More" ? 7 : 4);
        if (!coarse) expect(menu?.contains(app.dom.document.activeElement)).toBe(true);
        item.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        item.click();
        await Promise.resolve();
        expect(app.view.hasFocus).toBe(true);
        expect(app.view.state.doc.toString()).toBe(expectedDoc);
        expect(app.toolbar.style.marginBottom).toBe(coarse ? "336px" : "");
      }
    } finally {
      app.cleanup();
    }
  });
});

describe("editor toolbar pointer and keyboard focus", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("keeps keyboard focus styling inside buttons and prevents pointer focus transfer", async () => {
    const dom = createDomTestHarness();
    const style = dom.document.createElement("style");
    style.textContent = `${await read("../../../../../../ui/src/styles/index.css")}\n${await read("../../../../styles/app.css")}`;
    dom.document.head.append(style);
    dom.document.body.classList.add("k2b-ui");
    const { LocaleProvider } = await import("@k2b/ui");
    const { default: EditorToolbar } = await import("./EditorToolbar");
    const dispose = render(
      () => (
        <LocaleProvider locale="de">
          <EditorToolbar
            connected
            editorView={undefined}
            notebookId="notebook-1"
            noteId="note-1"
            initialPanelOpen={false}
            format={{
              bold: false,
              italic: false,
              strikethrough: false,
              highlight: false,
              list: null,
              heading: 0,
              indent: false,
              outdent: false,
            }}
            onUndo={() => {}}
            onRedo={() => {}}
          />
        </LocaleProvider>
      ),
      dom.root,
    );

    try {
      const toolbar = dom.document.querySelector(".notebooks-editor-toolbar");
      const buttons = Array.from(toolbar?.querySelectorAll<HTMLElement>(".k2b-icon-button") ?? []);
      expect(buttons.map((button) => button.getAttribute("aria-label"))).toContain("Fett");
      expect(buttons.length).toBeGreaterThanOrEqual(9);
      for (const button of buttons) {
        button.focus();
        expect(dom.document.activeElement).toBe(button);
        const focused = getComputedStyle(button);
        const label = button.getAttribute("aria-label");
        if (button.tagName === "BUTTON") {
          const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
          button.dispatchEvent(press);
          expect({ label, prevented: press.defaultPrevented }).toEqual({ label, prevented: true });
          expect(dom.document.activeElement).toBe(button);
        }
        expect({ label, outline: focused.outlineStyle, shadow: focused.boxShadow }).toEqual({ label, outline: "none", shadow: "none" });
      }
    } finally {
      dispose();
      dom.cleanup();
    }
  });
});

describe("editor toolbar navigation toggle", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("hides and shows the navigation from the first toolbar button without taking focus from the note", async () => {
    const dom = createDomTestHarness();
    const { LocaleProvider } = await import("@k2b/ui");
    const { default: EditorToolbar } = await import("./EditorToolbar");
    const { NAVIGATION_VISIBILITY_EVENT } = await import("../sidebar/navigation-visibility");
    const changes: boolean[] = [];
    const onChange = (event: Event) => void changes.push((event as CustomEvent<{ hidden: boolean }>).detail.hidden);
    window.addEventListener(NAVIGATION_VISIBILITY_EVENT, onChange);
    const dispose = render(
      () => (
        <LocaleProvider locale="de">
          <EditorToolbar
            connected
            editorView={undefined}
            notebookId="notebook-1"
            noteId="note-1"
            initialPanelOpen={false}
            format={{
              bold: false,
              italic: false,
              strikethrough: false,
              highlight: false,
              list: null,
              heading: 0,
              indent: false,
              outdent: false,
            }}
            onUndo={() => {}}
            onRedo={() => {}}
          />
        </LocaleProvider>
      ),
      dom.root,
    );

    try {
      const buttons = Array.from(dom.document.querySelectorAll<HTMLButtonElement>(".notebooks-editor-toolbar .k2b-icon-button"));
      const toggle = buttons[0]!;
      // Navigation stays outside the formatting toolbar.
      expect(toggle.getAttribute("aria-label")).toBe("Navigation ausblenden");
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(toggle.getAttribute("aria-controls")).toBe("notebook-navigation");
      expect(toggle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))).toBe(false);

      toggle.click();
      expect(changes).toEqual([true]);
      expect(toggle.getAttribute("aria-label")).toBe("Navigation einblenden");
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(decodeURIComponent(dom.document.cookie)).toContain('"navigationHidden":true');

      toggle.click();
      expect(changes).toEqual([true, false]);
      expect(toggle.getAttribute("aria-label")).toBe("Navigation ausblenden");
      // A default value stays out of the cookie.
      expect(decodeURIComponent(dom.document.cookie)).not.toContain('"navigationHidden"');
    } finally {
      window.removeEventListener(NAVIGATION_VISIBILITY_EVENT, onChange);
      dispose();
      dom.cleanup();
    }
  });
});

describe("editor toolbar formats and shortcuts", () => {
  if (isServer) {
    test.skip("needs browser export conditions", () => {});
    return;
  }

  test("pressed formats and current style follow a real editor's caret and selection", async () => {
    const dom = createDomTestHarness();
    const { createSignal } = await import("solid-js");
    const { EditorState } = await import("@codemirror/state");
    const { EditorView } = await import("@codemirror/view");
    const { forceParsing } = await import("@codemirror/language");
    const { markdownExtension } = await import("../../../lib/editor/markdown");
    const { caretFormat } = await import("./editor-actions");
    const { default: EditorToolbar, formattingKeymap } = await import("./EditorToolbar");
    const { LocaleProvider } = await import("@k2b/ui");
    const [format, setFormat] = createSignal(caretFormat(EditorState.create()));
    const editorHost = dom.document.createElement("div");
    dom.root.append(editorHost);
    const view = new EditorView({
      parent: editorHost,
      state: EditorState.create({
        extensions: [
          markdownExtension(),
          formattingKeymap({ notebookId: "Book01" }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged || update.selectionSet) setFormat(caretFormat(update.state));
          }),
        ],
      }),
    });
    const dispose = render(
      () => (
        <LocaleProvider locale="en">
          <EditorToolbar
            connected
            editorView={view}
            notebookId="Book01"
            noteId="Note01"
            initialPanelOpen={false}
            format={format()}
            onUndo={() => {}}
            onRedo={() => {}}
          />
        </LocaleProvider>
      ),
      dom.root,
    );
    const button = (label: string) => {
      const found = dom.root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
      if (!found) throw new Error(`Missing ${label}`);
      return found;
    };
    const load = (doc: string, anchor: number, head = anchor) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc }, selection: { anchor, head } });
      forceParsing(view, doc.length, 5000);
      view.dispatch({ selection: { anchor, head } });
      view.focus();
    };
    try {
      for (const [doc, label, head] of [
        ["**b**", "Bold", 3],
        ["*i*", "Italic", 2],
        ["~~s~~", "Strikethrough", 3],
        ["==h==", "Highlight", 3],
        ["- item", "Bullet list", 4],
        ["1. item", "Numbered list", 4],
        ["- [ ] item", "Checklist", 8],
      ] as const) {
        load(doc, head);
        expect(button(label).getAttribute("aria-pressed")).toBe("true");
        load("plain", 2);
        expect(button(label).getAttribute("aria-pressed")).toBe("false");
      }
      load("## x", 4);
      expect(button("Text style: H2").textContent).toContain("H2");
      load("plain **bold**", 8, 12);
      expect(button("Bold").getAttribute("aria-pressed")).toBe("true");
      load("word", 2);
      const heading = () =>
        new KeyboardEvent("keydown", { key: "@", code: "Digit2", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
      const first = heading();
      view.contentDOM.dispatchEvent(first);
      expect(first.defaultPrevented).toBe(true);
      expect(view.state.doc.toString()).toBe("## word");
      expect(button("Text style: H2")).toBeDefined();
      view.contentDOM.dispatchEvent(heading());
      expect(view.state.doc.toString()).toBe("word");
      const highlight = new KeyboardEvent("keydown", {
        key: "H",
        keyCode: 72,
        code: "KeyH",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      view.contentDOM.dispatchEvent(highlight);
      expect(highlight.defaultPrevented).toBe(true);
      expect(view.state.doc.toString()).toBe("==word==");
      expect(button("Highlight").getAttribute("aria-pressed")).toBe("true");
      expect(button("Bold").getAttribute("aria-keyshortcuts")).toBe("Control+B");
      // The tooltip names the keys with the shared formatter of @k2b/ui.
      const tooltips = Array.from(dom.root.querySelectorAll('[role="tooltip"]'), (surface) => surface.textContent);
      expect(tooltips).toContain("Bold (Ctrl+B)");
      expect(tooltips).toContain("Highlight (Ctrl+Shift+H)");
      for (const control of dom.root.querySelectorAll(".notebooks-editor-toolbar button, .notebooks-editor-toolbar a")) {
        const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
        control.dispatchEvent(down);
        expect(down.defaultPrevented).toBe(true);
      }
    } finally {
      dispose();
      view.destroy();
      dom.cleanup();
    }
  });
});
