import { expect, test } from "bun:test";
import { EXPORT_PAGE_SIZE, exportPages } from "./contacts";
import type { Contact } from "./types";

const bookId = "00000000-0000-4000-8000-000000000001";
const ids = Array.from({ length: EXPORT_PAGE_SIZE }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
const contact = (id: string, book = bookId): Contact => ({
  id,
  bookId: book,
  label: null,
  firstName: null,
  lastName: null,
  companyName: null,
  department: null,
  jobTitle: null,
  vatId: null,
  birthday: null,
  salutation: null,
  pronouns: null,
  preferredLanguage: null,
  source: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  emails: [],
  phones: [],
  addresses: [],
  websites: [],
  bankAccounts: [],
  parentContactId: null,
  parent: null,
  members: [],
  tags: [],
});

const fullPage = { ids, contacts: new Map(ids.map((id) => [id, contact(id)])) };

test("request abort after a full page prevents the next page query", async () => {
  const controller = new AbortController();
  let calls = 0;
  const pages = exportPages({ bookId, signal: controller.signal }, async () => {
    calls++;
    return fullPage;
  });
  expect((await pages.next()).value).toHaveLength(EXPORT_PAGE_SIZE);
  const reason = new Error("Client disconnected");
  controller.abort(reason);
  await expect(pages.next()).rejects.toBe(reason);
  expect(calls).toBe(1);
});

test("keyset uses the last queried ID even when hydration drops it, preserves order, and stops at a short page", async () => {
  const cursors: (string | null)[] = [];
  const lastId = ids.at(-1)!;
  const pages = exportPages({ bookId, signal: new AbortController().signal }, async ({ after, bookId: requestedBook }) => {
    expect(requestedBook).toBe(bookId);
    cursors.push(after);
    if (after === null) {
      // Reverse hydration order; the last queried ID vanished, and another contact moved books.
      const contacts = new Map([...fullPage.contacts].reverse());
      contacts.delete(lastId);
      contacts.set(ids[1]!, contact(ids[1]!, "another-book"));
      return { ids, contacts };
    }
    return { ids: ["last"], contacts: new Map([["last", contact("last")]]) };
  });
  const first = await pages.next();
  expect(first.value).toEqual(ids.filter((id) => id !== lastId && id !== ids[1]).map((id) => contact(id)));
  expect((await pages.next()).value).toEqual([contact("last")]);
  expect((await pages.next()).done).toBe(true);
  expect(cursors).toEqual([null, lastId]);
});

test("skips empty hydrated pages and stops on an empty ID page", async () => {
  const cursors: (string | null)[] = [];
  const pages = exportPages({ bookId, signal: new AbortController().signal }, async ({ after }) => {
    cursors.push(after);
    return { ids: after === null ? ids : [], contacts: new Map<string, Contact>() };
  });
  expect((await pages.next()).done).toBe(true);
  expect(cursors).toEqual([null, ids.at(-1)!]);
});

test("an invalid book ID never loads a page", async () => {
  let calls = 0;
  const pages = exportPages({ bookId: "invalid", signal: new AbortController().signal }, async () => {
    calls++;
    return fullPage;
  });
  expect((await pages.next()).done).toBe(true);
  expect(calls).toBe(0);
});
