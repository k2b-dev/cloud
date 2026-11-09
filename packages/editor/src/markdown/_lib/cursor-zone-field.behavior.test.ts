import { describe, expect, jest, test } from "bun:test";
import { forceParsing } from "@codemirror/language";
import { Compartment, EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { markdownExtension } from "../markdown";
import { markupExtension } from "../markup";
import {
  markdownEditorFocused,
  placeMarkdownCaret,
  pointerSelectionHeld,
  pointerSelectionMarkdownRefreshExtension,
  refreshMarkdownDecorationsEffect,
} from "./cursor-zone-field";

const pointer = (target: EventTarget, type: string, pointerType = "mouse", button = 0) => {
  const event = new Event(type, { bubbles: true });
  Object.assign(event, { pointerType, button });
  target.dispatchEvent(event);
};

const mount = async () => {
  const dom = createDomTestHarness();
  const { linksExtension } = await import("../links");
  const text = "# Heading\n\nSome **bold** and [web link](https://example.com)\n\nEnd";
  const view = new EditorView({
    parent: dom.root,
    state: EditorState.create({
      doc: text,
      selection: { anchor: text.length },
      extensions: [markdownExtension(), markupExtension(), linksExtension(), pointerSelectionMarkdownRefreshExtension()],
    }),
  });
  forceParsing(view, text.length, 5000);
  view.dispatch({ effects: refreshMarkdownDecorationsEffect.of() });
  jest.useFakeTimers();
  // A press in the editor focuses it; CodeMirror reports the focus after 10 ms.
  view.focus();
  jest.advanceTimersByTime(10);
  return {
    view,
    cleanup: () => {
      view.destroy();
      dom.cleanup();
      jest.useRealTimers();
    },
  };
};

describe("pointer decoration refresh", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test.each(["mouse", "pen"])("a %s press holds markup and links until release", async (pointerType) => {
    const { view, cleanup } = await mount();
    try {
      const rendered = view.contentDOM.textContent;
      expect(rendered).not.toContain("**bold**");
      expect(view.contentDOM.querySelector(".cm-link-label")).not.toBeNull();
      pointer(view.contentDOM, "pointerdown", pointerType);
      expect(view.state.field(pointerSelectionHeld)).toBe(true);
      view.dispatch({ selection: EditorSelection.single(0, 40), userEvent: "select.pointer" });
      expect(view.contentDOM.textContent).toBe(rendered);
      pointer(document, "pointerup", pointerType);
      expect(view.state.field(pointerSelectionHeld)).toBe(true);
      jest.advanceTimersByTime(0);
      expect(view.state.field(pointerSelectionHeld)).toBe(false);
      expect(view.contentDOM.textContent).toContain("**bold**");
      expect(view.contentDOM.textContent).toContain("[web link](https://example.com)");
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      expect(view.contentDOM.textContent).toBe(rendered);
    } finally {
      cleanup();
    }
  });

  test("touch and non-primary presses do not hold decorations", async () => {
    const { view, cleanup } = await mount();
    try {
      pointer(view.contentDOM, "pointerdown", "touch");
      expect(view.state.field(pointerSelectionHeld)).toBe(false);
      pointer(view.contentDOM, "pointerdown", "mouse", 2);
      expect(view.state.field(pointerSelectionHeld)).toBe(false);
      view.dispatch({ selection: EditorSelection.single(0, 25), userEvent: "select.pointer" });
      expect(view.contentDOM.textContent).toContain("**bold**");
    } finally {
      cleanup();
    }
  });

  test("pointer cancellation schedules one refresh and destroy clears it", async () => {
    const { view, cleanup } = await mount();
    try {
      pointer(view.contentDOM, "pointerdown");
      pointer(document, "pointercancel");
      pointer(document, "pointerup");
      view.destroy();
      jest.advanceTimersByTime(0);
      pointer(document, "pointerup");
      expect(view.state.field(pointerSelectionHeld)).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("Markdown source follows focus", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  // A note opens with CodeMirror's default selection at its start, which is the title line. Nobody placed it there.
  const open = async (extensions: Extension[] = []) => {
    const dom = createDomTestHarness();
    const { linksExtension } = await import("../links");
    const text = "# Title with **bold** and [link](https://example.com)\n\nBody";
    const view = new EditorView({
      parent: dom.root,
      state: EditorState.create({
        doc: text,
        extensions: [markdownExtension(), markupExtension(), linksExtension(), ...extensions],
      }),
    });
    forceParsing(view, text.length, 5000);
    view.dispatch({ effects: refreshMarkdownDecorationsEffect.of() });
    jest.useFakeTimers();
    return {
      view,
      cleanup: () => {
        view.destroy();
        dom.cleanup();
        jest.useRealTimers();
      },
    };
  };

  test("a note without focus shows no marker, focus reveals the caret's block and blur renders it again", async () => {
    const { view, cleanup } = await open();
    try {
      expect(view.state.selection.main.head).toBe(0);
      expect(view.contentDOM.textContent).toBe("Title with bold and linkBody");
      expect(view.state.field(markdownEditorFocused)).toBe(false);

      view.focus();
      jest.advanceTimersByTime(10);
      expect(view.state.field(markdownEditorFocused)).toBe(true);
      expect(view.contentDOM.textContent).toBe("# Title with bold and linkBody");
      view.dispatch({ selection: { anchor: 16 } });
      expect(view.contentDOM.textContent).toBe("# Title with **bold** and linkBody");

      // Focus moves to another field: nothing is being edited, so the block renders again.
      view.contentDOM.blur();
      jest.advanceTimersByTime(10);
      expect(view.state.field(markdownEditorFocused)).toBe(false);
      expect(view.contentDOM.textContent).toBe("Title with bold and linkBody");
    } finally {
      cleanup();
    }
  });

  test("a control places the caret in an editor that cannot take focus", async () => {
    const { view, cleanup } = await open([EditorView.editable.of(false)]);
    try {
      view.dispatch({ selection: { anchor: 16 }, effects: placeMarkdownCaret.of() });
      expect(view.contentDOM.textContent).toBe("# Title with **bold** and linkBody");
    } finally {
      cleanup();
    }
  });

  test("a press that focuses the editor reveals the source after its release, not under the pointer", async () => {
    const { view, cleanup } = await open([pointerSelectionMarkdownRefreshExtension()]);
    try {
      pointer(view.contentDOM, "pointerdown");
      view.dispatch({ selection: { anchor: 3 }, userEvent: "select.pointer" });
      view.focus();
      jest.advanceTimersByTime(10);
      expect(view.contentDOM.textContent).toBe("Title with bold and linkBody");
      // Other rebuilds during the press, such as an edit by someone else, still reveal nothing under the pointer.
      view.dispatch({ changes: { from: view.state.doc.length, insert: "!" } });
      expect(view.contentDOM.textContent).toBe("Title with bold and linkBody!");
      pointer(document, "pointerup");
      jest.advanceTimersByTime(0);
      expect(view.state.field(markdownEditorFocused)).toBe(true);
      expect(view.contentDOM.textContent).toBe("# Title with bold and linkBody!");
    } finally {
      cleanup();
    }
  });

  test("decorations added to an editor that already has focus reveal the caret's block", async () => {
    const dom = createDomTestHarness();
    const rich = new Compartment();
    const text = "# Title\n\nBody";
    const view = new EditorView({
      parent: dom.root,
      state: EditorState.create({ doc: text, extensions: [markdownExtension(), rich.of([])] }),
    });
    try {
      view.focus();
      await Bun.sleep(20);
      // A note switches from its source view to its rich view while the person keeps typing.
      view.dispatch({ effects: rich.reconfigure(markupExtension()) });
      forceParsing(view, text.length, 5000);
      await Promise.resolve();
      expect(view.state.field(markdownEditorFocused)).toBe(true);
      expect(view.contentDOM.textContent).toBe("# TitleBody");
    } finally {
      view.destroy();
      dom.cleanup();
    }
  });
});
