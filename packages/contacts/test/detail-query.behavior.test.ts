import { describe, expect, test } from "bun:test";
import { query } from "@k2b/stdlib/solid";
import { createComponent, createEffect, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import { createContactQuerySource, isCurrentQuerySnapshot } from "../src/frontend/_components/contact-query-source";
import { setSelectedContactInUrl } from "../src/frontend/_components/context";
import type { Contact, ContactNote } from "../src/service";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("Contacts detail query behavior", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("covers a moved contact only after the new source commits", async () => {
    const dom = createDomTestHarness();
    const initialSource = createContactQuerySource({ bookId: "source", contactId: "ada", revision: 0 });
    const movedSource = createContactQuerySource({ bookId: "target", contactId: "ada", revision: 1 });
    const requests: Array<{
      source: string;
      invalidationCount: number;
      result: ReturnType<typeof deferred<{ source: string; value: string }>>;
    }> = [];
    let setSource!: (source: string) => void;
    let invalidate!: () => Promise<void>;

    const dispose = render(() => {
      const [source, updateSource] = createSignal(initialSource);
      setSource = updateSource;
      const detail = query.create<string, { source: string; value: string }>({
        source,
        initial: { source: initialSource, data: { source: initialSource, value: "source contact" } },
        load: (nextSource, context) => {
          const result = deferred<{ source: string; value: string }>();
          requests.push({ source: nextSource, invalidationCount: context.cause.invalidations.length, result });
          return result.promise;
        },
      });
      invalidate = detail.invalidate;
      const output = dom.document.createElement("output");
      createEffect(() => {
        const snapshot = detail.data();
        output.textContent = isCurrentQuerySnapshot(snapshot, source()) ? snapshot.value : "guarded";
      });
      return output;
    }, dom.root);

    setSource(movedSource);
    const covered = invalidate();
    await flush();

    expect(dom.root.textContent).toBe("guarded");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.source).toBe(movedSource);
    expect(requests[0]!.invalidationCount).toBe(1);

    let coveredCommitted = false;
    void covered.then(() => {
      coveredCommitted = true;
    });
    requests[0]!.result.resolve({ source: movedSource, value: "target contact" });
    await covered;
    expect(coveredCommitted).toBe(true);
    expect(dom.root.textContent).toBe("target contact");

    dispose();
    dom.cleanup();
  });

  test("keeps a favorite event authoritative when the contact is selected later", async () => {
    const dom = createDomTestHarness();
    const { default: ContactDetailPanel } = await import("../src/frontend/_components/ContactDetailPanel.island.tsx");
    const contact: Contact = {
      id: "ada",
      bookId: "team",
      label: null,
      firstName: "Ada",
      lastName: "Lovelace",
      companyName: null,
      department: null,
      jobTitle: null,
      vatId: null,
      birthday: null,
      salutation: null,
      pronouns: null,
      preferredLanguage: null,
      source: null,
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
      emails: [],
      phones: [],
      websites: [],
      addresses: [],
      bankAccounts: [],
      parentContactId: null,
      parent: null,
      members: [],
      tags: [],
    };
    const dispose = render(
      () =>
        createComponent(ContactDetailPanel, {
          initialContact: null,
          initialContactId: null,
          initialBookId: null,
          initialNotesPage: { items: [], page: 1, perPage: 30, total: 0, hasNext: false },
          contacts: [contact],
          bookNames: { team: "Team" },
          writableBooks: [],
          adminBookIds: [],
          currentUserId: "user-1",
          showEmpty: false,
          initialFavoriteKeys: [],
        }),
      dom.root,
    );

    window.dispatchEvent(
      new CustomEvent("contacts:favorite-changed", {
        detail: { bookId: contact.bookId, contactId: contact.id, favorite: true },
      }),
    );
    setSelectedContactInUrl({ contactId: contact.id, bookId: contact.bookId, contact, favorite: false });
    await flush();

    const favoriteButton = dom.root.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
    expect(favoriteButton?.getAttribute("aria-label")).toBe("Remove from favorites");

    dispose();
    dom.cleanup();
  });

  test("keeps a confirmed note deletion bound to the source that opened the prompt", async () => {
    const dom = createDomTestHarness();
    const { default: ContactNotesSection } = await import("../src/frontend/_components/ContactNotesSection.tsx");
    const now = "2026-08-11T00:00:00.000Z";
    const note: ContactNote = {
      id: "note-a",
      contactId: "contact-a",
      authorUserId: "user-1",
      authorDisplayName: "Ada Lovelace",
      authorAvatarHash: null,
      content: "Delete this note",
      createdAt: now,
      updatedAt: now,
      canEdit: true,
      canDelete: true,
    };
    const requests: Array<{ method: string; url: string }> = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
      requests.push({ method: request.method, url: request.url });
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ items: [], page: 1, perPage: 30, total: 0, hasNext: false });
    };
    const [bookId, setBookId] = createSignal("book-a");
    const [contactId, setContactId] = createSignal("contact-a");

    const dispose = render(
      () =>
        createComponent(ContactNotesSection, {
          get bookId() {
            return bookId();
          },
          get contactId() {
            return contactId();
          },
          currentUserId: "user-1",
          initialNotesPage: { items: [note], page: 1, perPage: 30, total: 1, hasNext: false },
          canWrite: true,
          isBookAdmin: false,
        }),
      dom.root,
    );

    dom.root.querySelector<HTMLButtonElement>('button[aria-label="Delete comment"]')?.click();
    await flush();
    setBookId("book-b");
    setContactId("contact-b");
    await flush();
    dom.document.querySelector<HTMLButtonElement>('dialog button[data-variant="danger"]')?.click();
    await flush();

    expect(requests.find((request) => request.method === "DELETE")?.url).toContain("/books/book-a/contacts/contact-a/notes/note-a");

    dispose();
    globalThis.fetch = previousFetch;
    dom.cleanup();
  });

  test("loads notes when a selected contact has no server-rendered page", async () => {
    const dom = createDomTestHarness();
    const { default: ContactNotesSection } = await import("../src/frontend/_components/ContactNotesSection.tsx");
    const requests: string[] = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
      requests.push(request.url);
      return Response.json({ items: [], page: 1, perPage: 30, total: 0, hasNext: false });
    };

    const dispose = render(
      () =>
        createComponent(ContactNotesSection, {
          bookId: "book-b",
          contactId: "contact-b",
          currentUserId: "user-1",
          canWrite: false,
          isBookAdmin: false,
        }),
      dom.root,
    );
    await flush();

    expect(requests.some((url) => url.includes("/books/book-b/contacts/contact-b/notes/page"))).toBe(true);

    dispose();
    globalThis.fetch = previousFetch;
    dom.cleanup();
  });
});
