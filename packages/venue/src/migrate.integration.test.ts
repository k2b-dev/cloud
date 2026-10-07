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

testFor("database")(
  "keeps paused shift templates paused and deleted ones deleted across startups",
  async () => {
    await migrate();
    const venue = crypto.randomUUID();
    await sql`INSERT INTO venue.venues(id,short_id,slug,name) VALUES (${venue}::uuid,'TestV2',${venue},'pause fixture')`;
    try {
      await sql`INSERT INTO venue.shift_templates(short_id,venue_id,weekday,title,start_time,end_time,active,deleted_at) VALUES
        ('TestP1',${venue}::uuid,1,'paused','09:00','12:00',false,NULL),
        ('TestD1',${venue}::uuid,1,'deleted','09:00','12:00',false,now())`;
      await migrate();
      await migrate();
      const { venueService } = await import("./service");
      expect((await venueService.templates.list(venue)).map((template) => [template.title, template.active])).toEqual([["paused", false]]);
    } finally {
      await sql`DELETE FROM venue.venues WHERE id=${venue}::uuid`;
    }
  },
  30_000,
);

testFor("database")(
  "drops the unused venue-wide calendar token again after the documented rollback and keeps the venues",
  async () => {
    await migrate();
    // The rollback step from the deprecation note, then the index an older image's startup adds on top.
    await sql`ALTER TABLE venue.venues ADD COLUMN IF NOT EXISTS ical_token TEXT UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex')`.simple();
    await sql`CREATE INDEX IF NOT EXISTS idx_venue_venues_ical_token ON venue.venues(ical_token)`.simple();
    const venue = crypto.randomUUID();
    await sql`INSERT INTO venue.venues(id,short_id,slug,name) VALUES (${venue}::uuid,'TestV3',${venue},'calendar fixture')`;
    try {
      const leftovers = () => sql<{ name: string }[]>`
        SELECT column_name::text AS name FROM information_schema.columns
        WHERE table_schema = 'venue' AND table_name = 'venues' AND column_name = 'ical_token'
        UNION ALL
        SELECT indexname::text FROM pg_indexes WHERE schemaname = 'venue' AND indexname = 'idx_venue_venues_ical_token'
      `;
      expect((await leftovers()).length).toBe(2);
      await migrate();
      await migrate();
      expect(await leftovers()).toEqual([]);
      const { venueService } = await import("./service");
      const kept = await venueService.venues.get(venue);
      expect(kept).toMatchObject({ slug: venue, name: "calendar fixture" });
      expect(kept).not.toHaveProperty("icalToken");
    } finally {
      await sql`DELETE FROM venue.venues WHERE id=${venue}::uuid`;
    }
  },
  30_000,
);

testFor("database")(
  "adds one-off dates idempotently, keeps weekly dates null, and enforces matching weekdays",
  async () => {
    await migrate();
    await migrate();
    const venue = crypto.randomUUID();
    await sql`INSERT INTO venue.venues(id,short_id,slug,name) VALUES (${venue}::uuid,'TestV4',${venue},'one-off migration fixture')`;
    try {
      const [column] = await sql<{ data_type: string; is_nullable: string }[]>`
        SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'venue' AND table_name = 'shift_templates' AND column_name = 'date'
      `;
      expect(column).toEqual({ data_type: "date", is_nullable: "YES" });
      const [constraint] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM pg_constraint
        WHERE conrelid = 'venue.shift_templates'::regclass AND conname = 'shift_templates_date_weekday_check'
      `;
      expect(constraint?.count).toBe(1);
      const [index] = await sql<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes WHERE schemaname = 'venue' AND indexname = 'idx_venue_shift_templates_venue_date'
      `;
      expect(index?.indexdef).toContain("(venue_id, date) WHERE (date IS NOT NULL)");
      await sql`INSERT INTO venue.shift_templates(short_id,venue_id,weekday,title,start_time,end_time) VALUES
        ('TestW4',${venue}::uuid,3,'weekly','09:00','12:00')`;
      await sql`INSERT INTO venue.shift_templates(short_id,venue_id,weekday,date,title,start_time,end_time) VALUES
        ('TestO4',${venue}::uuid,3,'2026-10-07','one-off','09:00','12:00')`;
      await expect(
        Promise.resolve(sql`INSERT INTO venue.shift_templates(short_id,venue_id,weekday,date,title,start_time,end_time) VALUES
        ('TestX4',${venue}::uuid,4,'2026-10-07','mismatch','09:00','12:00')`),
      ).rejects.toMatchObject({ errno: "23514" });
      await expect(
        Promise.resolve(sql`UPDATE venue.shift_templates SET weekday = 4 WHERE venue_id = ${venue}::uuid AND date IS NOT NULL`),
      ).rejects.toMatchObject({ errno: "23514" });
      await migrate();
      const rows = await sql<{ title: string; date: string | null }[]>`
        SELECT title, date::text FROM venue.shift_templates WHERE venue_id = ${venue}::uuid ORDER BY title
      `;
      expect(rows).toEqual([
        { title: "one-off", date: "2026-10-07" },
        { title: "weekly", date: null },
      ]);
    } finally {
      await sql`DELETE FROM venue.venues WHERE id = ${venue}::uuid`;
    }
  },
  30_000,
);
