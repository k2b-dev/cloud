import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../../ui/test/dom";
import type { PublicRecordComment } from "../../../api/public-dto";

const actor = "00000000-0000-4000-8000-000000000001";
const now = "2026-10-03T10:00:00.000Z";
const comment: PublicRecordComment = {
  id: "Comm01",
  authorUserId: actor,
  authorDisplayName: "Tom Sample",
  authorAvatarHash: null,
  body: "Invoice sent.",
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
};
const endpoint = "/api/grids/records/Table1/Rec001/comments";
const flush = async () => {
  await Promise.resolve();
  await Bun.sleep(10);
};
const until = async (done: () => boolean) => {
  for (let attempt = 0; attempt < 40 && !done(); attempt++) await flush();
};

let answer: (method: string) => Response = () => Response.json({ message: "unexpected" }, { status: 500 });

describe("Record comment feedback", () => {
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
        const method = init?.method ?? "GET";
        if (method === "GET") {
          return Response.json({
            items: [comment],
            nextCursor: null,
            permissions: { actorUserId: actor, canWrite: true, canModerate: false },
          });
        }
        return answer(method);
      },
      { preconnect: originalFetch.preconnect },
    );
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
    dom.cleanup();
  });

  const renderComments = async () => {
    const { default: RecordComments } = await import("./RecordComments.island");
    const dispose = render(() => createComponent(RecordComments, { endpoint }), dom.root);
    await until(() => dom.root.textContent?.includes("Invoice sent.") ?? false);
    return dispose;
  };
  const button = (label: string) =>
    [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
    );

  test("a rejected comment stays in the composer and a rejected edit stays in its form, each with the reason", async () => {
    const { prompts, toast } = await import("@k2b/ui");
    const dialogs = spyOn(prompts, "error").mockResolvedValue(undefined);
    const successes = spyOn(toast, "success").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    const errors = spyOn(toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    answer = () => Response.json({ message: "Comments are closed for this record" }, { status: 409 });
    const dispose = await renderComments();
    try {
      button("Add comment")!.click();
      await until(() => Boolean(dom.root.querySelector(".k2b-discussion__composer textarea")));
      const composer = dom.root.querySelector<HTMLTextAreaElement>(".k2b-discussion__composer textarea")!;
      composer.value = "Reminder goes out on Friday.";
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await until(() => Boolean(dom.root.querySelector(".k2b-discussion__status")));

      expect(dom.root.querySelector(".k2b-discussion__status")?.textContent).toBe("Comments are closed for this record");
      expect(composer.value).toBe("Reminder goes out on Friday.");

      button("Edit comment")!.click();
      await until(() => Boolean(dom.root.querySelector('[aria-label="Edit comment"] textarea, textarea[aria-label="Edit comment"]')));
      const editor = dom.root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit comment"]')!;
      editor.value = "Invoice sent on Monday.";
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await until(() => editor.closest("form")?.textContent?.includes("Comments are closed for this record") ?? false);

      expect(editor.closest("form")?.textContent).toContain("Comments are closed for this record");
      expect(editor.value).toBe("Invoice sent on Monday.");
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
