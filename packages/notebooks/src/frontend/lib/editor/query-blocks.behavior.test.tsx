import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createSignal, onCleanup, onMount } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import { dispatchWorkspaceEvent } from "../../[id]/_components/sidebar/workspace-events";
import type { BlockPreviewResult } from "./query-blocks";

// The notebook parsers share the info block grammar of @k2b/ui; its browser build needs the DOM globals before it loads.
const loading = createDomTestHarness();
const { extractNotebookDirectiveRanges } = await import("../../../lib/query-blocks");
loading.cleanup();

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
    load: (markdown: string | undefined, signal: AbortSignal, pages: ReadonlyMap<number, number>) => Promise<BlockPreviewResult>,
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
        load: (markdown, pages, signal) => load(markdown, signal, pages),
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

  test("a paged query turns its page in place, asks for that page and keeps focus on the button", async () => {
    const requested: number[] = [];
    const pager = (page: number) =>
      `<div class="notebook-book-query" data-query-line="3"><ul><li>Row ${page}</li></ul><nav class="notebook-query-pager">` +
      `<button type="button" data-query-line="3" data-query-page="${page - 1}"${page === 1 ? " disabled" : ""}>‹</button>` +
      `<span role="status">${page * 20 - 19}–${page * 20} von 362</span>` +
      `<button type="button" data-query-line="3" data-query-page="${page + 1}">›</button></nav></div>`;
    const app = await mount(async (_markdown, _signal, pages) => {
      const page = pages.get(3) ?? 1;
      requested.push(page);
      return { ...response(), blocks: [{ line: 3, html: pager(page) }] };
    });
    try {
      await Bun.sleep(40);
      const next = () => app.dom.root.querySelectorAll<HTMLButtonElement>("button[data-query-page]")[1]!;
      expect(app.dom.root.textContent).toContain("1–20 von 362");
      const previous = app.view().state.selection.main.anchor;
      next().click();
      await Bun.sleep(40);
      expect(requested).toEqual([1, 2]);
      expect(app.dom.root.textContent).toContain("21–40 von 362");
      expect(app.dom.document.activeElement).toBe(next());
      // Turning a page is no edit and leaves the cursor where it was.
      expect(app.view().state.selection.main.anchor).toBe(previous);
      expect(app.view().state.doc.toString()).toBe(DOCUMENT);
    } finally {
      app.cleanup();
    }
  });

  test("pages of lines that moved away are dropped, and a late page leaves focus where the reader moved it", async () => {
    const sent: Array<[number, number][]> = [];
    let release: (() => void) | undefined;
    const pager = (line: number, page: number) =>
      `<div class="notebook-book-query" data-query-line="${line}"><ul><li>Row ${page}</li></ul><nav class="notebook-query-pager">` +
      `<button type="button" data-query-line="${line}" data-query-page="${page - 1}"${page === 1 ? " disabled" : ""}>‹</button>` +
      `<span role="status">${page}</span><button type="button" data-query-line="${line}" data-query-page="${page + 1}">›</button></nav></div>`;
    const app = await mount(async (markdown, _signal, pages) => {
      sent.push([...pages]);
      if (pages.size > 0 && !release) await new Promise<void>((resolve) => (release = resolve));
      const document = markdown ?? DOCUMENT;
      const line = extractNotebookDirectiveRanges(document).find((block) => block.type === "query")!.line;
      return { ...response(document), blocks: [{ line, html: pager(line, pages.get(line) ?? 1) }] };
    });
    try {
      await Bun.sleep(40);
      app.dom.root.querySelectorAll<HTMLButtonElement>("button[data-query-page]")[1]!.click();
      await Bun.sleep(10);
      // The reader moves on while the page loads.
      const elsewhere = app.dom.document.createElement("button");
      app.dom.root.append(elsewhere);
      elsewhere.focus();
      release!();
      await Bun.sleep(40);
      expect(app.dom.document.activeElement).toBe(elsewhere);
      expect(sent.at(-1)).toEqual([[3, 2]]);
      // Lines added above the query move it; the page of its old line is not sent again.
      app.view().dispatch({ changes: { from: 0, insert: "Intro\n\n" } });
      await Bun.sleep(400);
      expect(sent.at(-1)).toEqual([]);
    } finally {
      app.cleanup();
    }
  });

  test("a drawn chart widget mounts controls and restores its DOM when replaced", async () => {
    const markdown =
      "# Chart\n\n:::chart\ntype: bar\ntitle: Umsatz\ncolumns: [Monat, Umsatz]\nrows:\n  - [Januar, 1200]\nx: Monat\ny: Umsatz\ntooltip:\n  label: Betrag\n  format: EUR\n:::";
    let serverHtml = "";
    const app = await mount(async () => {
      const { parseNotebookChartBlocks, renderNotebookChartFigure } = await import("../../../lib/chart-blocks");
      const parsed = parseNotebookChartBlocks(markdown);
      expect(parsed.diagnostics).toEqual([]);
      serverHtml = renderNotebookChartFigure(parsed.blocks[0]!.input, "de")!;
      return { markdown, blocks: [{ line: 3, html: serverHtml }], diagnostics: [], headings: [] };
    }, markdown);
    try {
      // Wait for the preview response instead of a fixed time: the widget draws once the debounced request resolves.
      for (let wait = 0; wait < 200 && !app.dom.root.querySelector(".notebook-book-chart__actions button"); wait++) await Bun.sleep(10);
      const widget = app.dom.root.querySelector<HTMLElement>(".cm-query-block-widget")!;
      const preview = widget.querySelector<HTMLElement>(".cm-query-block-preview")!;
      const original = document.createElement("div");
      original.innerHTML = serverHtml;
      expect(widget.querySelectorAll(".notebook-book-chart__actions button")).toHaveLength(2);
      expect(widget.querySelector('[aria-label="Daten kopieren"]')).not.toBeNull();
      const toggle = widget.querySelector<HTMLButtonElement>('[aria-label="Als Tabelle"]')!;
      toggle.click();
      expect(toggle.getAttribute("aria-pressed")).toBe("true");
      expect(preview.querySelector(".notebook-book-chart__table table")).not.toBeNull();
      // Entering the source replaces the decoration and calls QueryBlockWidget.destroy().
      app.view().dispatch({ selection: { anchor: markdown.indexOf(":::chart") } });
      expect(widget.isConnected).toBe(false);
      expect(app.dom.root.querySelector(".notebook-book-chart__actions button")).toBeNull();
      expect(preview.querySelector("button, .notebook-book-chart__table, [data-interactive], [tabindex]")).toBeNull();
      expect(preview.innerHTML).toBe(original.innerHTML);
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
      blocks: [{ line: 3, html: "<ul><li>Item</li></ul><table><tr><td>Value</td></tr></table>" }],
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
