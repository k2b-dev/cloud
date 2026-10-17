import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, setSystemTime, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../../../ui/test/dom";
import { RECONNECT_EVENT, SYNC_STATE_EVENT } from "./events";

const now = "2026-10-16T19:30:00.000Z";
const until = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt++) await Bun.sleep(10);
  expect(predicate()).toBe(true);
};
const activity = (index: number) => ({
  id: `activity${index}`,
  actor: { kind: "user", id: `user${index}`, displayName: `Author ${index}`, avatarHash: null },
  action: "note.edited",
  metadata: {},
  occurrenceCount: 1,
  lastOccurredAt: "2026-10-16T19:18:00.000Z",
});

describe("Notebook detail panel recovery and pagination", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }
  let dom: DomTestHarness;
  let answer: (url: URL) => Response;
  let requests: URL[];
  const originalFetch = globalThis.fetch;
  beforeAll(() => {
    dom = createDomTestHarness();
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost");
        // The comments list reads its own route when a comment changes; it is not what these tests count.
        if (url.pathname === "/api/notebooks/Book01/notes/Note01/comments/page")
          return Response.json({ items: [], page: 1, perPage: 30, total: 0, hasNext: false });
        expect(url.pathname).toBe("/api/notebooks/overview/activity");
        expect(url.searchParams.get("notebook")).toBe("Book01");
        expect(url.searchParams.get("note")).toBe("Note01");
        requests.push(url);
        return answer(url);
      },
      { preconnect: originalFetch.preconnect },
    );
  });
  beforeEach(() => {
    setSystemTime(new Date(now));
    requests = [];
    answer = () => Response.json({ data: [], nextCursor: null });
  });
  afterEach(() => {
    jest.useRealTimers();
    setSystemTime();
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
    dom.cleanup();
  });

  const renderPanel = async () => {
    const { LocaleProvider } = await import("@k2b/ui");
    const { default: Panel } = await import("./NotebookDetailPanel.island");
    return render(
      () =>
        createComponent(LocaleProvider, {
          locale: "de",
          get children() {
            return createComponent(Panel, {
              mode: "edit",
              initiallyOpen: true,
              fullWidth: false,
              tocItems: [],
              taskProgress: { done: 0, total: 0 },
              attachments: [],
              backlinks: [],
              namedBlocks: [],
              currentNotebookId: "Book01",
              notebookId: "Book01",
              noteId: "Note01",
              noteTitle: "Plan",
              contentMd: "# Plan",
              createdAt: "2026-10-13T19:30:00.000Z",
              updatedAt: "2026-10-16T19:18:00.000Z",
              lockedAt: null,
              historyIncomplete: false,
              isLocked: false,
              canWrite: true,
              currentUserId: "me",
              initialCommentsPage: { items: [], page: 1, perPage: 30, total: 0, hasNext: false },
              dateConfig: { locale: "de", timeZone: "UTC" },
            });
          },
        }),
      dom.root,
    );
  };
  const button = (label: string) =>
    [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label);
  const authors = () => [...dom.root.querySelectorAll(".notebook-activity-name")].map((item) => item.textContent);

  test("a manual reconnect becomes available again after five seconds without a connected event", async () => {
    const dispose = await renderPanel();
    let attempts = 0;
    const onReconnect = () => {
      attempts++;
    };
    window.addEventListener(RECONNECT_EVENT, onReconnect);
    try {
      await until(() => requests.length === 1);
      window.dispatchEvent(new CustomEvent(SYNC_STATE_EVENT, { detail: { connected: false, lastSavedAt: null } }));
      const reconnect = button("Erneut verbinden")!;
      jest.useFakeTimers();
      reconnect.click();
      expect(attempts).toBe(1);
      expect(reconnect.disabled).toBe(true);
      expect(reconnect.getAttribute("aria-busy")).toBe("true");
      jest.advanceTimersByTime(4_999);
      expect(reconnect.disabled).toBe(true);
      jest.advanceTimersByTime(1);
      expect(reconnect.disabled).toBe(false);
      expect(reconnect.hasAttribute("aria-busy")).toBe(false);
      expect(dom.root.querySelector(".notebook-offline-band")).not.toBeNull();
      reconnect.click();
      expect(attempts).toBe(2);
    } finally {
      dispose();
      window.removeEventListener(RECONNECT_EVENT, onReconnect);
    }
  });

  test("an ended session does not promise a resend or offer a reconnect that cannot work", async () => {
    const dispose = await renderPanel();
    try {
      await until(() => requests.length === 1);
      window.dispatchEvent(new CustomEvent(SYNC_STATE_EVENT, { detail: { connected: false, lastSavedAt: null, ended: true } }));
      await Bun.sleep(0);
      // The editor's own recovery bar owns this case.
      expect(dom.root.querySelector(".notebook-offline-band")).toBeNull();
      expect(button("Erneut verbinden")).toBeUndefined();
      window.dispatchEvent(new CustomEvent(SYNC_STATE_EVENT, { detail: { connected: false, lastSavedAt: null } }));
      await Bun.sleep(0);
      expect(dom.root.querySelector(".notebook-offline-band")).not.toBeNull();
    } finally {
      dispose();
    }
  });

  test("a new comment or a saved change of this note reads its activity again; other notes do not", async () => {
    const { WORKSPACE_EVENT } = await import("../sidebar/workspace-events");
    const { notebook, other } = { notebook: "Book01", other: "Note02" };
    let rows = 1;
    answer = () => Response.json({ data: Array.from({ length: rows }, (_, i) => activity(i)), nextCursor: null });
    const send = (event: Record<string, unknown>) => {
      const covered: Promise<void>[] = [];
      window.dispatchEvent(
        new CustomEvent(WORKSPACE_EVENT, {
          detail: { cursor: null, event: { v: 1, ...event }, cover: (p: Promise<void>) => covered.push(p) },
        }),
      );
      return covered.length;
    };
    const dispose = await renderPanel();
    try {
      await until(() => authors().length === 1);
      rows = 2;
      // The comments list covers the same event; the activity log is the second reader.
      expect(send({ type: "note.comments.changed", notebookId: notebook, noteId: "Note01", noteShortId: null })).toBe(2);
      await until(() => authors().length === 2);
      rows = 3;
      expect(send({ type: "note.updated", notebookId: notebook, note: { id: "Note01" } })).toBe(1);
      await until(() => authors().length === 3);
      expect(send({ type: "note.comments.changed", notebookId: notebook, noteId: other, noteShortId: null })).toBe(0);
      await Bun.sleep(30);
      expect(requests).toHaveLength(3);
    } finally {
      dispose();
    }
  });

  test("a saved change by someone else names them in the header, and a failed refresh retries the refresh", async () => {
    const { WORKSPACE_EVENT } = await import("../sidebar/workspace-events");
    let editor = { name: "Alice Example", at: "2026-10-16T19:18:00.000Z" };
    let failing = false;
    answer = () =>
      failing
        ? Response.json({ message: "Unavailable" }, { status: 503 })
        : Response.json({
            data: [{ ...activity(0), actor: { ...activity(0).actor, displayName: editor.name }, lastOccurredAt: editor.at }],
            nextCursor: null,
          });
    const updated = () =>
      window.dispatchEvent(
        new CustomEvent(WORKSPACE_EVENT, {
          detail: {
            cursor: null,
            event: { v: 1, type: "note.updated", notebookId: "Book01", note: { id: "Note01" } },
            // The workspace socket owns a failed coverage; the panel shows its own error row.
            cover: (coverage: Promise<void>) => void coverage.catch(() => undefined),
          },
        }),
      );
    const header = () => dom.root.querySelector(".k2b-detail-panel__supporting > p")?.textContent ?? "";
    const dispose = await renderPanel();
    try {
      await until(() => header().includes("Alice Example"));
      editor = { name: "Bob Example", at: "2026-10-16T19:25:00.000Z" };
      updated();
      await until(() => header().includes("Bob Example"));
      expect(dom.root.querySelector('time[datetime="2026-10-16T19:25:00.000Z"]')).not.toBeNull();

      // The refresh fails: the rows stay, and Retry reads the newest page again, not an older one.
      failing = true;
      updated();
      await until(() => Boolean(dom.root.querySelector('[role="alert"]')));
      expect(authors()).toEqual(["Bob Example"]);
      failing = false;
      editor = { name: "Cleo Example", at: "2026-10-16T19:28:00.000Z" };
      button("Erneut versuchen")!.click();
      await until(() => header().includes("Cleo Example"));
      expect(dom.root.querySelector('[role="alert"]')).toBeNull();
      expect(requests.every((url) => !url.searchParams.has("cursor"))).toBe(true);
    } finally {
      dispose();
    }
  });

  test("a failed older activity page keeps loaded rows and retries the same cursor", async () => {
    let olderAttempts = 0;
    answer = (url) => {
      if (!url.searchParams.has("cursor"))
        return Response.json({ data: Array.from({ length: 5 }, (_, i) => activity(i)), nextCursor: "older" });
      olderAttempts++;
      return olderAttempts === 1
        ? Response.json({ message: "Unavailable" }, { status: 503 })
        : Response.json({ data: [activity(5)], nextCursor: null });
    };
    const dispose = await renderPanel();
    try {
      await until(() => authors().length === 4);
      button("1 weitere anzeigen")!.click();
      expect(authors()).toEqual(["Author 0", "Author 1", "Author 2", "Author 3", "Author 4"]);
      button("Ältere laden")!.click();
      await until(() => Boolean(dom.root.querySelector('[role="alert"]')));
      expect(authors()).toEqual(["Author 0", "Author 1", "Author 2", "Author 3", "Author 4"]);
      expect(dom.root.querySelector('[role="alert"]')?.textContent).toContain("Neue Einträge laden nicht.");
      expect(button("Ältere laden")).toBeUndefined();
      button("Erneut versuchen")!.click();
      await until(() => authors().length === 6);
      expect(requests.map((url) => url.searchParams.get("cursor"))).toEqual([null, "older", "older"]);
      expect(authors()).toEqual(["Author 0", "Author 1", "Author 2", "Author 3", "Author 4", "Author 5"]);
      expect(dom.root.querySelector('[role="alert"]')).toBeNull();
    } finally {
      dispose();
    }
  });

  test("a sparse activity page with a cursor can load older rows and expands to show them", async () => {
    answer = (url) =>
      url.searchParams.has("cursor")
        ? Response.json({ data: [activity(4), activity(5)], nextCursor: null })
        : Response.json({ data: Array.from({ length: 4 }, (_, i) => activity(i)), nextCursor: "older" });
    const dispose = await renderPanel();
    try {
      await until(() => authors().length === 4);
      expect(button("Ältere laden")).toBeDefined();
      button("Ältere laden")!.click();
      await until(() => authors().length === 6);
      expect(authors()).toEqual(["Author 0", "Author 1", "Author 2", "Author 3", "Author 4", "Author 5"]);
      expect(button("Weniger anzeigen")?.getAttribute("aria-expanded")).toBe("true");
      expect(requests.map((url) => url.searchParams.get("cursor"))).toEqual([null, "older"]);
      expect(button("Ältere laden")).toBeUndefined();
    } finally {
      dispose();
    }
  });
});
