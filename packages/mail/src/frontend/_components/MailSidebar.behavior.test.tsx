import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { mailTestFolder } from "./mail-list-test-fixtures";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return {
      ...(await import("./mail-sidebar.fixture")),
      ...(await import("./mail-mailbox-preferences")),
      ...(await import("./MailSidebar")),
      api: (await import("../../api/client")).apiClient,
      ui: await import("@k2b/ui"),
    };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

test.skipIf(isServer)("More toggles Archive, Trash and Junk and stays expanded while one is current", () => {
  const dom = createDomTestHarness();
  delegateEvents(["click"], dom.document);
  const m = modules!;
  const [active, setActive] = createSignal<string | null>(null);
  const dispose = render(
    () =>
      createComponent(m.default, {
        ...m.mailSidebarFixture(),
        get open() {
          return m.openMailboxFixture({
            activeFolderId: active(),
            folders: [
              mailTestFolder("Arch01", { name: "Archive", role: "archive" }),
              mailTestFolder("Trash1", { name: "Trash", role: "trash" }),
              mailTestFolder("Junk01", { name: "Junk", role: "junk" }),
            ],
          });
        },
      }),
    dom.root,
  );
  const more = () => [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "More")!;
  const archive = () => dom.root.querySelector('a[href="/app/mail/Box001?folder=Arch01"]');
  try {
    expect(archive()).toBeNull();
    more().click();
    for (const id of ["Arch01", "Trash1", "Junk01"])
      expect(dom.root.querySelector(`a[href="/app/mail/Box001?folder=${id}"]`)).not.toBeNull();
    more().click();
    expect(archive()).toBeNull();
    setActive("Arch01");
    expect(archive()?.getAttribute("aria-current")).toBe("page");
    more().click();
    expect(archive()).not.toBeNull();
    expect(dom.root.querySelector('[data-mailbox="Box001"] a')?.hasAttribute("aria-current")).toBe(false);
  } finally {
    dispose();
    dom.cleanup();
  }
});

test.skipIf(isServer)("pin and hide save preferences, reorder rows and roll back a failed save", async () => {
  const dom = createDomTestHarness();
  delegateEvents(["click"], dom.document);
  const m = modules!;
  const pending: Array<{ json: unknown; resolve(response: Response): void }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
      const request = new Request(input instanceof Request ? input : url, init);
      if (request.method !== "PATCH" || !url.pathname.endsWith("/preference"))
        throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
      const json: unknown = await request.json();
      return new Promise<Response>((resolve) => pending.push({ json, resolve }));
    },
    { preconnect: originalFetch.preconnect },
  );
  const dispose = render(
    () =>
      createComponent(
        m.default,
        m.mailSidebarFixture({
          open: null,
          mailboxes: [
            { id: "Box001", name: "Support", health: "active", healthReason: null, receivingAddress: null },
            { id: "Box002", name: "Sales", health: "active", healthReason: null, receivingAddress: null },
          ],
        }),
      ),
    dom.root,
  );
  const rows = () => [...dom.root.querySelectorAll("[data-mailbox]")].map((row) => row.getAttribute("data-mailbox"));
  const press = (name: string) => dom.root.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!.click();
  const waitFor = async (condition: () => boolean) => {
    const deadline = performance.now() + 2000;
    while (!condition()) {
      if (performance.now() > deadline) throw new Error("Preference did not settle");
      await Bun.sleep(1);
    }
  };
  try {
    press("Pin Sales");
    expect(rows()).toEqual(["Box002", "Box001"]);
    await waitFor(() => pending.length === 1);
    expect(pending[0]?.json).toEqual({ pinned: true });
    pending[0]!.resolve(Response.json({ pinned: true, hidden: false }));
    press("Hide Sales");
    const hidden = () => dom.root.querySelector('[data-mailbox="Box002"][data-hidden="true"]');
    expect(hidden()?.closest("section")?.textContent).toContain("Hidden mailboxes");
    await waitFor(() => pending.length === 2);
    expect(pending[1]?.json).toEqual({ hidden: true });
    pending[1]!.resolve(Response.json({ pinned: true, hidden: true }));
    press("Show Sales");
    expect(rows()).toEqual(["Box002", "Box001"]);
    await waitFor(() => pending.length === 3);
    pending[2]!.resolve(Response.json({ message: "Preference save failed" }, { status: 500 }));
    await waitFor(() => Boolean(hidden()));
    expect(dom.document.body.textContent).toContain("Preference save failed");
    press("Show Sales");
    await waitFor(() => pending.length === 4);
    pending[3]!.resolve(Response.json({ pinned: true, hidden: false }));
    press("Hide Sales");
    expect(hidden()).not.toBeNull();
    await waitFor(() => pending.length === 5);
    pending[4]!.resolve(Response.json({ message: "Could not hide mailbox" }, { status: 500 }));
    await waitFor(() => !hidden());
    expect(rows()).toEqual(["Box002", "Box001"]);
    expect(dom.document.body.textContent).toContain("Could not hide mailbox");
  } finally {
    for (const request of pending) request.resolve(Response.json({ pinned: true, hidden: true }));
    dispose();
    globalThis.fetch = originalFetch;
    m.ui.toast.dismissAll();
    dom.cleanup();
  }
});

test.skipIf(isServer)("live counts and a rename update the open mailbox's row in place, so its focus stays", () => {
  const dom = createDomTestHarness();
  const m = modules!;
  const [needsAction, setNeedsAction] = createSignal(2);
  const [name, setName] = createSignal("Support");
  const dispose = render(
    () =>
      createComponent(m.default, {
        ...m.mailSidebarFixture({ counts: [{ mailboxId: "Box001", unread: 4, needsAction: 9 }] }),
        get open() {
          const base = m.openMailboxFixture();
          return { ...base, mailboxName: name(), viewCounts: { ...base.viewCounts, needs_action: needsAction() } };
        },
      }),
    dom.root,
  );
  const link = () => dom.root.querySelector<HTMLAnchorElement>('[data-mailbox="Box001"] a[href="/app/mail/Box001"]')!;
  try {
    const before = link();
    before.focus();
    // The open mailbox follows the page: its Needs action count, and no unread dot as old as the page.
    expect(dom.root.querySelector('[data-mailbox="Box001"] .mail-sidebar-needs-action')?.textContent).toBe("2");
    expect(dom.root.querySelector('[data-mailbox="Box001"] .mail-sidebar-unread-dot')).toBeNull();
    setNeedsAction(5);
    setName("Renamed support");
    expect(link()).toBe(before);
    expect(dom.document.activeElement).toBe(before);
    expect(dom.root.querySelector('[data-mailbox="Box001"] .mail-sidebar-needs-action')?.textContent).toBe("5");
    expect(link().textContent).toContain("Renamed support");
  } finally {
    dispose();
    dom.cleanup();
  }
});

test.skipIf(isServer)("the open mailbox's health follows the page, not the sidebar's first snapshot", () => {
  const dom = createDomTestHarness();
  const m = modules!;
  const [health, setHealth] = createSignal<"paused" | "active">("paused");
  const dispose = render(
    () =>
      createComponent(m.default, {
        ...m.mailSidebarFixture({
          mailboxes: [{ id: "Box001", name: "Support", health: "paused", healthReason: null, receivingAddress: null }],
        }),
        get open() {
          return m.openMailboxFixture({ mailbox: { health: health(), healthReason: null, receivingAddress: null } });
        },
      }),
    dom.root,
  );
  const warning = () => dom.root.querySelector('[data-mailbox="Box001"] .mail-sidebar-health');
  try {
    expect(warning()).not.toBeNull();
    setHealth("active");
    expect(warning()).toBeNull();
  } finally {
    dispose();
    dom.cleanup();
  }
});

test.skipIf(isServer)("hiding the open mailbox opens the closed Hidden section, so its folders stay in view", async () => {
  const dom = createDomTestHarness();
  delegateEvents(["click"], dom.document);
  const m = modules!;
  const rowHidden: boolean[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => Response.json({ pinned: false, hidden: true }), { preconnect: originalFetch.preconnect });
  const dispose = render(
    () =>
      createComponent(
        m.default,
        m.mailSidebarFixture({
          mailboxes: [
            { id: "Box001", name: "Support", health: "active", healthReason: null, receivingAddress: null },
            { id: "Box002", name: "Sales", health: "active", healthReason: null, receivingAddress: null },
          ],
          preferences: m.createMailboxPreferences({ pinnedMailboxIds: [], hiddenMailboxIds: ["Box002"] }),
          open: m.openMailboxFixture({ folders: [mailTestFolder("Inbox1", { name: "Inbox", role: "inbox" })] }),
          onOpenPlaceRowHiddenChange: (hidden: boolean) => rowHidden.push(hidden),
        }),
      ),
    dom.root,
  );
  const inbox = () => dom.root.querySelector('a[href="/app/mail/Box001?folder=Inbox1"]');
  // A closed section keeps its rows in a hidden region.
  const shown = (element: Element | null) => Boolean(element) && !element!.closest("[hidden]");
  try {
    // The Hidden section starts closed: the open mailbox is not hidden yet.
    expect(shown(dom.root.querySelector('[data-mailbox="Box002"]'))).toBe(false);
    expect(shown(inbox())).toBe(true);
    // The open row keeps one "…": its pin and hide come first in that menu.
    expect(dom.root.querySelector('[data-mailbox="Box001"] button[aria-label="Hide Support"]')).toBeNull();
    dom.root.querySelector<HTMLButtonElement>('[data-mailbox="Box001"] button[aria-label="Options for Support"]')!.click();
    const items = [...dom.document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.slice(0, 2).map((item) => item.textContent?.trim())).toEqual(["Pin Support", "Hide Support"]);
    items[1]!.click();
    expect(dom.root.querySelector('[data-mailbox="Box001"][data-hidden="true"]')).not.toBeNull();
    expect(shown(inbox())).toBe(true);
    expect(rowHidden.at(-1)).toBe(false);
    // Closing the section hides the open mailbox's places, so the page names the open place again.
    const section = () => dom.root.querySelector<HTMLButtonElement>(".mail-sidebar-hidden-mailboxes button[aria-expanded]")!;
    section().click();
    expect(shown(inbox())).toBe(false);
    expect(rowHidden.at(-1)).toBe(true);
    section().click();
    expect(shown(inbox())).toBe(true);
    expect(rowHidden.at(-1)).toBe(false);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
