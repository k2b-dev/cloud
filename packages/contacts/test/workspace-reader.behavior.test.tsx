import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import { feedbackContact } from "./fixtures/feedback-contact";

describe("Contacts workspace reader", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  beforeEach(() => setSystemTime(new Date("2026-11-08T12:00:00Z")));
  afterEach(() => setSystemTime());

  test("opens from the full list, keeps favorites, and restores the reader on history navigation", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const contact = feedbackContact;
    let favorite = false;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path.includes("/favorites/")) {
          if (init?.method === "PUT") favorite = true;
          return Response.json({ favorite });
        }
        if (path.endsWith("/notes")) return Response.json({ items: [], page: 1, perPage: 30, total: 0, hasNext: false });
        if (path.endsWith(`/contacts/${contact.id}`)) return Response.json(contact);
        throw new Error(`Unexpected request: ${path}`);
      },
      { preconnect: originalFetch.preconnect },
    );
    let dispose: (() => void) | undefined;
    try {
      history.replaceState({}, "", "/app/contacts/Book01?search=Ada&tag_id=work&page=2");
      const { AppWorkspace } = await import("@k2b/ui");
      const { default: ContactsWorkspace } = await import("../src/frontend/_components/ContactsWorkspace.island");
      delegateEvents(["click", "change"], dom.document);
      dispose = render(
        () => (
          <AppWorkspace>
            <AppWorkspace.Content>
              <ContactsWorkspace
                list={{
                  scope: "book",
                  title: "Team",
                  description: "Team contacts",
                  total: 1,
                  search: "Ada",
                  resultHref: `${location.pathname}${location.search}`,
                  bookId: contact.bookId,
                  perPage: 30,
                  searchPlaceholder: "Search contacts",
                  contacts: [contact],
                  bookNames: { Book01: "Team" },
                  initialSelectedContactId: null,
                  initialSelectedBookId: null,
                  writableBooks: [{ id: contact.bookId, name: "Team" }],
                  defaultCreateBookId: contact.bookId,
                  currentPage: 2,
                  totalPages: 2,
                  initialFavoriteKeys: [],
                }}
                reader={{
                  initialContact: null,
                  initialContactId: null,
                  initialBookId: null,
                  contacts: [contact],
                  bookNames: { Book01: "Team" },
                  writableBooks: [{ id: contact.bookId, name: "Team" }],
                  adminBookIds: [],
                  memberBookIds: [],
                  currentUserId: "user-1",
                  initialFavoriteKeys: [],
                  timeZone: "UTC",
                }}
              />
            </AppWorkspace.Content>
          </AppWorkspace>
        ),
        dom.root,
      );
      const reader = () => dom.root.querySelector('[data-workspace-main-region="contacts-reader"]');
      const row = () => dom.root.querySelector<HTMLAnchorElement>("a[data-contact-row]")!;
      expect(reader()).toBeNull();
      expect(dom.root.querySelector(".k2b-app-workspace__detail")).toBeNull();
      row().click();
      const selectedHref = location.href;
      expect(reader()?.textContent).toContain("Ada Lovelace");
      expect(new URL(selectedHref).searchParams.get("contact")).toBe(contact.id);
      const favoriteButton = () => reader()!.querySelector<HTMLButtonElement>("button[aria-pressed]")!;
      favoriteButton().click();
      await Bun.sleep(20);
      expect(favorite).toBe(true);
      expect(favoriteButton().getAttribute("aria-pressed")).toBe("true");
      reader()!.querySelector<HTMLButtonElement>('button[aria-label="Close contact"]')!.click();
      expect(reader()).toBeNull();
      expect(location.search).toBe("?search=Ada&tag_id=work&page=2");
      row().click();
      expect(reader()?.textContent).toContain("Ada Lovelace");
      expect(favoriteButton().getAttribute("aria-pressed")).toBe("true");
      reader()!.querySelector<HTMLButtonElement>('button[aria-label="Close contact"]')!.click();
      // A popstate after the reader unmounted must seed it from the current selection.
      history.replaceState({}, "", selectedHref);
      window.dispatchEvent(new Event("popstate"));
      await Bun.sleep(20);
      expect(reader()?.textContent).toContain("Ada Lovelace");
      expect(favoriteButton().getAttribute("aria-pressed")).toBe("true");
      expect(row().getAttribute("aria-current")).toBe("true");
      expect(reader()!.querySelector("a.k2b-app-workspace__level-back")?.getAttribute("href")).toBe(
        "/app/contacts/Book01?search=Ada&tag_id=work&page=2",
      );
    } finally {
      dispose?.();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
});
