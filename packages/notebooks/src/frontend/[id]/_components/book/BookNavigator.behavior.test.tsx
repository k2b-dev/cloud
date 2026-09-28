import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import { dispatchWorkspaceEvent } from "../sidebar/workspace-events";
import type { BookTreeNode } from "./BookNavigator.island";
import type { BookSnapshot } from "./book-state";

const tree: BookTreeNode[] = [
  { id: "note01", title: "Guide", children: [{ id: "note02", title: "Setup", children: [] }] },
  { id: "note03", title: "Glossary", children: [] },
];
const snapshot = (noteId: string): BookSnapshot => ({
  href: `/app/notebooks/book01/notes/${noteId}?mode=book`,
  html: `<h1>${noteId}</h1>`,
  title: noteId,
  notebookName: "Handbook",
  selectedNoteId: noteId,
  tree,
  tags: [],
  canWrite: false,
  locked: false,
  historyIncomplete: false,
  cursor: null,
});
const flush = () => Bun.sleep(20);

describe("Book navigation tree", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  // The reading shell as the page renders it: the tree and the controller share one document click path.
  const mount = async (selectedNoteId: string) => {
    const dom = createDomTestHarness();
    // Solid binds delegated events to the document that existed at first import.
    delegateEvents(["click", "keydown"], dom.document);
    const { html: _html, ...initial } = snapshot(selectedNoteId);
    dom.window.history.replaceState({}, "", initial.href);
    const globals = ["HTMLInputElement", "HTMLFormElement", "FormData", "CSS", "PointerEvent"] as const;
    const previous = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
    globals.forEach((key) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: dom.window[key] }));
    dom.root.innerHTML = `<div class="notebook-book-shell"><div id="navigator"></div><div class="notebook-book-main">
      <article id="notebook-book-content" tabindex="-1"><h1>${selectedNoteId}</h1></article><div id="controller"></div></div></div>`;
    const requests: Array<{ href: string; resolve: (value: Response) => void }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      (input: string | URL | Request) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
        return new Promise<Response>((resolve) => requests.push({ href: url.searchParams.get("href")!, resolve }));
      },
      { preconnect: originalFetch.preconnect },
    );
    const { default: BookNavigator } = await import("./BookNavigator.island");
    const { default: BookController } = await import("./BookController.island");
    const disposeNavigator = render(
      () => createComponent(BookNavigator, { notebookId: "book01", notebookName: "Handbook", selectedNoteId, tree, tags: [] }),
      dom.root.querySelector("#navigator")!,
    );
    const disposeController = render(
      () => createComponent(BookController, { notebookId: "book01", initial }),
      dom.root.querySelector("#controller")!,
    );
    const item = (id: string) => dom.root.querySelector<HTMLElement>(`[data-k2b-nav-tree-id="${id}"]`)!;
    const row = (id: string) => item(id).firstElementChild as HTMLElement;
    return {
      requests,
      item,
      label: (id: string) => row(id).querySelector<HTMLElement>(".k2b-app-workspace__sidebar-item-label")!,
      chevron: (id: string) => row(id).querySelector<HTMLElement>("[data-k2b-nav-tree-toggle]")!,
      expanded: (id: string) => item(id).getAttribute("aria-expanded"),
      /** A live change elsewhere reloads the current note and delivers a fresh snapshot of it. */
      refresh: async (noteId: string) => {
        const covered = dispatchWorkspaceEvent(
          { v: 1, type: "workspace.invalidated", notebookId: "book01", reason: "bulk", scopes: ["tree"] },
          "1-0",
        );
        await flush();
        requests.at(-1)!.resolve(Response.json(snapshot(noteId)));
        await covered;
      },
      cleanup: () => {
        disposeController();
        disposeNavigator();
        globalThis.fetch = originalFetch;
        globals.forEach((key, index) => {
          const descriptor = previous[index];
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else Reflect.deleteProperty(globalThis, key);
        });
        dom.cleanup();
      },
    };
  };
  const click = (target: HTMLElement) => {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  // A tap reaches the page as pointer events followed by the same click.
  const tap = (target: HTMLElement) => {
    for (const type of ["pointerdown", "pointerup"]) target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "touch" }));
    return click(target);
  };
  const press = (target: HTMLElement, key: string) =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

  test("the row opens a note and the chevron folds it without navigating, and the fold survives live snapshots", async () => {
    const app = await mount("note02");
    try {
      expect(app.expanded("note01")).toBe("true");

      expect(click(app.label("note01")).defaultPrevented).toBe(true);
      await flush();
      expect(app.requests.map((request) => request.href)).toEqual(["/app/notebooks/book01/notes/note01?mode=book"]);
      app.requests[0]!.resolve(Response.json(snapshot("note01")));
      await flush();
      expect(app.item("note01").getAttribute("aria-selected")).toBe("true");
      expect(app.expanded("note01")).toBe("true");

      expect(click(app.chevron("note01")).defaultPrevented).toBe(true);
      await flush();
      expect(app.expanded("note01")).toBe("false");
      expect(app.requests).toHaveLength(1);
      expect(location.pathname).toEndWith("/note01");

      await app.refresh("note01");
      expect(app.expanded("note01")).toBe("false");

      expect(tap(app.chevron("note01")).defaultPrevented).toBe(true);
      await flush();
      expect(app.expanded("note01")).toBe("true");
      expect(app.requests).toHaveLength(2);
    } finally {
      app.cleanup();
    }
  });

  test("opening a note reveals it inside its parents but leaves its own sub-notes folded", async () => {
    const app = await mount("note03");
    try {
      expect(app.expanded("note01")).toBe("false");
      click(app.label("note01"));
      await flush();
      app.requests[0]!.resolve(Response.json(snapshot("note01")));
      await flush();
      expect(app.item("note01").getAttribute("aria-selected")).toBe("true");
      expect(app.expanded("note01")).toBe("false");
    } finally {
      app.cleanup();
    }
  });

  test("a page load unfolds the open note, keyboard folding holds across snapshots, and Enter still opens a note", async () => {
    const app = await mount("note01");
    try {
      const guide = app.item("note01");
      expect(app.expanded("note01")).toBe("true");
      expect(app.item("note02")).not.toBeNull();
      guide.focus();
      press(guide, "ArrowLeft");
      expect(app.expanded("note01")).toBe("false");
      press(guide, "ArrowRight");
      expect(app.expanded("note01")).toBe("true");
      press(guide, "ArrowLeft");
      expect(app.expanded("note01")).toBe("false");
      await flush();
      expect(app.requests).toHaveLength(0);

      await app.refresh("note01");
      expect(app.expanded("note01")).toBe("false");

      press(app.item("note03"), "Enter");
      await flush();
      expect(app.requests.at(-1)?.href).toBe("/app/notebooks/book01/notes/note03?mode=book");
      app.requests.at(-1)!.resolve(Response.json(snapshot("note03")));
      await flush();
      expect(app.item("note03").getAttribute("aria-selected")).toBe("true");
      expect(app.expanded("note01")).toBe("false");
    } finally {
      app.cleanup();
    }
  });
});
