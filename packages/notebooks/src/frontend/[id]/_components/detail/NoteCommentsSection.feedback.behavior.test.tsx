import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
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
    globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => answer(init), {
      preconnect: originalFetch.preconnect,
    });
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
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
      expect([...dom.root.querySelectorAll(".k2b-discussion__entry > header > strong")].map((author) => author.textContent)).toEqual([
        "Jana Berger",
        "Jana Berger",
        "Du",
      ]);
      expect([...dom.root.querySelectorAll(".k2b-discussion__item")].map((item) => item.textContent)).toEqual([
        expect.stringContaining("Kommentar 2"),
        expect.stringContaining("Kommentar 3"),
        expect.stringContaining("Kommentar 4"),
      ]);
      const older = [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "2 ältere anzeigen",
      )!;
      older.click();
      expect(dom.root.querySelectorAll(".k2b-discussion__item")).toHaveLength(5);
      [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Kommentieren")!.click();
      await until(() => Boolean(dom.root.querySelector(".k2b-discussion__composer textarea")));
      const list = dom.root.querySelector(".k2b-discussion__list")!;
      const composer = dom.root.querySelector(".k2b-discussion__composer")!;
      expect(Boolean(list.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
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
      await until(() => Boolean(dom.root.querySelector(".k2b-discussion__composer textarea")));
      const composer = dom.root.querySelector<HTMLTextAreaElement>(".k2b-discussion__composer textarea")!;
      composer.value = "Link the budget sheet here.";
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await until(() => Boolean(dom.root.querySelector(".k2b-discussion__status")));

      expect(dom.root.querySelector(".k2b-discussion__status")?.textContent).toBe("Comments are closed for this note");
      expect(composer.value).toBe("Link the budget sheet here.");
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
  test("a comment added, edited or deleted is announced to screen readers, with no toast", async () => {
    const { prompts, toast } = await import("@k2b/ui");
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
    const successes = spyOn(toast, "success").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
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
    const submit = (textarea: HTMLTextAreaElement, value: string) => {
      textarea.value = value;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    };
    try {
      [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Comment"))!.click();
      await until(() => Boolean(dom.root.querySelector(".k2b-discussion__composer textarea")));
      submit(dom.root.querySelector<HTMLTextAreaElement>(".k2b-discussion__composer textarea")!, "Link the budget sheet here.");
      await until(() => Boolean(dom.root.querySelector('button[aria-label="Edit comment"]')));
      expect(await announcements(dom.document)).toEqual(["Comment added"]);

      dom.root.querySelector<HTMLButtonElement>('button[aria-label="Edit comment"]')!.click();
      await until(() => Boolean(dom.root.querySelector(".k2b-discussion__composer textarea")));
      submit(dom.root.querySelector<HTMLTextAreaElement>(".k2b-discussion__composer textarea")!, "The budget sheet is linked.");
      await until(() => dom.root.textContent?.includes("The budget sheet is linked.") ?? false);
      expect(await announcements(dom.document)).toEqual(["Comment added", "Comment updated"]);

      dom.root.querySelector<HTMLButtonElement>('button[aria-label="Delete comment"]')!.click();
      await until(() => !dom.root.querySelector('button[aria-label="Delete comment"]'));
      expect(await announcements(dom.document)).toEqual(["Comment added", "Comment updated", "Comment deleted"]);

      // Nothing visible is added: the list itself shows each change.
      expect(successes).not.toHaveBeenCalled();
      expect(dom.root.textContent).not.toContain("Comment added");
    } finally {
      dispose();
      confirm.mockRestore();
      successes.mockRestore();
    }
  });
  test("a comment saved while the discussion cannot be refreshed is not announced, because the error toast says it was saved", async () => {
    const { toast } = await import("@k2b/ui");
    const errors = spyOn(toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
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
      await until(() => Boolean(dom.root.querySelector(".k2b-discussion__composer textarea")));
      const composer = dom.root.querySelector<HTMLTextAreaElement>(".k2b-discussion__composer textarea")!;
      composer.value = "Link the budget sheet here.";
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await until(() => errors.mock.calls.length > 0);

      expect(errors.mock.calls).toEqual([["The comment was saved, but the discussion could not be refreshed."]]);
      expect(await announcements(dom.document)).toEqual([]);
    } finally {
      dispose();
      errors.mockRestore();
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
    // The DOM harness binds browser globals individually; comment links also need CSS.escape.
    const previousCSS = Object.getOwnPropertyDescriptor(globalThis, "CSS");
    Object.defineProperty(globalThis, "CSS", { configurable: true, value: dom.window.CSS });
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
      expect(dom.root.querySelectorAll("[data-note-comment]")).toHaveLength(3);
      window.dispatchEvent(new CustomEvent(REVEAL_COMMENT_EVENT, { detail: { commentId: "target" } }));
      await until(() => dom.document.activeElement?.getAttribute("data-note-comment") === "target");
      const target = dom.root.querySelector('[data-note-comment="target"]');
      expect(target).not.toBeNull();
      expect(dom.document.activeElement).toBe(target);
      expect(pages).toEqual([2, 3]);
      expect(dom.root.querySelectorAll("[data-note-comment]")).toHaveLength(5);

      // An eleventh page remains available, but a missing comment stops the search after ten.
      window.dispatchEvent(new CustomEvent(REVEAL_COMMENT_EVENT, { detail: { commentId: "missing" } }));
      await until(() => dom.document.activeElement === dom.root.querySelector("[data-note-comments]"));
      expect(pages).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    } finally {
      dispose();
      fetch.mockRestore();
      if (previousCSS) Object.defineProperty(globalThis, "CSS", previousCSS);
      else Reflect.deleteProperty(globalThis, "CSS");
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
    const previousCSS = Object.getOwnPropertyDescriptor(globalThis, "CSS");
    Object.defineProperty(globalThis, "CSS", { configurable: true, value: dom.window.CSS });
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
      await until(() => dom.document.activeElement === dom.root.querySelector("[data-note-comments]"));
      // One failed request, not ten in a row; the list shows the failure with its own retry.
      expect(requests).toEqual([2]);
      expect(dom.root.querySelector('[role="alert"]')).not.toBeNull();
    } finally {
      dispose();
      fetch.mockRestore();
      if (previousCSS) Object.defineProperty(globalThis, "CSS", previousCSS);
      else Reflect.deleteProperty(globalThis, "CSS");
    }
  });
});
