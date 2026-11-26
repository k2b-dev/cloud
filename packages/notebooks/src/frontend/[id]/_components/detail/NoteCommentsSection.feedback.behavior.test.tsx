import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../../../ui/test/dom";
import type { PublicNoteComment } from "../../../../api/public-resources";

const flush = async () => {
  await Promise.resolve();
  await Bun.sleep(10);
};
const until = async (done: () => boolean) => {
  for (let attempt = 0; attempt < 40 && !done(); attempt++) await flush();
};
/** The lines the shared polite status region of `@k2b/ui` reads, once its announcement delay has passed. */
const announcements = async (document: Document) => {
  await Bun.sleep(150);
  return [...document.querySelectorAll('[data-k2b-live] [role="status"] > div')].map((line) => line.textContent);
};
/** The comments section and its parts, as the v2 drawing shows them. */
const section = (root: ParentNode) =>
  root.querySelector<HTMLElement>('[data-k2-part="Section"][aria-label="Comments"], [data-k2-part="Section"][aria-label="Kommentare"]');
const bands = (root: ParentNode) => [...(section(root)?.querySelectorAll<HTMLElement>('[data-k2-part="Band"]') ?? [])];
const field = (root: ParentNode) => section(root)?.querySelector<HTMLTextAreaElement>("textarea") ?? null;
const buttonNamed = (root: ParentNode, name: string) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === name || button.getAttribute("aria-label") === name,
  );
/** Types into the composer and presses its send button. */
const send = (root: ParentNode, value: string, label = "Post comment") => {
  const textarea = field(root)!;
  textarea.value = value;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  buttonNamed(section(root)!, label)!.click();
};
/** Opens a comment's "…" and chooses an entry. */
const _choose = async (document: Document, band: HTMLElement, entry: string) => {
  buttonNamed(band, "Comment actions")!.click();
  await Bun.sleep(20);
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === entry)!.click();
};
const _toasts = (document: Document) =>
  [...document.querySelectorAll('[data-k2-part="Toast"] li')].map((toast) => toast.textContent?.trim());
const currentUserId = "00000000-0000-4000-8000-000000000001";
const emptyPage = { items: [], page: 1, perPage: 30, total: 0, hasNext: false };
const rejectPosts = (init?: RequestInit) =>
  init?.method === "POST" ? Response.json({ message: "Comments are closed for this note" }, { status: 409 }) : Response.json(emptyPage);
let answer: (init?: RequestInit) => Response = rejectPosts;

describe("Note comment feedback", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }
  let dom: DomTestHarness;
  const originalFetch = globalThis.fetch;
  beforeAll(() => {
    dom = createDomTestHarness();
    // v2 toasts read their text with a tree walker; the harness binds browser globals one by one.
    Object.defineProperty(globalThis, "NodeFilter", { configurable: true, value: dom.window.NodeFilter });
    globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => answer(init), {
      preconnect: originalFetch.preconnect,
    });
  });
  afterEach(() => dom.root.replaceChildren());
  afterAll(() => {
    globalThis.fetch = originalFetch;
    Reflect.deleteProperty(globalThis, "NodeFilter");
    dom.cleanup();
  });

  const renderSection = async (items: PublicNoteComment[] = [], locale = "en") => {
    const { LocaleProvider } = await import("@k2b/ui");
    const { default: NoteCommentsSection } = await import("./NoteCommentsSection");
    return render(
      () =>
        createComponent(LocaleProvider, {
          locale,
          get children() {
            return createComponent(NoteCommentsSection, {
              notebookId: "Book01",
              noteId: "Note01",
              currentUserId,
              canWrite: true,
              initialCommentsPage: { ...emptyPage, items, total: items.length },
              dateConfig: { locale, timeZone: "Europe/Berlin", ...{ base: "2026-10-16T19:30:00.000Z" } },
            });
          },
        }),
      dom.root,
    );
  };

  test("German comments fold to the newest three, call the viewer Du and open the composer below the list", async () => {
    const comments = Array.from(
      { length: 5 },
      (_, index): PublicNoteComment => ({
        id: `comment${index}`,
        notebookId: "Book01",
        noteId: "Note01",
        authorUserId: index === 4 ? currentUserId : "jana",
        authorDisplayName: index === 4 ? "Tom Sample" : "Jana Berger",
        authorAvatarHash: null,
        content: `Kommentar ${index}`,
        createdAt: `2026-10-03T10:0${index}:00.000Z`,
        updatedAt: `2026-10-03T10:0${index}:00.000Z`,
        canEdit: index === 4,
        canDelete: index === 4,
      }),
    ).reverse();
    const dispose = await renderSection(comments, "de");
    try {
      expect(bands(dom.root).map((band) => band.querySelector(".k2-row-title")?.textContent)).toEqual(["Jana Berger", "Jana Berger", "Du"]);
      expect(bands(dom.root).map((band) => band.textContent)).toEqual([
        expect.stringContaining("Kommentar 2"),
        expect.stringContaining("Kommentar 3"),
        expect.stringContaining("Kommentar 4"),
      ]);
      const older = [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "2 ältere anzeigen",
      )!;
      older.click();
      expect(bands(dom.root)).toHaveLength(5);
      const comment = [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Kommentieren",
      )!;
      comment.focus();
      comment.click();
      await until(() => Boolean(field(dom.root)));
      const textarea = field(dom.root)!;
      expect(Boolean(bands(dom.root).at(-1)!.compareDocumentPosition(textarea) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
      // The button turns disabled, so focus moves into the composer below the list, which the panel scrolls to.
      await until(() => dom.document.activeElement === textarea);
      expect(dom.document.activeElement).toBe(textarea);
      // Cancel hands focus back to the button.
      buttonNamed(section(dom.root)!, "Abbrechen")!.click();
      // the head's button comes back enabled and takes the focus
      await until(() => dom.document.activeElement?.textContent?.trim() === "Kommentieren");
      expect(field(dom.root)).toBeNull();
      expect(dom.document.activeElement?.textContent?.trim()).toBe("Kommentieren");
    } finally {
      dispose();
    }
  });

  test("a rejected comment stays in the composer with the reason under it", async () => {
    answer = rejectPosts;
    const { prompts, toast } = await import("@k2b/ui");
    const dialogs = spyOn(prompts, "error").mockResolvedValue(undefined);
    const successes = spyOn(toast, "success").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    const errors = spyOn(toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    const dispose = await renderSection();
    try {
      [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Comment"))!.click();
      await until(() => Boolean(field(dom.root)));
      send(dom.root, "Link the budget sheet here.");
      await until(() => section(dom.root)?.textContent?.includes("Comments are closed for this note") ?? false);

      // the reason stands at the field, and the draft stays
      expect(section(dom.root)?.textContent).toContain("Comments are closed for this note");
      expect(field(dom.root)?.value).toBe("Link the budget sheet here.");
      expect(dialogs).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
      expect(successes).not.toHaveBeenCalled();
    } finally {
      dispose();
      dialogs.mockRestore();
      successes.mockRestore();
      errors.mockRestore();
    }
  });
  test("a comment added is announced to screen readers, with no toast", async () => {
    const now = "2026-10-03T10:00:00.000Z";
    let stored: Array<Record<string, unknown>> = [];
    answer = (init) => {
      const content = typeof init?.body === "string" ? (JSON.parse(init.body) as { content: string }).content : "";
      const saved = {
        id: "Comm01",
        notebookId: "Book01",
        noteId: "Note01",
        authorUserId: currentUserId,
        authorDisplayName: "Tom Sample",
        authorAvatarHash: null,
        content,
        createdAt: now,
        updatedAt: now,
        canEdit: true,
        canDelete: true,
      };
      if (init?.method === "POST" || init?.method === "PATCH") {
        stored = [saved];
        return Response.json(saved);
      }
      if (init?.method === "DELETE") {
        stored = [];
        return Response.json({ ok: true });
      }
      return Response.json({ ...emptyPage, items: stored, total: stored.length });
    };
    dom.document.querySelector("[data-k2b-live]")?.remove();
    const dispose = await renderSection();
    try {
      [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Comment"))!.click();
      await until(() => Boolean(field(dom.root)));
      send(dom.root, "Link the budget sheet here.");
      await until(() => bands(dom.root).length === 1);
      expect(await announcements(dom.document)).toEqual(["Comment added"]);

      // Editing and deleting through the comment's "…" run in a real browser (detail-panel.browser.test.ts).

      // Nothing visible is added: the list itself shows each change.
      expect(dom.root.textContent).not.toContain("Comment added");
    } finally {
      dispose();
    }
  });
  test("a comment saved while the discussion cannot be refreshed is not announced, because the error toast says it was saved", async () => {
    answer = (init) =>
      init?.method === "POST"
        ? Response.json({
            id: "Comm01",
            notebookId: "Book01",
            noteId: "Note01",
            authorUserId: currentUserId,
            authorDisplayName: "Tom Sample",
            authorAvatarHash: null,
            content: "Link the budget sheet here.",
            createdAt: "2026-10-03T10:00:00.000Z",
            updatedAt: "2026-10-03T10:00:00.000Z",
            canEdit: true,
            canDelete: true,
          })
        : Response.json({ message: "Service unavailable" }, { status: 503 });
    dom.document.querySelector("[data-k2b-live]")?.remove();
    const dispose = await renderSection();
    try {
      [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Comment"))!.click();
      await until(() => Boolean(field(dom.root)));
      send(dom.root, "Link the budget sheet here.");
      const saved = "The comment was saved, but the discussion could not be refreshed.";
      await until(() => dom.document.body.textContent?.includes(saved) ?? false);

      expect(dom.document.body.textContent).toContain(saved);
      expect(await announcements(dom.document)).toEqual([]);
    } finally {
      dispose();
    }
  });

  test("an activity link pages in its comment, unfolds and focuses it, with a ten-page search limit", async () => {
    const { setSystemTime } = await import("bun:test");
    const { REVEAL_COMMENT_EVENT } = await import("./events");
    const { LocaleProvider } = await import("@k2b/ui");
    const { default: NoteCommentsSection } = await import("./NoteCommentsSection");
    const now = "2026-10-16T19:30:00.000Z";
    setSystemTime(new Date(now));
    const comment = (id: string): PublicNoteComment => ({
      id,
      notebookId: "Book01",
      noteId: "Note01",
      authorUserId: "jana",
      authorDisplayName: "Jana Berger",
      authorAvatarHash: null,
      content: `Comment ${id}`,
      createdAt: "2026-10-03T10:00:00.000Z",
      updatedAt: "2026-10-03T10:00:00.000Z",
      canEdit: false,
      canDelete: false,
    });
    const pages: number[] = [];
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: RequestInfo | URL) => {
          const url = new URL(String(input), "http://localhost");
          expect(url.pathname).toBe("/api/notebooks/Book01/notes/Note01/comments/page");
          const page = Number(url.searchParams.get("page"));
          pages.push(page);
          return Response.json({
            ...emptyPage,
            page,
            total: 400,
            hasNext: page < 14,
            items: [comment(page === 3 ? "target" : `page${page}`)],
          });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale: "de",
          get children() {
            return createComponent(NoteCommentsSection, {
              notebookId: "Book01",
              noteId: "Note01",
              currentUserId,
              canWrite: true,
              initialCommentsPage: {
                ...emptyPage,
                total: 400,
                hasNext: true,
                items: [comment("newest"), comment("middle"), comment("oldest-loaded")],
              },
              dateConfig: { locale: "de", timeZone: "UTC" },
            });
          },
        }),
      dom.root,
    );
    try {
      expect(bands(dom.root)).toHaveLength(3);
      window.dispatchEvent(new CustomEvent(REVEAL_COMMENT_EVENT, { detail: { commentId: "target" } }));
      await until(() => dom.document.activeElement === bands(dom.root).find((band) => band.textContent?.includes("Comment target")));
      const target = bands(dom.root).find((band) => band.textContent?.includes("Comment target")) ?? null;
      expect(target).not.toBeNull();
      expect(dom.document.activeElement).toBe(target);
      expect(pages).toEqual([2, 3]);
      expect(bands(dom.root)).toHaveLength(5);

      // An eleventh page remains available, but a missing comment stops the search after ten.
      window.dispatchEvent(new CustomEvent(REVEAL_COMMENT_EVENT, { detail: { commentId: "missing" } }));
      await until(() => dom.document.activeElement === section(dom.root));
      expect(pages).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    } finally {
      dispose();
      fetch.mockRestore();
      setSystemTime();
    }
  });

  test("an activity link stops paging when an older page fails, and leaves the retry to the list", async () => {
    const { REVEAL_COMMENT_EVENT } = await import("./events");
    const requests: number[] = [];
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: RequestInfo | URL) => {
          requests.push(Number(new URL(String(input), "http://localhost").searchParams.get("page")));
          return Response.json({ message: "Unavailable" }, { status: 503 });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const { LocaleProvider } = await import("@k2b/ui");
    const { default: NoteCommentsSection } = await import("./NoteCommentsSection");
    const comment: PublicNoteComment = {
      id: "newest",
      notebookId: "Book01",
      noteId: "Note01",
      authorUserId: "jana",
      authorDisplayName: "Jana Berger",
      authorAvatarHash: null,
      content: "Newest",
      createdAt: "2026-10-03T10:00:00.000Z",
      updatedAt: "2026-10-03T10:00:00.000Z",
      canEdit: false,
      canDelete: false,
    };
    const dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale: "de",
          get children() {
            return createComponent(NoteCommentsSection, {
              notebookId: "Book01",
              noteId: "Note01",
              currentUserId,
              canWrite: true,
              initialCommentsPage: { ...emptyPage, total: 60, hasNext: true, items: [comment] },
              dateConfig: { locale: "de", timeZone: "UTC", base: "2026-10-16T19:30:00.000Z" },
            });
          },
        }),
      dom.root,
    );
    try {
      window.dispatchEvent(new CustomEvent(REVEAL_COMMENT_EVENT, { detail: { commentId: "older" } }));
      await until(() => dom.document.activeElement === section(dom.root));
      // One failed request, not ten in a row; the list shows the failure with its own retry.
      expect(requests).toEqual([2]);
      expect(dom.root.querySelector('[role="alert"]')).not.toBeNull();
    } finally {
      dispose();
      fetch.mockRestore();
    }
  });

  test("a reveal that is still paging stops when the person switches notes", async () => {
    const { createSignal } = await import("solid-js");
    const { REVEAL_COMMENT_EVENT } = await import("./events");
    let release: (() => void) | undefined;
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: RequestInfo | URL) => {
          const url = new URL(String(input), "http://localhost");
          if (url.pathname.includes("/Note01/")) await new Promise<void>((resolve) => (release = resolve));
          return Response.json(emptyPage);
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const { LocaleProvider } = await import("@k2b/ui");
    const { default: NoteCommentsSection } = await import("./NoteCommentsSection");
    const [noteId, setNoteId] = createSignal("Note01");
    const comment: PublicNoteComment = {
      id: "newest",
      notebookId: "Book01",
      noteId: "Note01",
      authorUserId: "jana",
      authorDisplayName: "Jana Berger",
      authorAvatarHash: null,
      content: "Newest",
      createdAt: "2026-10-03T10:00:00.000Z",
      updatedAt: "2026-10-03T10:00:00.000Z",
      canEdit: false,
      canDelete: false,
    };
    const dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale: "de",
          get children() {
            return createComponent(NoteCommentsSection, {
              notebookId: "Book01",
              get noteId() {
                return noteId();
              },
              currentUserId,
              canWrite: true,
              initialCommentsPage: { ...emptyPage, total: 60, hasNext: true, items: [comment] },
              dateConfig: { locale: "de", timeZone: "UTC", base: "2026-10-16T19:30:00.000Z" },
            });
          },
        }),
      dom.root,
    );
    try {
      const outside = dom.document.createElement("button");
      dom.document.body.append(outside);
      outside.focus();
      window.dispatchEvent(new CustomEvent(REVEAL_COMMENT_EVENT, { detail: { commentId: "older" } }));
      await until(() => release !== undefined);
      setNoteId("Note02");
      release?.();
      await flush();
      await flush();
      // The other note's discussion is not scrolled to or focused by a reveal that began on the first note.
      expect(dom.document.activeElement).toBe(outside);
      outside.remove();
    } finally {
      dispose();
      fetch.mockRestore();
    }
  });
});
