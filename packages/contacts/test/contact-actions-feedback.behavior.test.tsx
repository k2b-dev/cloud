import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { createComponent, createRoot, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../ui/test/dom";
import { feedbackContact } from "./fixtures/feedback-contact";

const until = async (done: () => boolean) => {
  for (let i = 0; i < 40 && !done(); i++) await Bun.sleep(10);
  expect(done()).toBe(true);
};

describe("Contact action recovery", () => {
  if (isServer) {
    test.skip("runs with browser conditions", () => {});
    return;
  }
  let dom: DomTestHarness;
  let dispose = () => {};
  const originalFetch = globalThis.fetch;
  const bodies: unknown[] = [];
  let status = 500;
  beforeEach(() => {
    setSystemTime(new Date("2026-10-03T10:00:00.000Z"));
    dom = createDomTestHarness();
    bodies.length = 0;
    status = 500;
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.body) bodies.push(JSON.parse(String(init.body)));
        return status === 200 ? Response.json(feedbackContact) : Response.json({ message: "Action unavailable" }, { status });
      },
      { preconnect: originalFetch.preconnect },
    );
  });
  afterEach(() => {
    dispose();
    dispose = () => {};
    globalThis.fetch = originalFetch;
    dom.cleanup();
    setSystemTime();
  });

  const detailActions = async () => {
    const { createContactDetailActions } = await import("../src/frontend/_components/ContactDetailPanel.actions");
    return createRoot((cleanup) => {
      dispose = cleanup;
      const [source, setSource] = createSignal<string | null>(null);
      const [, setMode] = createSignal<"details" | "tree">("details");
      return createContactDetailActions({
        bookId: () => "Book01",
        writableBooks: [
          { id: "Book01", name: "Source" },
          { id: "Book02", name: "Target" },
        ],
        orgTreeSource: source,
        setOrgTreeSource: setSource,
        setDetailMode: setMode,
        invalidateDetail: async () => {},
      });
    });
  };

  test("move Retry repeats the chosen target and dismisses its old notice", async () => {
    const { prompts, toast } = await import("@k2b/ui");
    const picker = spyOn(prompts, "form").mockResolvedValue({ targetBookId: "Book02" });
    let dismissed = 0;
    const errors = spyOn(toast, "error").mockImplementation(() => ({
      dismiss() {
        dismissed++;
      },
      update() {},
    }));
    try {
      const actions = await detailActions();
      await actions.moveToBook(feedbackContact);
      expect(bodies).toEqual([{ targetBookId: "Book02" }]);
      const retry = errors.mock.calls[0]?.[1]?.action;
      expect(retry && "onClick" in retry).toBe(true);
      if (retry && "onClick" in retry) await retry.onClick();
      await until(() => bodies.length === 2);
      expect(bodies).toEqual([{ targetBookId: "Book02" }, { targetBookId: "Book02" }]);
      expect(dismissed).toBe(1);
      dispose();
      dispose = () => {};
      expect(dismissed).toBeGreaterThanOrEqual(1);
    } finally {
      picker.mockRestore();
      errors.mockRestore();
    }
  });

  test("a failed tree read exposes an inline recovery state without an error prompt", async () => {
    const { prompts } = await import("@k2b/ui");
    const errors = spyOn(prompts, "error").mockResolvedValue(undefined);
    try {
      const actions = await detailActions();
      actions.openOrgTree(feedbackContact);
      await until(() => actions.orgTreeError() !== null);
      expect(actions.orgTreeError()?.message).toBe("Action unavailable");
      expect(errors).not.toHaveBeenCalled();
      status = 200;
      await actions.retryOrgTree();
      expect(actions.orgTreeError()).toBeNull();
    } finally {
      errors.mockRestore();
    }
  });

  test("bulk tag Retry preserves the selected IDs and tags after selection changes", async () => {
    const { default: Bulk } = await import("../src/frontend/_components/ContactsBulkActions");
    const { dialogCore, toast } = await import("@k2b/ui");
    const choose = spyOn(dialogCore, "open").mockResolvedValue(["Tag01"]);
    let dismissed = 0;
    const errors = spyOn(toast, "error").mockImplementation(() => ({
      dismiss() {
        dismissed++;
      },
      update() {},
    }));
    const successes = spyOn(toast, "success").mockImplementation(() => ({ dismiss() {}, update() {} }));
    const [selection, setSelection] = createSignal(["Cont01"]);
    let refreshing = false;
    let finishRefresh!: () => void;
    const refreshed = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    try {
      dispose = render(
        () =>
          createComponent(Bulk, {
            bookId: "Book01",
            selectedIds: selection,
            visibleIds: () => ["Cont01"],
            tags: [
              {
                id: "Tag01",
                bookId: "Book01",
                name: "VIP",
                color: "#3b82f6",
                createdAt: feedbackContact.createdAt,
                updatedAt: feedbackContact.updatedAt,
              },
            ],
            writableBooks: [],
            onSelectVisible() {},
            onClear() {
              dispose();
              dispose = () => {};
            },
            async onChanged() {
              refreshing = true;
              await refreshed;
            },
          }),
        dom.root,
      );
      [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Tag")!.click();
      await until(() => errors.mock.calls.length > 0);
      setSelection(["Cont02"]);
      const retry = errors.mock.calls[0]?.[1]?.action;
      expect(retry && "onClick" in retry).toBe(true);
      status = 200;
      if (retry && "onClick" in retry) await retry.onClick();
      await until(() => bodies.length === 2);
      expect(bodies).toEqual([
        { contactIds: ["Cont01"], tagIds: ["Tag01"] },
        { contactIds: ["Cont01"], tagIds: ["Tag01"] },
      ]);
      expect(dismissed).toBe(1);
      await until(() => refreshing);
      const tagsButton = [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Tag",
      )!;
      expect(tagsButton.disabled).toBe(true);
      tagsButton.click();
      if (retry && "onClick" in retry) await retry.onClick();
      expect(bodies).toHaveLength(2);
      finishRefresh();
      await until(() =>
        [...dom.document.querySelectorAll('[data-k2b-live] [role="status"] > div')].some((line) =>
          line.textContent?.includes("Tags added"),
        ),
      );
      expect(successes).not.toHaveBeenCalled();
    } finally {
      choose.mockRestore();
      errors.mockRestore();
      successes.mockRestore();
    }
  });

  test("destination feedback waits for its contact and consumes its URL marker once", async () => {
    const { announceContactOutcome, contactOutcomeHref } = await import("../src/frontend/_components/contact-outcome");
    dom.window.history.replaceState({}, "", contactOutcomeHref(feedbackContact, "created"));
    const text = { contactCreated: "Contact created", contactMoved: "Contact moved", contactUpdated: "Contact updated" };
    announceContactOutcome({ ...feedbackContact, id: "Other" }, text);
    expect(dom.window.location.search).toContain("contactOutcome=created");
    announceContactOutcome(feedbackContact, text);
    announceContactOutcome(feedbackContact, text);
    await Bun.sleep(150);
    expect(dom.window.location.search).not.toContain("contactOutcome");
    expect([...dom.document.querySelectorAll('[data-k2b-live] [role="status"] > div')].map((line) => line.textContent)).toEqual([
      "Contact created",
    ]);
  });
});
