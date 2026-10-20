import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../ui/test/dom";
import { feedbackContact } from "./fixtures/feedback-contact";

const until = async (done: () => boolean) => {
  for (let i = 0; i < 40 && !done(); i++) await Bun.sleep(10);
  expect(done()).toBe(true);
};
const announcements = async (document: Document) => {
  await Bun.sleep(150);
  return [...document.querySelectorAll('[data-k2b-live] [role="status"] > div')].map((line) => line.textContent);
};

describe("Contact editing feedback", () => {
  if (isServer) {
    test.skip("runs with browser conditions", () => {});
    return;
  }
  let dom: DomTestHarness;
  let dispose = () => {};
  let status = 500;
  const writes: Array<{ url: string; body: unknown }> = [];
  const previousFetch = globalThis.fetch;
  beforeEach(() => {
    dom = createDomTestHarness();
    status = 500;
    writes.length = 0;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
        if (request.method !== "GET") {
          writes.push({ url: request.url, body: await request.json() });
          return status === 200 ? Response.json(feedbackContact) : Response.json({ message: "Save unavailable" }, { status });
        }
        if (request.url.includes("duplicates") && writes.length > 0 && status === 200) return Response.json([]);
        if (request.url.includes("duplicates"))
          return Response.json([{ first: feedbackContact, second: { ...feedbackContact, id: "Cont02" }, reasons: ["name"] }]);
        if (request.url.includes("/tags")) return Response.json([]);
        return Response.json({ data: [{ ...feedbackContact, id: "Cont02" }] });
      },
      { preconnect: previousFetch.preconnect },
    );
  });
  afterEach(async () => {
    dispose();
    dispose = () => {};
    globalThis.fetch = previousFetch;
    const { dialogCore, toast } = await import("@k2b/ui");
    dialogCore.close();
    toast.dismissAll();
    dom.cleanup();
  });
  const click = (text: string) => {
    const button = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === text);
    expect(button).toBeDefined();
    button!.click();
  };
  const quickEdit = async () => {
    const { default: QuickEdit } = await import("../src/frontend/_components/ContactQuickEdit");
    dispose = render(
      () => createComponent(QuickEdit, { contact: feedbackContact, onSaved: () => {}, onCancel: () => {}, onEditAll: () => {} }),
      dom.root,
    );
  };
  test("a failed quick save stays inline with the input and no error dialog", async () => {
    const { prompts } = await import("@k2b/ui");
    const errors = spyOn(prompts, "error").mockResolvedValue(undefined);
    try {
      await quickEdit();
      click("Save");
      await until(() => writes.length === 1);
      await until(() => Boolean(dom.root.querySelector('[role="alert"]')));
      expect(dom.root.querySelector('[role="alert"]')?.textContent).toContain("Save unavailable");
      expect(dom.root.querySelector<HTMLInputElement>("input")?.value).toBe("Ada");
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
  test("a quick save announces the result without a success toast", async () => {
    const { toast } = await import("@k2b/ui");
    const successes = spyOn(toast, "success").mockImplementation(() => ({ dismiss() {}, update() {} }));
    status = 200;
    try {
      await quickEdit();
      click("Save");
      await until(() => writes.length === 1);
      expect(await announcements(dom.document)).toContain("Contact updated");
      expect(successes).not.toHaveBeenCalled();
    } finally {
      successes.mockRestore();
    }
  });
  test("a failed edit-dialog save stays inline and keeps the entered value", async () => {
    const { default: Upsert } = await import("../src/frontend/_components/ContactUpsertForm");
    const { prompts } = await import("@k2b/ui");
    const errors = spyOn(prompts, "error").mockResolvedValue(undefined);
    try {
      dispose = render(
        () => createComponent(Upsert, { mode: "edit", bookId: feedbackContact.bookId, initialContact: feedbackContact }),
        dom.root,
      );
      click("Save Changes");
      await until(() => writes.length === 1);
      await until(() => Boolean(dom.root.querySelector('[role="alert"]')));
      expect(dom.root.querySelector('[role="alert"]')?.textContent).toContain("Save unavailable");
      expect(dom.root.querySelector<HTMLInputElement>("input")?.value).toBe("Ada");
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
  test("a successful edit-dialog save closes through its owner without a toast", async () => {
    const { default: Upsert } = await import("../src/frontend/_components/ContactUpsertForm");
    const { toast } = await import("@k2b/ui");
    const successes = spyOn(toast, "success").mockImplementation(() => ({ dismiss() {}, update() {} }));
    let saved = false;
    status = 200;
    try {
      dispose = render(
        () =>
          createComponent(Upsert, {
            mode: "edit",
            bookId: feedbackContact.bookId,
            initialContact: feedbackContact,
            onSaved: () => {
              saved = true;
            },
          }),
        dom.root,
      );
      click("Save Changes");
      await until(() => saved);
      expect(successes).not.toHaveBeenCalled();
    } finally {
      successes.mockRestore();
    }
  });
  test("a failed member link remains inline next to the picker", async () => {
    const { default: AddMember } = await import("../src/frontend/_components/AddMemberDialog");
    let closed = false;
    dispose = render(
      () =>
        createComponent(AddMember, {
          parent: feedbackContact,
          close: () => {
            closed = true;
          },
        }),
      dom.root,
    );
    await until(() => [...dom.root.querySelectorAll("button")].some((entry) => entry.textContent?.includes("Ada Lovelace")));
    [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.includes("Ada Lovelace"))!.click();
    await until(() => writes.length === 1);
    await until(() => Boolean(dom.root.querySelector('[role="alert"]')));
    expect(closed).toBe(false);
    expect(dom.root.querySelector('[role="alert"]')?.textContent).toContain("Save unavailable");
  });
  test("a merged pair leaves the dialog list with one local announcement and no toast", async () => {
    const { openContactDuplicatesDialog } = await import("../src/frontend/_components/ContactDuplicatesDialog");
    const { prompts, toast } = await import("@k2b/ui");
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
    const successes = spyOn(toast, "success").mockImplementation(() => ({ dismiss() {}, update() {} }));
    status = 200;
    try {
      const done = openContactDuplicatesDialog(feedbackContact.bookId);
      await until(() => dom.document.body.textContent?.includes("Keep this record") ?? false);
      click("Keep this record");
      await until(() => dom.document.querySelector('dialog [role="status"]')?.textContent === "Contacts merged");
      expect(dom.document.body.textContent).not.toContain("Keep this record");
      expect(successes).not.toHaveBeenCalled();
      click("Done");
      await done;
    } finally {
      confirm.mockRestore();
      successes.mockRestore();
    }
  });
  test("duplicate merge failures stay in the review dialog", async () => {
    const { openContactDuplicatesDialog } = await import("../src/frontend/_components/ContactDuplicatesDialog");
    const { prompts } = await import("@k2b/ui");
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
    try {
      const done = openContactDuplicatesDialog(feedbackContact.bookId);
      await until(() => dom.document.body.textContent?.includes("Keep this record") ?? false);
      click("Keep this record");
      await until(() => writes.length === 1);
      await until(() => Boolean(dom.document.querySelector('dialog [role="alert"]')));
      expect(dom.document.querySelector('dialog [role="alert"]')?.textContent).toContain("Save unavailable");
      click("Done");
      await done;
    } finally {
      confirm.mockRestore();
    }
  });
});
