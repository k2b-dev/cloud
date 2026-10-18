import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { databaseSuite, useFreshDatabase } from "../../../scripts/fixtures/test-infra";
import { newShortId } from "./lib/short-id";
import { migrate } from "./migrate";

const suite = databaseSuite();

suite("Contacts short-ID migration", () => {
  let db: SQL;
  let disposable: Awaited<ReturnType<typeof useFreshDatabase>>;

  beforeAll(async () => {
    disposable = await useFreshDatabase("contacts_migrate");
    db = new SQL(disposable.url);
    await db`
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (id UUID PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS auth.access (id UUID PRIMARY KEY)
    `.simple();
  });

  beforeEach(async () => {
    await db`DROP SCHEMA IF EXISTS contacts CASCADE`.simple();
  });

  afterAll(async () => {
    await db?.close();
    await disposable?.drop();
  });

  test("creates required short IDs with format checks and unique indexes and is idempotent", async () => {
    await migrate();
    const columns = await db<{ table_name: string; is_nullable: string }[]>`
      SELECT table_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'contacts' AND column_name = 'short_id'
      ORDER BY table_name
    `;
    expect(columns).toEqual([
      { table_name: "books", is_nullable: "NO" },
      { table_name: "contact_notes", is_nullable: "NO" },
      { table_name: "contacts", is_nullable: "NO" },
      { table_name: "tags", is_nullable: "NO" },
    ]);
    const constraints = await db<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE connamespace = 'contacts'::regnamespace
        AND conname IN ('contacts_books_short_id_format', 'contacts_contacts_short_id_format',
          'contacts_tags_short_id_format', 'contacts_notes_short_id_format')
        AND contype = 'c' AND convalidated
      ORDER BY conname
    `;
    expect(constraints.map((row) => row.conname)).toEqual([
      "contacts_books_short_id_format",
      "contacts_contacts_short_id_format",
      "contacts_notes_short_id_format",
      "contacts_tags_short_id_format",
    ]);
    const indexes = await db<{ relname: string }[]>`
      SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relnamespace = 'contacts'::regnamespace
        AND c.relname IN ('idx_contacts_books_short_id', 'idx_contacts_contacts_short_id',
          'idx_contacts_tags_short_id', 'idx_contacts_notes_short_id')
        AND i.indisunique AND i.indisvalid
      ORDER BY c.relname
    `;
    expect(indexes.map((row) => row.relname)).toEqual([
      "idx_contacts_books_short_id",
      "idx_contacts_contacts_short_id",
      "idx_contacts_notes_short_id",
      "idx_contacts_tags_short_id",
    ]);
    await expect(Promise.resolve(db`INSERT INTO contacts.books (name, short_id) VALUES ('Null ID', NULL)`)).rejects.toMatchObject({
      errno: "23502",
    });
    await expect(Promise.resolve(db`INSERT INTO contacts.books (name, short_id) VALUES ('Malformed ID', 'bad!')`)).rejects.toMatchObject({
      errno: "23514",
      constraint: "contacts_books_short_id_format",
    });
    await migrate();
  });

  test("leaves finalized rows and their short IDs unchanged on startup", async () => {
    await migrate();
    const [book] = await db<{ id: string }[]>`
      INSERT INTO contacts.books (name, short_id) VALUES ('Book', ${newShortId()}) RETURNING id
    `;
    if (!book) throw new Error("Missing book fixture");
    const [contact] = await db<{ id: string }[]>`
      INSERT INTO contacts.contacts (book_id, short_id) VALUES (${book.id}, ${newShortId()}) RETURNING id
    `;
    if (!contact) throw new Error("Missing contact fixture");
    await db`
      INSERT INTO contacts.tags (book_id, name, color, short_id)
      VALUES (${book.id}, 'Tag', '#112233', ${newShortId()})
    `;
    await db`
      INSERT INTO contacts.contact_notes (contact_id, author_display_name, content, short_id)
      VALUES (${contact.id}, 'Author', 'Note', ${newShortId()})
    `;
    const snapshot = () => db<{ resource: string; id: string; short_id: string; xmin: string }[]>`
      SELECT 'book' AS resource, id, short_id, xmin::text FROM contacts.books
      UNION ALL SELECT 'contact', id, short_id, xmin::text FROM contacts.contacts
      UNION ALL SELECT 'tag', id, short_id, xmin::text FROM contacts.tags
      UNION ALL SELECT 'note', id, short_id, xmin::text FROM contacts.contact_notes
      ORDER BY resource, id
    `;
    const before = await snapshot();
    expect(before).toHaveLength(4);
    await migrate();
    expect(await snapshot()).toEqual(before);
  });

  test("refuses nullable short IDs without changing the schema or filling NULL rows", async () => {
    await migrate();
    await db`ALTER TABLE contacts.tags ALTER COLUMN short_id DROP NOT NULL`.simple();
    const [book] = await db<{ id: string }[]>`
      INSERT INTO contacts.books (name, short_id) VALUES ('Book', ${newShortId()}) RETURNING id
    `;
    if (!book) throw new Error("Missing book fixture");
    await db`INSERT INTO contacts.tags (book_id, name, color, short_id) VALUES (${book.id}, 'Unfinished', '#112233', NULL)`;
    await expect(migrate()).rejects.toThrow(/v0\.45\.0/);
    await expect(migrate()).rejects.toThrow(/short IDs/);
    const [column] = await db<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'contacts' AND table_name = 'tags' AND column_name = 'short_id'
    `;
    expect(column?.is_nullable).toBe("YES");
    const tags = await db<{ short_id: string | null }[]>`SELECT short_id FROM contacts.tags`;
    expect(tags).toEqual([{ short_id: null }]);
  });

  test.each([
    ["missing table", "DROP TABLE contacts.contact_notes"],
    ["missing column", "ALTER TABLE contacts.tags DROP COLUMN short_id"],
    ["missing index", "DROP INDEX contacts.idx_contacts_tags_short_id"],
    ["missing constraint", "ALTER TABLE contacts.tags DROP CONSTRAINT contacts_tags_short_id_format"],
  ])("refuses an unfinished schema with a %s", async (_state, change) => {
    await migrate();
    await db.unsafe(change).simple();
    // A later migration would re-add this column if the guard did not run first.
    await db`ALTER TABLE contacts.contacts DROP COLUMN salutation`.simple();
    await expect(migrate()).rejects.toThrow(/short IDs/);
    const [column] = await db<{ exists: boolean }[]>`
      SELECT EXISTS (SELECT FROM information_schema.columns
        WHERE table_schema = 'contacts' AND table_name = 'contacts' AND column_name = 'salutation') AS exists
    `;
    expect(column?.exists).toBe(false);
  });

  test("refuses the pre-short-ID baseline without adding columns or tables", async () => {
    await db`
      CREATE SCHEMA contacts;
      CREATE TABLE contacts.books (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        description TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO contacts.books (name) VALUES ('Baseline book')
    `.simple();
    await expect(migrate()).rejects.toThrow(/v0\.45\.0/);
    await expect(migrate()).rejects.toThrow(/short IDs/);
    const columns = await db<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'contacts' AND table_name = 'books' AND column_name = 'short_id'
    `;
    expect(columns).toHaveLength(0);
    const tables = await db<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'contacts' ORDER BY table_name
    `;
    expect(tables).toEqual([{ table_name: "books" }]);
    const books = await db<{ name: string }[]>`SELECT name FROM contacts.books`;
    expect(books).toEqual([{ name: "Baseline book" }]);
  });
});
