import { describe, expect, spyOn, test } from "bun:test";
import { forceParsing } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import { handleSoftNoteNavigationRequests } from "../soft-navigation";
import { refreshMarkdownDecorationsEffect } from "./_lib/cursor-zone-field";
import { markdownExtension } from "./markdown";

describe("editor links", () => {
  if (isServer) {
    test.skip("editor links run with browser export conditions", () => {});
    return;
  }

  const mount = async (doc: string, readOnly = false) => {
    const dom = createDomTestHarness();
    // The link widgets load the shared UI, which needs the browser globals of the harness.
    const { linksExtension } = await import("./links");
    const view = new EditorView({
      parent: dom.root,
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [markdownExtension(), linksExtension("Nb12Cd"), readOnly ? EditorState.readOnly.of(true) : []],
      }),
    });
    forceParsing(view, doc.length, 5000);
    view.dispatch({ effects: refreshMarkdownDecorationsEffect.of() });
    const opened: string[] = [];
    const stop = handleSoftNoteNavigationRequests(async (href) => {
      opened.push(href);
      return { kind: "applied", href };
    });
    const windowOpen = spyOn(dom.window, "open").mockImplementation(() => null);
    return {
      dom,
      opened,
      windowOpen,
      cleanup: () => {
        windowOpen.mockRestore();
        stop();
        view.destroy();
        dom.cleanup();
      },
    };
  };

  test("a link to a heading renders as a reference and opens the note at the heading", async () => {
    const { dom, opened, cleanup } = await mount("[Restore](note://Ab12Cd#restore) [Top](note://Ab12Cd#) [Code](javascript:alert(1))\n");
    try {
      const links = Array.from(dom.root.querySelectorAll<HTMLElement>(".k2b-reference"));
      expect(links.map((link) => link.textContent)).toEqual(["Restore", "Top"]);
      expect(links.map((link) => link.getAttribute("aria-label"))).toEqual(["Heading: Restore", "Note: Top"]);
      expect(dom.root.textContent).toContain("javascript:alert(1)");
      for (const link of links) link.click();
      await Bun.sleep(0);
      expect(opened).toEqual(["/app/notebooks/Nb12Cd/notes/Ab12Cd#heading-restore", "/app/notebooks/Nb12Cd/notes/Ab12Cd"]);
    } finally {
      cleanup();
    }
  });

  test("relative links are references of the same kind as in Book and navigate in place", async () => {
    const { dom, opened, windowOpen, cleanup } = await mount(
      "[Guide](/files/guide.pdf) [Top](#top) [Board](/app/spaces/Board1) [Brand](attach://Ab12Cd)\n",
    );
    try {
      const pills = Array.from(dom.root.querySelectorAll<HTMLElement>(".k2b-reference"));
      expect(pills.map((pill) => [pill.dataset.reference, pill.getAttribute("aria-label"), pill.getAttribute("role")])).toEqual([
        ["pdf", "PDF: Guide", "link"],
        ["heading", "Heading: Top", "link"],
        ["page", "Page: Board", "link"],
        ["file", "File: Brand", "link"],
      ]);
      expect(dom.root.querySelector(".k2b-text-link__external")).toBeNull();
      for (const pill of pills.slice(0, 3)) pill.click();
      await Bun.sleep(0);
      expect(opened).toEqual(["/files/guide.pdf", "#top", "/app/spaces/Board1"]);
      expect(windowOpen).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  test("a mail link opens from its text; a web link's text edits and its arrow opens it", async () => {
    const { dom, windowOpen, cleanup } = await mount("[Mail](mailto:ada@example.test) [Call](tel:+4930) [Site](https://example.test)\n");
    try {
      const labels = Array.from(dom.root.querySelectorAll<HTMLElement>(".cm-link-label"));
      expect(labels.map((label) => [label.textContent, label.getAttribute("role")])).toEqual([
        ["Mail", "link"],
        ["Call", "link"],
        ["Site", null],
      ]);
      const arrows = dom.root.querySelectorAll<HTMLElement>(".k2b-text-link__external");
      expect(arrows).toHaveLength(1);
      for (const label of labels) label.click();
      arrows[0]!.click();
      expect(windowOpen.mock.calls.map(([url]) => url)).toEqual(["mailto:ada@example.test", "tel:+4930", "https://example.test"]);
    } finally {
      cleanup();
    }
  });

  test("in a read-only view every link is a keyboard stop that Enter opens", async () => {
    const editable = await mount("[Note](note://Ab12Cd) [Mail](mailto:ada@example.test)\n");
    try {
      expect(editable.dom.root.querySelectorAll(".cm-link-open[tabindex]")).toHaveLength(0);
    } finally {
      editable.cleanup();
    }
    const { dom, opened, windowOpen, cleanup } = await mount("[Note](note://Ab12Cd) [Mail](mailto:ada@example.test)\n", true);
    try {
      const stops = Array.from(dom.root.querySelectorAll<HTMLElement>('.cm-link-open[tabindex="0"]'));
      expect(stops.map((stop) => stop.textContent)).toEqual(["Note", "Mail"]);
      for (const stop of stops) stop.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Bun.sleep(0);
      expect(opened).toEqual(["/app/notebooks/Nb12Cd/notes/Ab12Cd"]);
      expect(windowOpen.mock.calls.map(([url]) => url)).toEqual(["mailto:ada@example.test"]);
    } finally {
      cleanup();
    }
  });
});
