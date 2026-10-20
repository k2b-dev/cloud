import { afterEach, expect, test } from "bun:test";
import { GeoapifyAdapter } from "../services/geo/geoapify";
import { GEO_TEST_KEY, GEO_TEST_NOW } from "../services/geo/geo.test-fixture";
import geocode from "../services/geo/fixtures/geocode.json";
import autocomplete from "../services/geo/fixtures/autocomplete.json";
import { geoClient } from "./geo-client";
const original = process.env.CLOUD_CORE_INTERNAL_ORIGIN;
afterEach(() => {
  if (original === undefined) delete process.env.CLOUD_CORE_INTERNAL_ORIGIN;
  else process.env.CLOUD_CORE_INTERNAL_ORIGIN = original;
});
test("geoClient preserves caller identity and locale, parses the Core response", async () => {
  process.env.CLOUD_CORE_INTERNAL_ORIGIN = "https://core.example.test";
  const fixture = await new GeoapifyAdapter({ now: () => GEO_TEST_NOW, fetch: async () => Response.json(autocomplete) }).autocomplete(
    { text: "Orle" },
    GEO_TEST_KEY,
    "en",
  );
  const requests: Request[] = [];
  const result = await geoClient.autocomplete(
    { text: "Orle" },
    {
      authorization: "Bearer caller",
      locale: "de-CH",
      requestId: "geo-caller",
      transport: async (request) => {
        requests.push(request);
        return Response.json({ data: fixture });
      },
    },
  );
  expect(result).toMatchObject({ ok: true, data: { data: fixture } });
  expect(requests[0]!.url).toBe("https://core.example.test/api/capabilities/v1/queries/core/address.autocomplete");
  expect(requests[0]!.headers.get("authorization")).toBe("Bearer caller");
  expect(requests[0]!.headers.get("x-cloud-locale")).toBe("de-CH");
  expect(await requests[0]!.json()).toEqual({ input: { text: "Orle" } });
});
test("background geoClient uses the mandate broker and caller workload credential", async () => {
  process.env.CLOUD_CORE_INTERNAL_ORIGIN = "https://core.example.test";
  const result = await geoClient.availability({
    authorization: "Bearer workload",
    locale: "de",
    mandate: { id: "mandate", revision: 2, callingAppId: "test-app" },
    transport: async (request) => {
      expect(new URL(request.url).pathname).toBe("/api/_internal/identity/v1/invoke");
      expect(await request.json()).toMatchObject({
        kind: "query",
        targetApp: "core",
        capabilityId: "geo.availability",
        mandateId: "mandate",
        mandateRevision: 2,
        metadata: { locale: "de" },
      });
      return Response.json({
        data: {
          configured: true,
          person: { exhausted: false, resetsAt: "2026-10-20T22:00:00.000Z" },
          cloud: { exhausted: false, resetsAt: "2026-10-31T23:00:00.000Z" },
        },
      });
    },
  });
  expect(result.ok).toBeTrue();
});
test("malformed responses fail at the shared capability boundary", async () => {
  process.env.CLOUD_CORE_INTERNAL_ORIGIN = "https://core.example.test";
  expect(
    await geoClient.reverse({ point: { lat: 49, lon: 12 } }, { transport: async () => Response.json({ data: { address: {} } }) }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_APP_RESPONSE" } });
});

test("geoClient geocode derives the address contract without a candidate limit", async () => {
  process.env.CLOUD_CORE_INTERNAL_ORIGIN = "https://core.example.test";
  const input: Parameters<typeof geoClient.geocode>[0] = { fields: { city: "Ulm" }, countryCode: "DE" };
  const fixture = await new GeoapifyAdapter({ now: () => GEO_TEST_NOW, fetch: async () => Response.json(geocode) }).geocode(
    input,
    GEO_TEST_KEY,
    "en",
  );
  const data = { address: fixture.candidates[0]!, provenance: fixture.provenance };
  const result = await geoClient.geocode(input, {
    transport: async (request) => {
      expect(new URL(request.url).pathname).toBe("/api/capabilities/v1/queries/core/address.geocode");
      expect(await request.json()).toEqual({ input });
      return Response.json({ data });
    },
  });
  expect(result).toMatchObject({ ok: true, data: { data } });
});
