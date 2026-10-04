import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../../../ui/test/dom";

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

  const renderSection = async () => {
    const { default: NoteCommentsSection } = await import("./NoteCommentsSection");
    return render(
      () =>
        createComponent(NoteCommentsSection, {
          notebookId: "Book01",
          noteId: "Note01",
          currentUserId,
          canWrite: true,
          initialCommentsPage: emptyPage,
          dateConfig: { locale: "en", timeZone: "Europe/Berlin" },
        }),
      dom.root,
    );
  };

  test("a rejected comment stays in the composer with the reason under it", async () => {
    answer = rejectPosts;
    const { prompts, toast } = await import("@k2b/ui");
    const dialogs = spyOn(prompts, "error").mockResolvedValue(undefined);
    const successes = spyOn(toast, "success").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    const errors = spyOn(toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    const dispose = await renderSection();
    try {
      [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Add comment"))!.click();
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
      [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Add comment"))!.click();
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
      [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Add comment"))!.click();
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
});
