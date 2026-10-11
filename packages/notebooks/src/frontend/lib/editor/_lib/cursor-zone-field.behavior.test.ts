import { describe, expect, jest, test } from "bun:test";
import { forceParsing } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import { markdownExtension } from "../markdown";
import { markupExtension } from "../markup";
import { pointerSelectionHeld, pointerSelectionMarkdownRefreshExtension, refreshMarkdownDecorationsEffect } from "./cursor-zone-field";

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
      extensions: [markdownExtension(), markupExtension(), linksExtension("n1"), pointerSelectionMarkdownRefreshExtension()],
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
