import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createSignal, onCleanup, onMount } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import { extractNotebookDirectiveRanges } from "../../../lib/query-blocks";
import { dispatchWorkspaceEvent } from "../../[id]/_components/sidebar/workspace-events";
import type { BlockPreviewResult } from "./query-blocks";

const DOCUMENT = "# Heading\n\n:::query\nsource: notes\n:::\n\n:::toc\n:::";
const response = (markdown = DOCUMENT, label = "Result"): BlockPreviewResult => ({
  markdown,
  blocks: extractNotebookDirectiveRanges(markdown).map((block) => ({
    line: block.line,
    html:
      block.type === "query"
        ? `<p>${label}</p><a href="/app/notebooks/ABC123/notes/DEF456?mode=write">Note</a>`
        : '<nav><a href="#heading">Heading</a></nav>',
  })),
  diagnostics: [],
  headings: [{ id: "heading", line: 1 }],
});

describe("query block previews", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }
  const mount = async (
    load: (markdown: string | undefined, signal: AbortSignal) => Promise<BlockPreviewResult>,
    markdown = DOCUMENT,
    readOnly = false,
  ) => {
    const dom = createDomTestHarness();
    const { createQueryBlockPreviews } = await import("./query-blocks");
    let editor: EditorView;
    const dispose = render(() => {
      const host = document.createElement("div");
      const [view, setView] = createSignal<EditorView>();
      const preview = createQueryBlockPreviews({
        notebookId: "ABC123",
        noteId: "DEF456",
        readOnly,
        initialMarkdown: markdown,
        view,
        enabled: () => true,
        locale: () => "de",
        load,
      });
      onMount(() => {
        editor = new EditorView({
          parent: host,
          state: EditorState.create({ doc: markdown, extensions: [preview.listener, preview.extension] }),
        });
        setView(editor);
      });
      onCleanup(() => editor?.destroy());
      return host;
    }, dom.root);
    return {
      dom,
      view: () => editor!,
      cleanup: () => {
        dispose();
        dom.cleanup();
      },
    };
  };

  test("one canonical read renders all blocks; links do not reveal source", async () => {
    let calls = 0;
    const app = await mount(async () => {
      calls++;
      return response();
    });
    try {
      await Bun.sleep(40);
      expect(calls).toBe(1);
      expect(app.dom.root.querySelectorAll(".cm-query-block-widget").length).toBe(2);
      expect(app.dom.root.textContent).toContain("Result");
      const anchor = app.dom.root.querySelector('.cm-query-block-widget a[href^="/app"]')!;
      const previous = app.view().state.selection.main.anchor;
      anchor.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      expect(app.view().state.selection.main.anchor).toBe(previous);
      const button = Array.from(app.dom.root.querySelectorAll("button")).find((button) => button.textContent?.includes("Quelltext"))!;
      button.click();
      expect(app.view().state.selection.main.anchor).toBe(DOCUMENT.indexOf(":::query"));
      expect(app.dom.root.querySelectorAll(".cm-query-block-widget").length).toBe(1);
    } finally {
      app.cleanup();
    }
  });

  test("TOC links use server-provided heading source locations", async () => {
    const app = await mount(async () => response());
    try {
      await Bun.sleep(30);
      app.view().dispatch({ selection: { anchor: 2 } });
      const toc = app.dom.root.querySelector<HTMLAnchorElement>('a[href="#heading"]')!;
      toc.click();
      expect(app.view().state.selection.main.anchor).toBe(0);
    } finally {
      app.cleanup();
    }
  });

  test("previews share Book typography without its page-sized container spacing", async () => {
    const app = await mount(async () => ({
      ...response(),
      blocks: [{ line: 3, html: '<ul><li>Item</li></ul><table><tr><td>Value</td></tr></table><a href="/note">Note</a>' }],
    }));
    try {
      const style = document.createElement("style");
      style.textContent = readFileSync(new URL("../../../styles/app.css", import.meta.url), "utf8");
      document.head.append(style);
      await Bun.sleep(30);
      const preview = app.dom.root.querySelector<HTMLElement>(".cm-query-block-preview")!;
      expect(preview.classList.contains("notebook-book-content")).toBe(true);
      expect(getComputedStyle(preview).maxWidth).toBe("none");
      expect(getComputedStyle(preview).padding).toBe("0px");
      expect(getComputedStyle(preview.querySelector("ul")!).listStyle).toBe("disc");
      expect(getComputedStyle(preview.querySelector("table")!).borderCollapse).toBe("collapse");
      expect(getComputedStyle(preview.querySelector("a")!).textDecoration).toBe("underline");
    } finally {
      app.cleanup();
    }
  });

  test("failed previews show a localized retry action and can recover", async () => {
    let calls = 0;
    const app = await mount(async () => {
      if (++calls === 1) throw new Error("Unavailable");
      return response();
    });
    try {
      await Bun.sleep(30);
      expect(app.dom.root.textContent).toContain("Die Blockvorschau konnte nicht geladen werden.");
      Array.from(app.dom.root.querySelectorAll("button"))
        .find((button) => button.textContent === "Erneut versuchen")!
        .click();
      await Bun.sleep(30);
      expect(calls).toBe(2);
      expect(app.dom.root.textContent).toContain("Result");
      expect(app.dom.root.textContent).not.toContain("Die Blockvorschau konnte nicht geladen werden.");
    } finally {
      app.cleanup();
    }
  });

  test("draft edits debounce, abort pending loads and reject late results", async () => {
    const requests: Array<{ markdown: string; signal: AbortSignal; resolve: (value: BlockPreviewResult) => void }> = [];
    const app = await mount((markdown, signal) => new Promise((resolve) => requests.push({ markdown: markdown!, signal, resolve })));
    try {
      await Bun.sleep(20);
      app.view().dispatch({ changes: { from: 0, insert: "New\n" } });
      app.view().dispatch({ changes: { from: 0, insert: "Newest\n" } });
      await Bun.sleep(20);
      expect(requests[0]!.signal.aborted).toBe(true);
      expect(requests.length).toBe(1);
      await Bun.sleep(330);
      expect(requests.length).toBe(2);
      requests[1]!.resolve(response(requests[1]!.markdown, "Fresh result"));
      await Bun.sleep(20);
      requests[0]!.resolve(response(DOCUMENT, "Stale result"));
      await Bun.sleep(20);
      expect(app.dom.root.textContent).toContain("Fresh result");
      expect(app.dom.root.textContent).not.toContain("Stale result");
    } finally {
      app.cleanup();
    }
  });

  test("TOC links without source positions do not navigate or move the cursor", async () => {
    const app = await mount(async () => ({ ...response(), headings: [] }));
    try {
      await Bun.sleep(30);
      app.view().dispatch({ selection: { anchor: 2 } });
      const toc = app.dom.root.querySelector<HTMLAnchorElement>('a[href="#heading"]')!;
      const click = new MouseEvent("click", { bubbles: true, cancelable: true });
      toc.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
      expect(app.view().state.selection.main.anchor).toBe(2);
      expect(app.dom.root.textContent).toContain("Öffne die Buchansicht");
    } finally {
      app.cleanup();
    }
  });

  test("workspace event acknowledgement waits for a covering preview snapshot", async () => {
    let calls = 0;
    let resolve!: (value: BlockPreviewResult) => void;
    const app = await mount(async () => {
      if (++calls === 1) return response();
      return new Promise((done) => {
        resolve = done;
      });
    });
    try {
      await Bun.sleep(20);
      let covered = false;
      const pending = dispatchWorkspaceEvent(
        { v: 1, type: "workspace.invalidated", notebookId: "ABC123", reason: "unknown", scopes: ["tree"] },
        null,
      ).then(() => {
        covered = true;
      });
      await Bun.sleep(20);
      expect(covered).toBe(false);
      expect(calls).toBe(2);
      resolve(response(DOCUMENT, "Refreshed result"));
      await pending;
      expect(covered).toBe(true);
      await Bun.sleep(20);
      expect(app.dom.root.textContent).toContain("Refreshed result");
    } finally {
      app.cleanup();
    }
  });

  test("read-only requests omit drafts and never apply mismatched source HTML", async () => {
    const payloads: Array<string | undefined> = [];
    const app = await mount(
      async (markdown) => {
        payloads.push(markdown);
        return response("Changed\n" + DOCUMENT, "Wrong position");
      },
      DOCUMENT,
      true,
    );
    try {
      await Bun.sleep(30);
      expect(payloads).toEqual([undefined]);
      expect(app.dom.root.textContent).not.toContain("Wrong position");
      expect(app.dom.root.textContent).toContain("Die gespeicherte Notiz wurde geändert.");
      expect(Array.from(app.dom.root.querySelectorAll("button")).some((button) => button.textContent === "Neu laden")).toBe(true);
    } finally {
      app.cleanup();
    }
  });

  test("server diagnostics stay accessible when no block HTML is returned", async () => {
    const app = await mount(async () => ({ ...response(), blocks: [], diagnostics: [{ line: 4, message: "Ungültige Quelle" }] }));
    try {
      await Bun.sleep(30);
      expect(app.dom.root.querySelector('[role="status"]')?.textContent).toBe("Ungültige Quelle");
    } finally {
      app.cleanup();
    }
  });

  test("documents without directives cause no preview requests", async () => {
    let calls = 0;
    const app = await mount(async () => {
      calls++;
      return response();
    }, "# Ordinary page");
    try {
      await Bun.sleep(30);
      expect(calls).toBe(0);
    } finally {
      app.cleanup();
    }
  });

  test("unmount cancels pending requests and prevents late widget mutation", async () => {
    let signal!: AbortSignal;
    let resolve!: (value: BlockPreviewResult) => void;
    const app = await mount((_markdown, nextSignal) => {
      signal = nextSignal;
      return new Promise((done) => {
        resolve = done;
      });
    });
    await Bun.sleep(20);
    app.cleanup();
    expect(signal.aborted).toBe(true);
    resolve(response());
    await Bun.sleep(20);
  });
});
