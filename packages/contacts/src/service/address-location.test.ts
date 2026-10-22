import { describe, expect, test } from "bun:test";
import type { GeoAddress } from "@k2b/cloud/contracts/geo";
import { addressGeoColumns, addressGeoHash, addressLocation, geocodeOutcome, safeAddressMatch } from "./address-location";

const provenance = {
  provider: "geoapify" as const,
  attribution: { text: "Geoapify · OpenStreetMap" as const, links: ["https://geoapify.com", "https://www.openstreetmap.org/copyright"] },
  computedAt: "2026-10-22T10:00:00.000Z",
};
const candidate = (buildingConfidence: number | null, lon = 9.99): GeoAddress => ({
  line1: "Frauenstraße 28",
  postalCode: "89073",
  city: "Ulm",
  stateRegion: "Baden-Württemberg",
  countryCode: "DE",
  point: { lat: 48.4, lon },
  formatted: "Frauenstraße 28, 89073 Ulm, Germany",
  confidence: 1,
  buildingConfidence,
  provenance,
});
const address = { line1: "Frauenstraße 28", postalCode: "89073", city: "Ulm", stateRegion: null, countryCode: "DE" };
const checkedAt = new Date("2026-10-22T10:00:00.000Z");

describe("contact address location", () => {
  test("the hash follows the location fields only and ignores case and spacing", () => {
    expect(addressGeoHash({ ...address, line1: "  frauenstraße   28 ", countryCode: "de" })).toBe(addressGeoHash(address));
    expect(addressGeoHash({ ...address, stateRegion: "" })).toBe(addressGeoHash(address));
    expect(addressGeoHash({ ...address, line1: "Frauenstraße 30" })).not.toBe(addressGeoHash(address));
    expect(addressGeoHash({ ...address, postalCode: "89079" })).not.toBe(addressGeoHash(address));
  });

  test("a stored answer counts only for the address text it was found for", () => {
    const row = { geo_hash: addressGeoHash(address), geo_lat: 48.4, geo_lon: 9.99, geo_provenance: provenance, geo_checked_at: checkedAt };
    expect(addressLocation(address, row)).toEqual({ status: "found", point: { lat: 48.4, lon: 9.99 }, provenance });
    expect(addressLocation(address, { ...row, geo_provenance: JSON.stringify(provenance) })).toMatchObject({ status: "found" });
    expect(addressLocation({ ...address, line1: "Frauenstraße 30" }, row)).toBeNull();
    expect(addressLocation(address, { ...row, geo_lat: null, geo_lon: null, geo_provenance: null })).toEqual({
      status: "not_found",
      checkedAt: checkedAt.toISOString(),
    });
    expect(
      addressLocation(address, { geo_hash: null, geo_lat: null, geo_lon: null, geo_provenance: null, geo_checked_at: null }),
    ).toBeNull();
  });

  test("a chosen suggestion is stored; an unchanged address keeps its answer; a changed one waits", () => {
    const previous = new Map([
      [
        addressGeoHash(address),
        { geo_hash: addressGeoHash(address), geo_lat: 1, geo_lon: 2, geo_provenance: provenance, geo_checked_at: checkedAt },
      ],
    ]);
    expect(addressGeoColumns({ ...address, line1: "frauenstraße 28" }, previous)).toMatchObject({ geo_lat: 1, geo_lon: 2 });
    expect(addressGeoColumns({ ...address, line1: "Frauenstraße 30" }, previous)).toBeNull();
    expect(
      addressGeoColumns({ ...address, line1: "Frauenstraße 30", location: { point: { lat: 3, lon: 4 }, provenance } }, previous),
    ).toEqual({
      geo_hash: addressGeoHash({ ...address, line1: "Frauenstraße 30" }),
      geo_lat: 3,
      geo_lon: 4,
      geo_provenance: provenance,
      geo_checked_at: checkedAt,
    });
  });

  test("only one sure house-number match becomes a point", () => {
    expect(safeAddressMatch([candidate(0.95)])?.point).toEqual({ lat: 48.4, lon: 9.99 });
    expect(safeAddressMatch([candidate(0.89)])).toBeNull();
    expect(safeAddressMatch([candidate(null)])).toBeNull();
    expect(safeAddressMatch([candidate(0.95), candidate(0.4, 10)])?.point.lon).toBe(9.99);
    expect(safeAddressMatch([candidate(0.95), candidate(0.92, 10)])).toBeNull();
    expect(safeAddressMatch([])).toBeNull();
  });

  test("Core's answers reduce to what Contacts stores or shows", () => {
    expect(geocodeOutcome({ ok: true, data: { data: { address: candidate(1) } } })).toEqual({
      kind: "candidates",
      candidates: [candidate(1)],
    });
    expect(
      geocodeOutcome({ ok: false, error: { code: "GEO_ADDRESS_AMBIGUOUS", details: { candidates: [candidate(1), candidate(0.2)] } } }),
    ).toEqual({ kind: "candidates", candidates: [candidate(1), candidate(0.2)] });
    expect(geocodeOutcome({ ok: false, error: { code: "GEO_ADDRESS_NOT_FOUND" } })).toEqual({ kind: "not_found" });
    expect(geocodeOutcome({ ok: false, error: { code: "GEO_NOT_CONFIGURED" } })).toEqual({ kind: "not_configured" });
    expect(
      geocodeOutcome({
        ok: false,
        error: { code: "GEO_BUDGET_EXHAUSTED", details: { scope: "person", resetsAt: "2026-10-22T22:00:00.000Z" } },
      }),
    ).toEqual({ kind: "budget_exhausted", scope: "person", resetsAt: "2026-10-22T22:00:00.000Z" });
    for (const code of ["GEO_BUSY", "GEO_PROVIDER_FAILED", "GEO_FORBIDDEN", "APP_UNAVAILABLE"])
      expect(geocodeOutcome({ ok: false, error: { code } })).toEqual({ kind: "failed" });
  });
});
