import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { createStore } from "solid-js/store";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { DraftFolderItem, DraftFolderPage } from "../../contracts";

beforeEach(() => setSystemTime(new Date("2026-10-14T10:00:00.000Z")));
afterEach(() => setSystemTime());

// Bounded by the test's own timeout.
const waitFor = async (condition: () => boolean) => {
  while (!condition()) await Bun.sleep(10);
};

const draft = (id: string, subject: string): DraftFolderItem => ({
  id,
  conversationId: null,
  intent: "new",
  subject,
  to: [{ name: "Ada Example", address: "ada@example.test" }],
  cc: [],
  bcc: [],
  revision: 7,
  attachmentCount: 0,
  bodyPreview: "Invented draft text.",
  createdByDisplayName: "Ada Example",
  updatedAt: "2026-10-14T09:00:00.000Z",
});

type Answer = { status: number; body: Record<string, unknown> };

/**
 * The Drafts folder with two drafts and a stubbed discard route. `answer` decides what the server says; every request
 * and every reload the view asks for is recorded.
 */
const setup = async (answer: Answer = { status: 200, body: {} }, confirmed = true) => {
  const dom = createDomTestHarness();
  // Each test has a document of its own; Solid's delegated handlers, such as the row's right-click, listen on it.
  delegateEvents(["click", "contextmenu"]);
  const { prompts, toast } = await import("@k2b/ui");
  const { default: MailDraftsView } = await import("./MailDraftsView");
  const confirm = spyOn(prompts, "confirm").mockResolvedValue(confirmed);
  const notice = { dismiss: () => {}, update: () => {} };
  const successes = spyOn(toast, "success").mockImplementation(() => notice);
  const errors = spyOn(toast, "error").mockImplementation(() => notice);
  const requests: { url: string; method: string | undefined; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push({
        url: new URL(url, "http://localhost").pathname,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json(answer.body, { status: answer.status });
    },
    { preconnect: originalFetch.preconnect },
  );
  let refreshes = 0;
  // A store, like the workspace's: a reload updates a row's draft in place.
  const [page, setPage] = createStore<DraftFolderPage>({
    items: [draft("Drf001", "Quarterly figures"), draft("Drf002", "Workshop follow-up")],
    nextCursor: null,
    total: 2,
  });
  const dispose = render(
    () =>
      createComponent(MailDraftsView, {
        mailboxId: "Box001",
        canWrite: true,
        title: "Drafts",
        returnHref: "/app/mail/Box001?folder=Drafts1",
        page,
        error: null,
        dateConfig: { locale: "en", timeZone: "UTC" },
        loading: false,
        columns: false,
        onNavigate: () => undefined,
        onRefresh: async () => {
          refreshes += 1;
        },
      }),
    dom.root,
  );
  const row = (id: string) => dom.root.querySelector<HTMLElement>(`[data-draft-id="${id}"]`);
  const link = (id: string) => row(id)!.querySelector<HTMLAnchorElement>("a.mail-list-row")!;
  const menuItem = (label: string) =>
    [...dom.document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === label);
  return {
    dom,
    setPage,
    confirm,
    successes,
    errors,
    requests,
    refreshes: () => refreshes,
    row,
    link,
    menuItem,
    cleanup: () => {
      dispose();
      globalThis.fetch = originalFetch;
      confirm.mockRestore();
      successes.mockRestore();
      errors.mockRestore();
      dom.cleanup();
    },
  };
};

const discardRequest = (id: string) => ({
  url: `/api/mail/mailboxes/Box001/drafts/${id}/discard`,
  method: "POST",
  body: { expectedRevision: 7 },
});

test.skipIf(isServer)("the row's … menu continues a draft or deletes it after the confirmation, and the row leaves", async () => {
  const view = await setup();
  try {
    view.row("Drf001")!.querySelector<HTMLElement>(".k2b-dropdown__trigger")!.click();
    await waitFor(() => Boolean(view.menuItem("Delete draft")));
    const open = view.menuItem("Continue editing")!;
    expect(open.closest("a")?.getAttribute("href") ?? open.getAttribute("href")).toBe(
      "/app/mail/Box001/compose/Drf001?return=%2Fapp%2Fmail%2FBox001%3Ffolder%3DDrafts1",
    );
    view.menuItem("Delete draft")!.click();
    await waitFor(() => view.requests.length === 1);
    expect(view.confirm).toHaveBeenCalledTimes(1);
    expect(view.confirm.mock.calls[0]![1]).toMatchObject({ title: "Delete draft?", confirmText: "Delete draft", variant: "danger" });
    expect(view.requests).toEqual([discardRequest("Drf001")]);
    await waitFor(() => view.row("Drf001")?.dataset.leaving === "true");
    expect(view.successes).toHaveBeenCalledWith("Draft deleted");
    expect(view.refreshes()).toBe(1);
    await waitFor(() => view.row("Drf001") === null);
    expect(view.row("Drf002")).not.toBeNull();
  } finally {
    view.cleanup();
  }
});

test.skipIf(isServer)("a right-click on the row opens the same menu", async () => {
  const view = await setup();
  // The context menu places itself with DOMRect, which the test window does not put on globalThis.
  Object.defineProperty(globalThis, "DOMRect", { configurable: true, writable: true, value: view.dom.window.DOMRect });
  try {
    view.link("Drf002").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
    await waitFor(() => Boolean(view.dom.document.querySelector('.k2b-context-menu [role="menuitem"]')));
    const labels = [...view.dom.document.querySelectorAll(".k2b-context-menu [role='menuitem']")].map((item) => item.textContent?.trim());
    expect(labels).toEqual(["Continue editing", "Delete draft"]);
    view.dom.document.querySelectorAll<HTMLElement>(".k2b-context-menu [role='menuitem']")[1]!.click();
    await waitFor(() => view.requests.length === 1);
    expect(view.requests).toEqual([discardRequest("Drf002")]);
  } finally {
    view.cleanup();
    Reflect.deleteProperty(globalThis, "DOMRect");
  }
});

test.skipIf(isServer)("Delete and Backspace on a focused row delete it; a declined confirmation sends nothing", async () => {
  const declined = await setup({ status: 200, body: {} }, false);
  try {
    declined.link("Drf001").dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    await waitFor(() => declined.confirm.mock.calls.length === 1);
    await Bun.sleep(20);
    expect(declined.requests).toEqual([]);
    expect(declined.row("Drf001")?.getAttribute("aria-busy")).toBeNull();
    // Modified keys belong to the browser and other shortcuts.
    declined
      .link("Drf001")
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", metaKey: true, bubbles: true, cancelable: true }));
    await Bun.sleep(20);
    expect(declined.confirm).toHaveBeenCalledTimes(1);
  } finally {
    declined.cleanup();
  }
  const view = await setup();
  try {
    view.link("Drf002").dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    await waitFor(() => view.requests.length === 1);
    expect(view.requests).toEqual([discardRequest("Drf002")]);
  } finally {
    view.cleanup();
  }
});

test.skipIf(isServer)("a draft open in a composer stays in the list, and the error says why", async () => {
  const view = await setup({ status: 409, body: { code: "DRAFT_LEASE_HELD", message: "This draft is being edited by Ben" } });
  try {
    view.link("Drf001").dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    await waitFor(() => view.errors.mock.calls.length === 1);
    expect(view.errors).toHaveBeenCalledWith("Someone is editing this draft right now, so it stays. Try again once they're done.");
    expect(view.successes).not.toHaveBeenCalled();
    await waitFor(() => view.row("Drf001")?.getAttribute("aria-busy") === null);
    expect(view.row("Drf001")?.dataset.leaving).toBeUndefined();
    expect(view.refreshes()).toBe(1);
  } finally {
    view.cleanup();
  }
});

test.skipIf(isServer)(
  "a draft that is being sent or was scheduled meanwhile is protected: the server refuses and the row stays",
  async () => {
    // The Drafts folder lists only drafts; a send moves one to scheduled or sending, and discard accepts only a draft.
    const view = await setup({ status: 400, body: { code: "BAD_REQUEST", message: "Draft can no longer be discarded" } });
    try {
      view.row("Drf002")!.querySelector<HTMLElement>(".k2b-dropdown__trigger")!.click();
      await waitFor(() => Boolean(view.menuItem("Delete draft")));
      view.menuItem("Delete draft")!.click();
      await waitFor(() => view.errors.mock.calls.length === 1);
      expect(view.errors).toHaveBeenCalledWith("Draft can no longer be discarded");
      expect(view.row("Drf002")).not.toBeNull();
      expect(view.row("Drf002")?.dataset.leaving).toBeUndefined();
      // The reload shows the folder as it is now, without a draft that was sent meanwhile.
      expect(view.refreshes()).toBe(1);
    } finally {
      view.cleanup();
    }
  },
);

test.skipIf(isServer)("a draft changed since the list loaded stays, and a lost connection leaves the row as it was", async () => {
  const changed = await setup({ status: 409, body: { code: "CONFLICT", message: "Draft changed before it could be discarded" } });
  try {
    changed.link("Drf001").dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    await waitFor(() => changed.errors.mock.calls.length === 1);
    expect(changed.errors).toHaveBeenCalledWith("The draft changed in the meantime, so it stays. Check it and try again.");
    expect(changed.row("Drf001")).not.toBeNull();
  } finally {
    changed.cleanup();
  }
  const offline = await setup();
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async () => {
      throw new TypeError("Failed to fetch");
    },
    { preconnect: fetchBefore.preconnect },
  );
  try {
    offline.link("Drf001").dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    await waitFor(() => offline.errors.mock.calls.length === 1);
    expect(offline.row("Drf001")).not.toBeNull();
    expect(offline.row("Drf001")?.dataset.leaving).toBeUndefined();
    await waitFor(() => offline.row("Drf001")?.getAttribute("aria-busy") === null);
  } finally {
    globalThis.fetch = fetchBefore;
    offline.cleanup();
  }
});

test.skipIf(isServer)("a reload while the question is open does not change which revision is deleted", async () => {
  const view = await setup();
  let answer: (value: boolean) => void = () => {};
  view.confirm.mockImplementation(() => new Promise<boolean>((resolve) => (answer = resolve)));
  try {
    view.link("Drf001").dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    await waitFor(() => view.confirm.mock.calls.length === 1);
    // Someone edited the draft; the reload updates the row in place while the person still reads the question.
    view.setPage("items", 0, "revision", 8);
    answer(true);
    await waitFor(() => view.requests.length === 1);
    expect(view.requests).toEqual([discardRequest("Drf001")]);
  } finally {
    view.cleanup();
  }
});

test.skipIf(isServer)("focus moves on to the next draft, or back to the previous one, when the focused row leaves", async () => {
  const view = await setup();
  try {
    view.link("Drf001").focus();
    view.link("Drf001").dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    await waitFor(() => view.row("Drf001")?.dataset.leaving === "true");
    expect(view.dom.document.activeElement).toBe(view.link("Drf002"));
    await waitFor(() => view.row("Drf001") === null);
    view.link("Drf002").dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    await waitFor(() => view.row("Drf002")?.dataset.leaving === "true");
    // The last draft leaves: the folder's heading takes the focus, so the keyboard keeps its place in the page.
    expect(view.dom.document.activeElement?.tagName).toBe("H1");
  } finally {
    view.cleanup();
  }
});
