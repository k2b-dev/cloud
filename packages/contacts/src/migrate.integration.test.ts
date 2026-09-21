import { expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../scripts/fixtures/test-infra";
import { shortIdsFinalized } from "./lib/short-id";
import { migrate } from "./migrate";

const suite = databaseSuite();

suite("Contacts short-ID migration", () => {
  test("is idempotent and leaves every deployed resource resolvable", async () => {
    await migrate();
    await migrate();
    expect(await shortIdsFinalized()).toBeTrue();

    const [row] = await sql<
      {
        missing: number;
        malformed: number;
        duplicate_groups: number;
      }[]
    >`
      SELECT
        (
          (SELECT count(*) FROM contacts.books WHERE short_id IS NULL) +
          (SELECT count(*) FROM contacts.contacts WHERE short_id IS NULL) +
          (SELECT count(*) FROM contacts.tags WHERE short_id IS NULL) +
          (SELECT count(*) FROM contacts.contact_notes WHERE short_id IS NULL)
        )::int AS missing,
        (
          (SELECT count(*) FROM contacts.books WHERE short_id !~ '^[0-9A-Za-z]{6}$') +
          (SELECT count(*) FROM contacts.contacts WHERE short_id !~ '^[0-9A-Za-z]{6}$') +
          (SELECT count(*) FROM contacts.tags WHERE short_id !~ '^[0-9A-Za-z]{6}$') +
          (SELECT count(*) FROM contacts.contact_notes WHERE short_id !~ '^[0-9A-Za-z]{6}$')
        )::int AS malformed,
        (
          (SELECT count(*) FROM (SELECT short_id FROM contacts.books GROUP BY short_id HAVING count(*) > 1) duplicates) +
          (SELECT count(*) FROM (SELECT short_id FROM contacts.contacts GROUP BY short_id HAVING count(*) > 1) duplicates) +
          (SELECT count(*) FROM (SELECT short_id FROM contacts.tags GROUP BY short_id HAVING count(*) > 1) duplicates) +
          (SELECT count(*) FROM (SELECT short_id FROM contacts.contact_notes GROUP BY short_id HAVING count(*) > 1) duplicates)
        )::int AS duplicate_groups
    `;

    expect(row).toEqual({ missing: 0, malformed: 0, duplicate_groups: 0 });
  }, 30_000);
});
