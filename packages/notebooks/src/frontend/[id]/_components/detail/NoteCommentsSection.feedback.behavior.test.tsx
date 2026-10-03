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

describe("Note comment feedback", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }
  let dom: DomTestHarness;
  const originalFetch = globalThis.fetch;
  beforeAll(() => {
    dom = createDomTestHarness();
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "POST"
          ? Response.json({ message: "Comments are closed for this note" }, { status: 409 })
          : Response.json({ items: [], page: 1, perPage: 30, total: 0, hasNext: false }),
      { preconnect: originalFetch.preconnect },
    );
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
    dom.cleanup();
  });

  test("a rejected comment stays in the composer with the reason under it", async () => {
    const { prompts, toast } = await import("@k2b/ui");
    const dialogs = spyOn(prompts, "error").mockResolvedValue(undefined);
    const successes = spyOn(toast, "success").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    const errors = spyOn(toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    const { default: NoteCommentsSection } = await import("./NoteCommentsSection");
    const dispose = render(
      () =>
        createComponent(NoteCommentsSection, {
          notebookId: "Book01",
          noteId: "Note01",
          currentUserId: "00000000-0000-4000-8000-000000000001",
          canWrite: true,
          initialCommentsPage: { items: [], page: 1, perPage: 30, total: 0, hasNext: false },
          dateConfig: { locale: "en", timeZone: "Europe/Berlin" },
        }),
      dom.root,
    );
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
});
