import { describe, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import type { PublicNotebookWorkspaceEvent } from "../../../../lib/workspace-events";
import { dispatchWorkspaceEvent } from "../sidebar/workspace-events";
import { BOOK_SNAPSHOT_EVENT, type BookMetadata, type BookSnapshot } from "./book-state";

const bookHref = "/app/notebooks/book01/notes/note01?mode=book";
const snapshot: BookSnapshot = {
  href: bookHref,
  html: "<h1>Guide</h1>",
  title: "Guide",
  notebookName: "Handbook",
  selectedNoteId: "note01",
  tree: [{ id: "note01", title: "Renamed guide", children: [] }],
  tags: [],
  canWrite: false,
  locked: false,
  historyIncomplete: false,
  cursor: "2-0",
};
const changed: PublicNotebookWorkspaceEvent = {
  v: 1,
  type: "workspace.invalidated",
  notebookId: "book01",
  reason: "bulk",
  scopes: ["tree"],
};
const flush = () => Bun.sleep(20);

describe("Book graph live updates", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }
  const mount = async () => {
    const dom = createDomTestHarness();
    dom.window.history.replaceState({}, "", "/app/notebooks/book01?mode=graph&note=note01&from=book");
    const requests: Array<{ path: string; href: string | null; resolve: (value: Response) => void }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      (input: string | URL | Request) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
        return new Promise<Response>((resolve) => requests.push({ path: url.pathname, href: url.searchParams.get("href"), resolve }));
      },
      { preconnect: originalFetch.preconnect },
    );
    const { default: BookGraphLive } = await import("./BookGraphLive.island.tsx");
    const dispose = render(() => createComponent(BookGraphLive, { notebookId: "book01", bookHref }), dom.root);
    return {
      requests,
      cleanup: () => {
        dispose();
        globalThis.fetch = originalFetch;
        dom.cleanup();
      },
    };
  };

  test("acknowledges a change only after the Book navigation took the note's next snapshot", async () => {
    const app = await mount();
    let metadata: BookMetadata | undefined;
    const onSnapshot = (event: Event) => {
      metadata = (event as CustomEvent<BookMetadata>).detail;
    };
    window.addEventListener(BOOK_SNAPSHOT_EVENT, onSnapshot);
    try {
      let covered = false;
      const coverage = dispatchWorkspaceEvent(changed, "2-0").then(() => {
        covered = true;
      });
      await flush();
      expect(covered).toBe(false);
      expect(app.requests.map(({ path, href }) => ({ path, href }))).toEqual([{ path: "/api/notebooks/book01/book", href: bookHref }]);
      app.requests[0]!.resolve(Response.json(snapshot));
      await coverage;
      expect(metadata?.tree[0]?.title).toBe("Renamed guide");
      expect(metadata).not.toHaveProperty("html");
    } finally {
      window.removeEventListener(BOOK_SNAPSHOT_EVENT, onSnapshot);
      app.cleanup();
    }
  });

  test("covers comment and favorite changes without a request", async () => {
    const app = await mount();
    try {
      await dispatchWorkspaceEvent({ v: 1, type: "note.comments.changed", notebookId: "book01", noteId: "note01" }, "2-0");
      expect(app.requests).toHaveLength(0);
    } finally {
      app.cleanup();
    }
  });

  test("a grant or note that is gone loads the page again, so the server answers", async () => {
    for (const status of [401, 403, 404]) {
      const app = await mount();
      const assign = spyOn(window.location, "assign").mockImplementation(() => undefined);
      try {
        const coverage = dispatchWorkspaceEvent(changed, "2-0");
        await flush();
        app.requests[0]!.resolve(Response.json({ message: "Unavailable" }, { status }));
        await coverage;
        expect(assign).toHaveBeenCalledWith("http://localhost/app/notebooks/book01?mode=graph&note=note01&from=book");
      } finally {
        assign.mockRestore();
        app.cleanup();
      }
    }
  });

  test("a failed refresh rejects, so the event is not acknowledged", async () => {
    const app = await mount();
    try {
      const coverage = dispatchWorkspaceEvent(changed, "2-0");
      await flush();
      app.requests[0]!.resolve(Response.json({ message: "Busy" }, { status: 503 }));
      await expect(coverage).rejects.toThrow();
    } finally {
      app.cleanup();
    }
  });
});
