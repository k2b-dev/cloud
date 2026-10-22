import { expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { geoProvenance } from "../geo/geoapify";
import { weatherLocationsService } from "./locations";

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
      expect((await weatherLocationsService.get({ userId: id, id: saved.data.id }))?.provenance).toEqual(provenance);
      expect((await weatherLocationsService.list({ userId: id })).items[0]?.provenance).toEqual(provenance);
      expect(await weatherLocationsService.get({ userId: "00000000-0000-4000-8000-000000000001", id: saved.data.id })).toBeNull();
      const manual = await weatherLocationsService.create({ userId: id, data: { name: "My coordinates", lat: 48, lon: 10 } });
      expect(manual).toMatchObject({ ok: true, data: { provenance: null } });
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${id}`;
    }
  });
});
