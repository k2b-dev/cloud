import { expect, test } from "bun:test";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { sql } from "../../runtime/clients";
import { geoProvenance } from "../geo/geoapify";
import { WEATHER_SAVED_PLACES_MAX, weatherLocationsService } from "./locations";

const suite = databaseSuite();
suite("Weather saved geo provenance", () => {
  test("retains source through create, list and reload without exposing another user's location", async () => {
    const id = crypto.randomUUID();
    await sql`INSERT INTO auth.users (id, uid, provider, profile) VALUES (${id}, ${`weather-geo-${id}`}, 'local', 'user')`;
    try {
      const provenance = geoProvenance(new Date("2026-10-20T12:00:00Z"));
      const saved = await weatherLocationsService.create({ userId: id, data: { name: "Ulm", lat: 48.4, lon: 10, provenance } });
      expect(saved.ok).toBe(true);
      if (!saved.ok) throw new Error(saved.error.code);
      expect(saved.data.provenance).toEqual(provenance);
      const [stored] = await sql`SELECT jsonb_typeof(provenance) AS kind FROM weather_locations WHERE user_id = ${id}`;
      expect(stored.kind).toBe("object");
      expect((await weatherLocationsService.get({ userId: id, id: saved.data.id }))?.provenance).toEqual(provenance);
      expect((await weatherLocationsService.list({ userId: id })).items[0]?.provenance).toEqual(provenance);
      expect(await weatherLocationsService.get({ userId: "00000000-0000-4000-8000-000000000001", id: saved.data.id })).toBeNull();
      const manual = await weatherLocationsService.create({ userId: id, data: { name: "My coordinates", lat: 48, lon: 10 } });
      expect(manual).toMatchObject({ ok: true, data: { provenance: null } });
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${id}`;
    }
  });

  test("one person saves at most WEATHER_SAVED_PLACES_MAX places, and a list without a page reads no more (#4368)", async () => {
    const id = crypto.randomUUID();
    await sql`INSERT INTO auth.users (id, uid, provider, profile) VALUES (${id}, ${`weather-max-${id}`}, 'local', 'user')`;
    try {
      for (let index = 0; index < WEATHER_SAVED_PLACES_MAX; index++) {
        const saved = await weatherLocationsService.create({ userId: id, data: { name: `Ort ${index}`, lat: 48, lon: 10 } });
        expect(saved.ok).toBe(true);
      }
      // one more is refused with the reason, and nothing is stored
      const extra = await weatherLocationsService.create({ userId: id, data: { name: "Ort zu viel", lat: 48, lon: 10 } });
      expect(extra).toMatchObject({ ok: false, error: { code: "CONFLICT", status: 409 } });
      const [stored] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM weather_locations WHERE user_id = ${id}`;
      expect(stored?.count).toBe(WEATHER_SAVED_PLACES_MAX);
      // a place saved before the limit (an older account with more) stays readable page by page, never all at once
      await sql`INSERT INTO weather_locations (short_id, user_id, name, lat, lon) VALUES ('zz9999', ${id}, 'Ort von früher', 48, 10)`;
      const page = await weatherLocationsService.list({ userId: id });
      expect(page.items).toHaveLength(WEATHER_SAVED_PLACES_MAX);
      expect(page).toMatchObject({ total: WEATHER_SAVED_PLACES_MAX + 1, hasNext: true });
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${id}`;
    }
  }, 60_000);
});
