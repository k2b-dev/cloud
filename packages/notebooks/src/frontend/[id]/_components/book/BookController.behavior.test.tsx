import { describe, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import { dispatchWorkspaceEvent } from "../sidebar/workspace-events";
import { BOOK_SNAPSHOT_EVENT, type BookMetadata, type BookSnapshot } from "./book-state";

const initial: BookMetadata = {
  href: "/app/notebooks/book01/notes/note01?mode=book",
  title: "First",
  notebookName: "Handbook",
  selectedNoteId: "note01",
  tree: [],
  tags: [],
  canWrite: true,
  locked: false,
  cursor: null,
};
const snapshot = (noteId: string, title = noteId): BookSnapshot => ({
  ...initial,
  href: `/app/notebooks/book01/notes/${noteId}?mode=book`,
  selectedNoteId: noteId,
  title,
  html: `<h1 id="heading">${title}</h1>`,
});
const flush = () => Bun.sleep(20);

describe("Book controller", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }
  const mount = async (initialMode = "book") => {
    const dom = createDomTestHarness();
    const current = { ...initial, href: initial.href.replace("mode=book", `mode=${initialMode}`) };
    dom.window.history.replaceState({}, "", current.href);
    const globals = ["HTMLInputElement", "HTMLFormElement", "FormData", "CSS"] as const;
    const previous = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
    globals.forEach((key) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: dom.window[key] }));
    dom.root.innerHTML = `<div class="notebook-book-shell"><div class="notebook-book-main"><span id="notebook-book-name">Handbook</span>
      <a id="second" href="/app/notebooks/book01/notes/note02?mode=book">Second</a>
      <a id="third" href="/app/notebooks/book01/notes/note03?mode=book">Third</a>
      <a id="toc" href="#heading">TOC</a>
      <a id="write" href="/app/notebooks/book01/notes/note01?mode=write">Write</a>
      <article id="notebook-book-content" tabindex="-1"><h1 id="heading">First</h1></article><div id="controller"></div></div></div>`;
    const requests: Array<{ href: string; signal: AbortSignal | null | undefined; resolve: (value: Response) => void }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
        return new Promise<Response>((resolve) => requests.push({ href: url.searchParams.get("href")!, signal: init?.signal, resolve }));
      },
      { preconnect: originalFetch.preconnect },
    );
    const { default: BookController } = await import("./BookController.island.tsx");
    const dispose = render(
      () => createComponent(BookController, { notebookId: "book01", initial: current }),
      dom.root.querySelector("#controller")!,
    );
    return {
      dom,
      requests,
      article: dom.root.querySelector<HTMLElement>("article")!,
      click: (id: string, options: MouseEventInit = {}) => {
        const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...options });
        dom.root.querySelector(`#${id}`)!.dispatchEvent(event);
        return event;
      },
      cleanup: () => {
        dispose();
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

  test("preserves SSR HTML, loads only navigation targets, and rejects late responses", async () => {
    const app = await mount();
    try {
      await flush();
      expect(app.requests).toHaveLength(0);
      expect(app.article.textContent).toBe("First");
      expect(app.click("second").defaultPrevented).toBe(true);
      await flush();
      expect(app.requests).toHaveLength(1);
      expect(app.click("third").defaultPrevented).toBe(true);
      await flush();
      expect(app.requests).toHaveLength(2);
      expect(app.requests[0]!.signal?.aborted).toBe(true);
      app.requests[1]!.resolve(Response.json(snapshot("note03", "Newest")));
      await flush();
      expect(app.article.textContent).toBe("Newest");
      expect(location.pathname).toEndWith("/note03");
      expect(document.activeElement).toBe(app.article);
      app.requests[0]!.resolve(Response.json(snapshot("note02", "Obsolete")));
      await flush();
      expect(app.article.textContent).toBe("Newest");
      expect(location.pathname).toEndWith("/note03");
    } finally {
      app.cleanup();
    }
  });

  test("keeps TOC, modified clicks and mode switches native", async () => {
    const app = await mount();
    try {
      expect(app.click("toc").defaultPrevented).toBe(false);
      expect(app.click("write").defaultPrevented).toBe(false);
      expect(app.click("second", { ctrlKey: true }).defaultPrevented).toBe(false);
      await flush();
      expect(app.requests).toHaveLength(0);
    } finally {
      app.cleanup();
    }
  });

  test("loads GET tag filters without a document navigation and restores popstate", async () => {
    const app = await mount();
    try {
      app.article.innerHTML =
        '<form method="get" action="/app/notebooks/book01/tags/team"><input name="mode" value="book"><input name="search" value="a guide"></form>';
      const submit = new Event("submit", { bubbles: true, cancelable: true });
      app.article.querySelector("form")!.dispatchEvent(submit);
      expect(submit.defaultPrevented).toBe(true);
      await flush();
      expect(app.requests[0]!.href).toBe("/app/notebooks/book01/tags/team?mode=book&search=a+guide");
      app.requests[0]!.resolve(
        Response.json({
          ...snapshot("note01"),
          href: app.requests[0]!.href,
          selectedNoteId: null,
          activeTag: "team",
          html: "<h1>Tag results</h1>",
        }),
      );
      await flush();
      expect(location.pathname).toEndWith("/tags/team");
      expect(app.article.textContent).toBe("Tag results");
      const state = { notebooksBookScroll: { top: 123, left: 0, windowX: 0, windowY: 0 } };
      history.replaceState(state, "", initial.href);
      const length = history.length;
      window.dispatchEvent(Object.assign(new Event("popstate"), { state }));
      await flush();
      app.requests[1]!.resolve(Response.json(snapshot("note01", "Restored")));
      await flush();
      expect(app.article.textContent).toBe("Restored");
      expect(history.length).toBe(length);
      expect(app.article.closest(".notebook-book-main")!.scrollTop).toBe(123);
    } finally {
      app.cleanup();
    }
  });

  test("retains readable content after a failed load and retries the selected destination", async () => {
    const app = await mount();
    try {
      app.click("second");
      await flush();
      app.requests[0]!.resolve(Response.json({ message: "Unavailable" }, { status: 503 }));
      await flush();
      expect(app.article.textContent).toBe("First");
      expect(location.pathname).toEndWith("/note01");
      expect(app.dom.root.innerHTML).toContain("Retry");
      const retry = Array.from(app.dom.root.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
        button.textContent?.includes("Retry"),
      )!;
      expect(retry).toBeDefined();
      retry.click();
      await flush();
      expect(app.requests[1]!.href).toContain("note02");
      app.requests[1]!.resolve(Response.json(snapshot("note02", "Recovered")));
      await flush();
      expect(app.article.textContent).toBe("Recovered");
    } finally {
      app.cleanup();
    }
  });

  test("acknowledges live events only after the refreshed article and metadata commit", async () => {
    const app = await mount();
    try {
      let metadata: BookMetadata | undefined;
      const onSnapshot = (event: Event) => {
        metadata = (event as CustomEvent<BookMetadata>).detail;
      };
      window.addEventListener(BOOK_SNAPSHOT_EVENT, onSnapshot);
      let covered = false;
      const coverage = dispatchWorkspaceEvent(
        { v: 1, type: "workspace.invalidated", notebookId: "book01", reason: "bulk", scopes: ["tree"] },
        "1-0",
      ).then(() => {
        covered = true;
      });
      await flush();
      expect(covered).toBe(false);
      expect(app.requests).toHaveLength(1);
      app.requests[0]!.resolve(Response.json({ ...snapshot("note01", "Live"), canWrite: false }));
      await coverage;
      expect(app.article.textContent).toBe("Live");
      expect(metadata?.canWrite).toBe(false);
      expect(location.pathname).toEndWith("/note01");
      window.removeEventListener(BOOK_SNAPSHOT_EVENT, onSnapshot);
    } finally {
      app.cleanup();
    }
  });

  test("aborts pending work and ignores late replies after unmount", async () => {
    const app = await mount();
    app.click("second");
    await flush();
    const request = app.requests[0]!;
    app.cleanup();
    expect(request.signal?.aborted).toBe(true);
    request.resolve(Response.json(snapshot("note02", "Too late")));
    await flush();
    expect(app.article.textContent).toBe("First");
  });

  test("normalizes a forced Book entry URL before its first live refresh", async () => {
    const app = await mount("write");
    try {
      expect(location.search).toBe("?mode=book");
      const coverage = dispatchWorkspaceEvent(
        { v: 1, type: "workspace.invalidated", notebookId: "book01", reason: "bulk", scopes: ["tree"] },
        "1-0",
      );
      await flush();
      expect(app.requests[0]!.href).toBe(initial.href);
      app.requests[0]!.resolve(Response.json(snapshot("note01", "Current")));
      await coverage;
      expect(app.article.textContent).toBe("Current");
    } finally {
      app.cleanup();
    }
  });

  test("clears stale content and falls back to a document request when access or the note disappears", async () => {
    for (const status of [401, 403, 404]) {
      const app = await mount();
      const fallback = spyOn(window.location, "assign").mockImplementation(() => undefined);
      try {
        app.click("second");
        await flush();
        app.requests[0]!.resolve(Response.json({ message: "Unavailable" }, { status }));
        await flush();
        expect(app.article.textContent).toBe("");
        expect(fallback).toHaveBeenCalledWith("http://localhost/app/notebooks/book01/notes/note02?mode=book");
      } finally {
        fallback.mockRestore();
        app.cleanup();
      }
    }
  });
});
