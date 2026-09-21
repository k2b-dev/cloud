import { expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite, testFor } from "../../../scripts/fixtures/test-infra";
import { shortIdsFinalized } from "./lib/short-id";
import { migrate } from "./migrate";

const suite = databaseSuite();

suite("Venue short-ID migration", () => {
  test("is idempotent and leaves every persisted public resource resolvable", async () => {
    await migrate();
    await migrate();
    expect(await shortIdsFinalized()).toBeTrue();
    const [row] = await sql<{ missing: number; malformed: number; duplicate_groups: number }[]>`
      SELECT
        ((SELECT count(*) FROM venue.venues WHERE short_id IS NULL)
          + (SELECT count(*) FROM venue.opening_rules WHERE short_id IS NULL)
          + (SELECT count(*) FROM venue.date_overrides WHERE short_id IS NULL)
          + (SELECT count(*) FROM venue.shift_templates WHERE short_id IS NULL)
          + (SELECT count(*) FROM venue.shift_assignments WHERE short_id IS NULL)
          + (SELECT count(*) FROM venue.public_sections WHERE short_id IS NULL))::int AS missing,
        ((SELECT count(*) FROM venue.venues WHERE short_id !~ '^[0-9A-Za-z]{6}$')
          + (SELECT count(*) FROM venue.opening_rules WHERE short_id !~ '^[0-9A-Za-z]{6}$')
          + (SELECT count(*) FROM venue.date_overrides WHERE short_id !~ '^[0-9A-Za-z]{6}$')
          + (SELECT count(*) FROM venue.shift_templates WHERE short_id !~ '^[0-9A-Za-z]{6}$')
          + (SELECT count(*) FROM venue.shift_assignments WHERE short_id !~ '^[0-9A-Za-z]{6}$')
          + (SELECT count(*) FROM venue.public_sections WHERE short_id !~ '^[0-9A-Za-z]{6}$'))::int AS malformed,
        ((SELECT count(*) FROM (SELECT short_id FROM venue.venues GROUP BY short_id HAVING count(*) > 1) d)
          + (SELECT count(*) FROM (SELECT short_id FROM venue.opening_rules GROUP BY short_id HAVING count(*) > 1) d)
          + (SELECT count(*) FROM (SELECT short_id FROM venue.date_overrides GROUP BY short_id HAVING count(*) > 1) d)
          + (SELECT count(*) FROM (SELECT short_id FROM venue.shift_templates GROUP BY short_id HAVING count(*) > 1) d)
          + (SELECT count(*) FROM (SELECT short_id FROM venue.shift_assignments GROUP BY short_id HAVING count(*) > 1) d)
          + (SELECT count(*) FROM (SELECT short_id FROM venue.public_sections GROUP BY short_id HAVING count(*) > 1) d))::int AS duplicate_groups
    `;
    expect(row).toEqual({ missing: 0, malformed: 0, duplicate_groups: 0 });
  }, 30_000);
});

testFor("database")(
  "repairs encoded section objects losslessly and preserves unsupported values across startup",
  async () => {
    await migrate();
    const venue = crypto.randomUUID();
    await sql`INSERT INTO venue.venues(id,short_id,slug,name) VALUES (${venue}::uuid,'TestV1',${venue},'migration fixture')`;
    try {
      const encoded = [
        '{"large":9007199254740993,"nested":{"items":[1,2]},"decimal":0.123456789012345678901}',
        "broken",
        "[]",
        "42",
        "null",
        '{"value":"\\u0000"}',
        '{"value":"\\ud800"}',
        '{"value":1e1000000}',
      ];
      for (const [index, content] of encoded.entries()) {
        await sql`INSERT INTO venue.public_sections(short_id,venue_id,kind,title,content)
          VALUES (${`Test${index.toString().padStart(2, "0")}`},${venue}::uuid,'markdown',${String(index)},to_jsonb(${content}::text))`;
      }
      await sql`INSERT INTO venue.public_sections(short_id,venue_id,kind,title,content)
        VALUES ('TestOK',${venue}::uuid,'markdown','native','{"markdown":"preserve"}'::jsonb)`;
      const original =
        await sql`SELECT id,title,content::text AS content,updated_at FROM venue.public_sections WHERE venue_id=${venue}::uuid ORDER BY title`;
      await migrate();
      const first =
        await sql`SELECT id,title,content::text AS content,updated_at FROM venue.public_sections WHERE venue_id=${venue}::uuid ORDER BY title`;
      const { venueService } = await import("./service");
      const sections = await venueService.sections.list(venue);
      expect(sections).toHaveLength(original.length);
      for (const title of ["1", "2", "3", "4"]) {
        expect(sections.find((section) => section.title === title)?.content).toEqual({});
      }
      expect(sections.find((section) => section.title === "native")?.content).toEqual({ markdown: "preserve" });
      expect(first.slice(1)).toEqual(original.slice(1));
      expect(first[0].updated_at).toEqual(original[0].updated_at);
      expect(first[0].id).toBe(original[0].id);
      const [repaired] = await sql`SELECT jsonb_typeof(content) AS kind,content->>'large' AS large,content->>'decimal' AS decimal
        FROM venue.public_sections WHERE venue_id=${venue}::uuid AND title='0'`;
      expect(repaired).toEqual({ kind: "object", large: "9007199254740993", decimal: "0.123456789012345678901" });
      await migrate();
      expect(
        await sql`SELECT id,title,content::text AS content,updated_at FROM venue.public_sections WHERE venue_id=${venue}::uuid ORDER BY title`,
      ).toEqual(first);
    } finally {
      await sql`DELETE FROM venue.venues WHERE id=${venue}::uuid`;
    }
  },
  30_000,
);
