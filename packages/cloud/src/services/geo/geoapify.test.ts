import { expect, test } from "bun:test";
import { GeoAutocompleteDataSchema, GeoPlaceSearchDataSchema, GeoReverseDataSchema, GeoAddressSchema } from "../../contracts/geo";
import { CORE_SETTINGS } from "../settings/core-settings";
import autocomplete from "./fixtures/autocomplete.json";
import geocode from "./fixtures/geocode.json";
import reverse from "./fixtures/reverse.json";
import places from "./fixtures/places.json";
import along from "./fixtures/along.json";
import { GeoapifyAdapter, geoNeverSent } from "./geoapify";
import { GEO_TEST_KEY, GEO_TEST_NOW } from "./geo.test-fixture";

const adapter = (fixture: unknown) =>
  new GeoapifyAdapter({
    now: () => GEO_TEST_NOW,
    fetch: async (url, init) => {
      expect(url.origin).toBe("https://api-eu.geoapify.com");
      expect(url.href).not.toContain(GEO_TEST_KEY);
      expect(url.searchParams.get("lang")).toBe("de");
      expect(new Headers(init.headers).get("x-api-key")).toBe(GEO_TEST_KEY);
      expect(new Headers(init.headers).has("cookie")).toBeFalse();
      expect(new Headers(init.headers).has("authorization")).toBeFalse();
      expect(init.credentials).toBe("omit");
      expect(init.redirect).toBe("error");
      return Response.json(fixture);
    },
  });
test("all public OpenAPI fixtures map to the contract with attribution", async () => {
  const a = await adapter(autocomplete).autocomplete({ text: "Orle" }, GEO_TEST_KEY, "de-DE");
  expect(GeoAutocompleteDataSchema.parse(a).suggestions.length).toBeGreaterThan(0);
  const g = await adapter(geocode).geocode({ text: "Lessingstraße 3" }, GEO_TEST_KEY, "de-DE");
  expect(g.candidates.length).toBeGreaterThan(0);
  g.candidates.forEach((value) => GeoAddressSchema.parse(value));
  const r = await adapter(reverse).reverse({ point: { lat: 49, lon: 12 } }, GEO_TEST_KEY, "de-DE");
  expect(GeoReverseDataSchema.parse(r).address.provenance.computedAt).toBe(GEO_TEST_NOW.toISOString());
  for (const fixture of [places, along]) {
    const result = await adapter(fixture).places({ categories: ["museum"], near: { lat: 35.14, lon: -89.93 } }, GEO_TEST_KEY, "de-DE");
    expect(GeoPlaceSearchDataSchema.parse(result).places.some((p) => !!p.openingHours)).toBeTrue();
  }
});
test("origin is immutable and has no setting or environment resolver", async () => {
  const before = process.env.GEOAPIFY_BASE_URL;
  process.env.GEOAPIFY_BASE_URL = "https://example.invalid";
  try {
    await adapter(autocomplete).autocomplete({ text: "Orle" }, GEO_TEST_KEY, "de-DE");
  } finally {
    if (before === undefined) delete process.env.GEOAPIFY_BASE_URL;
    else process.env.GEOAPIFY_BASE_URL = before;
  }
  expect(Object.keys(CORE_SETTINGS).filter((key) => key.startsWith("geo.") && /url|origin|host/.test(key))).toEqual([]);
});
test("along uses documented POST polyline filter, lon/lat order and buffer", async () => {
  const service = new GeoapifyAdapter({
    now: () => GEO_TEST_NOW,
    fetch: async (url, init) => {
      expect(url.pathname).toBe("/v2/places");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toMatchObject({
        lang: "de",
        categories: ["entertainment.museum"],
        filter: {
          type: "polyline",
          buffer: 500,
          geometry: {
            type: "LineString",
            coordinates: [
              [12, 49],
              [13, 50],
            ],
          },
        },
      });
      return Response.json(along);
    },
  });
  await service.places(
    { categories: ["museum"], along: { polyline6: "fixture", fromKm: 0, toKm: 100, bufferMeters: 500 } },
    GEO_TEST_KEY,
    "de",
    undefined,
    [
      { lat: 49, lon: 12 },
      { lat: 50, lon: 13 },
    ],
  );
});
test.each([401, 403, 429, 500, 302])("provider HTTP %i drops its secret-bearing body", async (status) => {
  const service = new GeoapifyAdapter({ now: () => GEO_TEST_NOW, fetch: async () => new Response(GEO_TEST_KEY, { status }) });
  try {
    await service.autocomplete({ text: "Orle" }, GEO_TEST_KEY, "en");
    throw new Error("Expected failure");
  } catch (error) {
    expect(error).toMatchObject({ code: status === 429 ? "GEO_BUSY" : "GEO_PROVIDER_FAILED", charge: "known" });
    expect(JSON.stringify(error)).not.toContain(GEO_TEST_KEY);
    if ([401, 403].includes(status)) expect(error).toMatchObject({ details: { adminHint: expect.any(String) } });
  }
});
test.each(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ERR_TLS_CERT_ALTNAME_INVALID"])(
  "only proven pre-send %s gets one retry",
  async (code) => {
    let calls = 0;
    const service = new GeoapifyAdapter({
      now: () => GEO_TEST_NOW,
      fetch: async () => {
        if (++calls === 1) throw Object.assign(new Error(GEO_TEST_KEY), { code });
        return Response.json(autocomplete);
      },
    });
    await service.autocomplete({ text: "Orle" }, GEO_TEST_KEY, "en");
    expect(calls).toBe(2);
  },
);
test.each(["ECONNRESET", "ETIMEDOUT", "AbortError"])("%s is not safe to retry", async (code) => {
  let calls = 0;
  const service = new GeoapifyAdapter({
    now: () => GEO_TEST_NOW,
    fetch: async () => {
      calls++;
      throw Object.assign(new Error(GEO_TEST_KEY), { code });
    },
  });
  await expect(service.autocomplete({ text: "Orle" }, GEO_TEST_KEY, "en")).rejects.toMatchObject({ charge: "unknown" });
  expect(calls).toBe(1);
  expect(geoNeverSent({ code })).toBeFalse();
});
test("caller cancellation reaches fetch and abort after send is unknown", async () => {
  const controller = new AbortController();
  let calls = 0;
  const service = new GeoapifyAdapter({
    now: () => GEO_TEST_NOW,
    fetch: async (_url, init) => {
      calls++;
      controller.abort(new Error(GEO_TEST_KEY));
      expect(init.signal?.aborted).toBeTrue();
      throw init.signal?.reason;
    },
  });
  await expect(service.autocomplete({ text: "Orle" }, GEO_TEST_KEY, "en", controller.signal)).rejects.toMatchObject({ charge: "unknown" });
  expect(calls).toBe(1);
});
test("malformed, oversized and secret-bearing success bodies are rejected", async () => {
  for (const fixture of [{}, { type: "FeatureCollection", features: [], secret: GEO_TEST_KEY }, { padding: "x".repeat(256 * 1024) }]) {
    await expect(adapter(fixture).autocomplete({ text: "Orle" }, GEO_TEST_KEY, "de")).rejects.toMatchObject({
      code: "GEO_PROVIDER_FAILED",
    });
  }
});
test("a key containing JSON escapes cannot leak through successful provider fields", async () => {
  const key = 'test-"quoted-key';
  const service = new GeoapifyAdapter({ now: () => GEO_TEST_NOW, fetch: async () => Response.json({ ...autocomplete, secret: key }) });
  await expect(service.autocomplete({ text: "Orle" }, key, "en")).rejects.toMatchObject({ code: "GEO_PROVIDER_FAILED" });
});
