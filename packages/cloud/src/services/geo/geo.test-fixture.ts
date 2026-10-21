import type { GeoContext } from "./service";
import type { GeoConfig } from "./settings";
export const GEO_TEST_NOW = new Date("2026-10-20T10:00:00.000Z");
export const GEO_TEST_KEY = "test-placeholder-key";
export const geoTestConfig: GeoConfig = {
  apiKey: GEO_TEST_KEY,
  timezone: "Europe/Berlin",
  plan: "free",
  customRps: 5,
  customDailyCredits: 3000,
  monthlyCredits: 90000,
  personDailyCredits: 300,
};
export const geoTestContext: GeoContext = {
  actor: {
    kind: "service_account",
    serviceAccount: {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Geo fixture",
      kind: "standalone",
      status: "active",
      delegatedUserId: null,
      appId: null,
      resourceType: null,
      resourceId: null,
      createdBy: null,
      createdAt: "2026-10-20T10:00:00.000Z",
    },
    delegatedUser: null,
    scopes: ["read"],
  },
  accessSubject: { type: "service_account", serviceAccountId: "22222222-2222-4222-8222-222222222222" },
  locale: "de-DE",
  signal: new AbortController().signal,
  requestId: "geo-test-request",
};
/** Fixture-only encoder, precision 6. */
export const encodeGeoTestLine = (points: Array<{ lat: number; lon: number }>) => {
  let lat = 0,
    lon = 0,
    output = "";
  const encode = (value: number) => {
    let n = value < 0 ? -value * 2 - 1 : value * 2;
    while (n >= 32) {
      output += String.fromCharCode((n % 32) + 95);
      n = Math.floor(n / 32);
    }
    output += String.fromCharCode(n + 63);
  };
  for (const point of points) {
    const nextLat = Math.round(point.lat * 1e6),
      nextLon = Math.round(point.lon * 1e6);
    encode(nextLat - lat);
    encode(nextLon - lon);
    lat = nextLat;
    lon = nextLon;
  }
  return output;
};
