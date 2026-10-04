import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../ui/test/dom";
import type { ContactNote } from "../src/service";

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
const now = "2026-10-03T10:00:00.000Z";
let stored: ContactNote[] = [];
let reloadFails = false;

describe("Contact note feedback", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }
  let dom: DomTestHarness;
  const originalFetch = globalThis.fetch;
  beforeAll(() => {
    dom = createDomTestHarness();
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const content = typeof init?.body === "string" ? (JSON.parse(init.body) as { content: string }).content : "";
        const saved: ContactNote = {
          id: "Note01",
          contactId: "Cont01",
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
        if (reloadFails) return Response.json({ message: "Service unavailable" }, { status: 503 });
        return Response.json({ items: stored, page: 1, perPage: 30, total: stored.length, hasNext: false });
      },
      { preconnect: originalFetch.preconnect },
    );
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
    dom.cleanup();
  });

  const renderSection = async () => {
    const { default: ContactNotesSection } = await import("../src/frontend/_components/ContactNotesSection");
    return render(
      () =>
        createComponent(ContactNotesSection, {
          bookId: "Book01",
          contactId: "Cont01",
          currentUserId,
          canWrite: true,
          initialNotesPage: { items: [], page: 1, perPage: 30, total: 0, hasNext: false },
        }),
      dom.root,
    );
  };
  const submit = (textarea: HTMLTextAreaElement, value: string) => {
    textarea.value = value;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  };

  test("a note added, edited or deleted is announced to screen readers, with no toast", async () => {
    const { prompts, toast } = await import("@k2b/ui");
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
    const successes = spyOn(toast, "success").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    stored = [];
    reloadFails = false;
    dom.document.querySelector("[data-k2b-live]")?.remove();
    const dispose = await renderSection();
    try {
      [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Add comment"))!.click();
      await until(() => Boolean(dom.root.querySelector(".k2b-discussion__composer textarea")));
      submit(dom.root.querySelector<HTMLTextAreaElement>(".k2b-discussion__composer textarea")!, "Prefers calls after 4 pm.");
      await until(() => Boolean(dom.root.querySelector('button[aria-label="Edit comment"]')));
      expect(await announcements(dom.document)).toEqual(["Comment added"]);

      dom.root.querySelector<HTMLButtonElement>('button[aria-label="Edit comment"]')!.click();
      await until(() => Boolean(dom.root.querySelector(".k2b-discussion__composer textarea")));
      submit(dom.root.querySelector<HTMLTextAreaElement>(".k2b-discussion__composer textarea")!, "Prefers calls after 5 pm.");
      await until(() => dom.root.textContent?.includes("after 5 pm") ?? false);
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

  test("a note saved while the list cannot be reloaded is not announced, because the error toast says it was saved", async () => {
    const { toast } = await import("@k2b/ui");
    const errors = spyOn(toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    stored = [];
    reloadFails = true;
    dom.document.querySelector("[data-k2b-live]")?.remove();
    const dispose = await renderSection();
    try {
      [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Add comment"))!.click();
      await until(() => Boolean(dom.root.querySelector(".k2b-discussion__composer textarea")));
      submit(dom.root.querySelector<HTMLTextAreaElement>(".k2b-discussion__composer textarea")!, "Prefers calls after 4 pm.");
      await until(() => errors.mock.calls.length > 0);

      expect(errors.mock.calls).toEqual([["The comment was saved, but the comments list could not be reloaded."]]);
      expect(await announcements(dom.document)).toEqual([]);
    } finally {
      dispose();
      errors.mockRestore();
      reloadFails = false;
    }
  });
});
