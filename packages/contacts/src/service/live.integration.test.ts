import { afterAll, beforeAll, expect, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { sql } from "bun";
import { databaseSuite, testInfra } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { create, move } from "./contacts";
import { commit } from "./imports";

type Book = { id: string; shortId: string };
type Pending = { payload: { d: { type: string; bookId: string; contactId?: string } } };

// Publishing and reading the topic is covered by the platform's own live outbox test.
const suite = databaseSuite();
const books: Book[] = [];

beforeAll(async () => {
  if (!testInfra.database) return;
  for (const name of ["Live source", "Live target", "Live import"]) {
    const [book] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO contacts.books (short_id, name) VALUES (${newShortId()}, ${name}) RETURNING id, short_id
    `;
    books.push({ id: book!.id, shortId: book!.short_id });
  }
});

afterAll(async () => {
  if (books.length === 0) return;
  const ids = books.map((book) => book.id);
  await sql`DELETE FROM events.outbox WHERE app_id = 'contacts' AND ordering_key IN ${sql(ids)}`;
  await sql`DELETE FROM contacts.books WHERE id IN ${sql(ids)}`;
});

const pendingFor = async (book: Book) =>
  (
    await sql<Pending[]>`
      SELECT payload FROM events.outbox WHERE app_id = 'contacts' AND ordering_key = ${book.id} ORDER BY seq
    `
  ).map((row) => row.payload.d);

suite("Contacts live updates", () => {
  test("a write and its live update commit together; a move is a removal and an addition", async () => {
    const [source, target] = books as [Book, Book];
    const created = await create({ bookId: source.id, data: { firstName: "Ada", lastName: "Example" } });
    if (!created.ok) throw new Error(created.error.message);
    const [contact] = await sql<{ short_id: string }[]>`SELECT short_id FROM contacts.contacts WHERE id = ${created.data.id}::uuid`;
    expect(await pendingFor(source)).toEqual([
      expect.objectContaining({ type: "contact.created", bookId: source.shortId, contactId: contact!.short_id }),
    ]);

    // A refused move changes nothing, so it announces nothing.
    const stale = await move({
      sourceBookId: source.id,
      targetBookId: target.id,
      id: created.data.id,
      expectedUpdatedAt: new Date(0).toISOString(),
    });
    expect(stale.ok).toBe(false);
    expect(await pendingFor(target)).toEqual([]);

    expect((await move({ sourceBookId: source.id, targetBookId: target.id, id: created.data.id })).ok).toBe(true);
    // Each book's readers learn only their own side, under public IDs.
    expect((await pendingFor(source)).map((event) => event.type)).toEqual(["contact.created", "contact.deleted"]);
    expect(await pendingFor(target)).toEqual([
      expect.objectContaining({ type: "contact.created", bookId: target.shortId, contactId: contact!.short_id }),
    ]);
  });

  test("an import announces the contacts it committed, even when it stops early", async () => {
    const [, , imported] = books as [Book, Book, Book];
    const stopped = commit({
      bookId: imported.id,
      candidates: ["Grace", "stop"],
      validateCandidate: (candidate) => {
        if (candidate === "stop") throw new Error("validation crashed");
        return ok({ firstName: String(candidate) });
      },
    });
    await expect(stopped).rejects.toThrow("validation crashed");
    expect(await pendingFor(imported)).toEqual([expect.objectContaining({ type: "contacts.imported", bookId: imported.shortId })]);
  });
});
