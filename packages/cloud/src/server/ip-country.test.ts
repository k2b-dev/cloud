import { afterEach, beforeEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { DBIP_ATTRIBUTION, ipCountry } from "@k2b/cloud/server";
import { Hono } from "hono";
import { APP_KEY_FIXTURES } from "../../../../scripts/fixtures/app-key-fixtures";
import { bindProcessApplicationId, clearProcessApplicationId } from "../_internal/process-identity";
import { createIpCountryRoutes } from "../api/ip-country";
import { type AppKey, formatAppKey } from "../app-key";
import { env } from "../config/env";
import { signAppProof } from "../runtime/bootstrap-protocol";
import * as bootstrap from "../services/app-bootstrap";
import * as keys from "../services/app-keys";
import * as logging from "../services/logging";
import * as limits from "./ratelimit";
import * as geoip from "./request-context/geoip";
import { mmdbFixture } from "./request-context/geoip.test-fixture";

const NOW = Date.UTC(2030, 0, 2, 3, 4, 5);
const key: AppKey = {
  appId: "atlas",
  installationId: "11111111-1111-4111-8111-111111111111",
  keyId: "22222222-2222-4222-8222-222222222222",
  seed: APP_KEY_FIXTURES[0].seed,
};
const keyDescriptor = Object.getOwnPropertyDescriptor(env, "CLOUD_APP_KEY")!;
const originDescriptor = Object.getOwnPropertyDescriptor(env, "CLOUD_CORE_INTERNAL_ORIGIN")!;
const endpoint = "http://core.test/api/_internal/ip-country";
const unavailable = { country: null, available: false, attribution: null };
const warn = mock(() => {});
let reader: geoip.GeoIp;
let app: ReturnType<typeof routes>;
const routes = () => new Hono().route("/api/_internal/ip-country", createIpCountryRoutes());
const database = (options: Parameters<typeof mmdbFixture>[1] = {}, source: "bundled" | "uploaded" = "bundled") => {
  const result = geoip.openGeoIpDatabase("city", mmdbFixture("city", options), source);
  if (!result) throw new Error("Invalid fixture");
  return result;
};

beforeEach(() => {
  setSystemTime(NOW);
  warn.mockClear();
  spyOn(logging, "logger").mockReturnValue({ warn, info: () => {}, debug: () => {}, error: () => {} });
  Object.defineProperty(env, "CLOUD_APP_KEY", { value: formatAppKey(key), configurable: true });
  Object.defineProperty(env, "CLOUD_CORE_INTERNAL_ORIGIN", { value: "http://core.test", configurable: true });
  bindProcessApplicationId(key.appId);
  reader = geoip.createGeoIp({ cityPath: "/missing-country-test/city.mmdb", asnPath: "/missing-country-test/asn.mmdb" });
  reader.install("city", database());
  spyOn(geoip, "getGeoIp").mockReturnValue(reader);
  spyOn(keys, "getActiveAppKey").mockResolvedValue({
    keyId: key.keyId,
    appId: key.appId,
    serviceAccountId: "33333333-3333-4333-8333-333333333333",
    kind: "app_key",
    name: "Atlas fixture",
    publicKey: APP_KEY_FIXTURES[0].publicKey,
    grants: [],
    fingerprint: "fixture",
    status: "active",
    accountStatus: "active",
    usable: true,
    createdAt: new Date(NOW).toISOString(),
    createdBy: null,
    expiresAt: null,
    revokedAt: null,
    revokedBy: null,
    lastUsedAt: null,
    connectionsAllowed: true,
    oauthIssueAllowed: false,
  });
  spyOn(keys, "getInstallationId").mockResolvedValue(key.installationId);
  spyOn(keys, "touchAppKey").mockResolvedValue();
  spyOn(bootstrap, "consumeBootstrapProof").mockResolvedValue(true);
  spyOn(bootstrap, "bootstrapRateLimit").mockResolvedValue(100);
  spyOn(limits, "ratelimit").mockImplementation(({ id }) => ({
    id,
    check: async () => ({ limited: false, remaining: 99, resetIn: 1000 }),
    checkOrThrow: async () => ({ limited: false, remaining: 99, resetIn: 1000 }),
  }));
  app = routes();
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL) => {
        if (!(input instanceof Request)) throw new Error("Expected signed Request");
        expect(input.method).toBe("POST");
        expect(input.url).toBe(endpoint);
        expect(input.redirect).toBe("error");
        return app.fetch(input);
      },
      { preconnect: fetch.preconnect },
    ),
  );
});
afterEach(() => {
  mock.restore();
  Object.defineProperty(env, "CLOUD_APP_KEY", keyDescriptor);
  Object.defineProperty(env, "CLOUD_CORE_INTERNAL_ORIGIN", originDescriptor);
  clearProcessApplicationId();
  setSystemTime();
});

const signed = async (body: string) =>
  new Request(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await signAppProof(key, {
        method: "POST",
        path: new URL(endpoint).pathname,
        body: new TextEncoder().encode(body),
      })}`,
    },
    body,
  });

describe("ipCountry public server contract", () => {
  test("signed IPv4 and IPv6 lookups return only a country and database metadata", async () => {
    expect(await ipCountry("8.8.8.8")).toEqual({ country: "AT", available: true, attribution: DBIP_ATTRIBUTION });
    expect(await ipCountry("2a01:4f8::1")).toEqual({ country: "CH", available: true, attribution: DBIP_ATTRIBUTION });
    expect(warn).not.toHaveBeenCalled(); // No missing ASN snapshot is opened.
  });

  test("misses, private and invalid addresses preserve availability", async () => {
    for (const input of [
      "9.9.9.9",
      "1.1.1.1",
      "127.0.0.1",
      "10.1.2.3",
      "::1",
      "fc00::1",
      "::ffff:10.1.2.3",
      "not-an-ip",
      "8.8.8.8:80",
      "8".repeat(46),
      " 8.8.8.8",
    ]) {
      expect(await ipCountry(input)).toEqual({ country: null, available: true, attribution: DBIP_ATTRIBUTION });
    }
    expect(warn).not.toHaveBeenCalled();
  });

  test("missing database reports unavailable", async () => {
    reader.install("city", null);
    expect(await ipCountry("8.8.8.8")).toEqual(unavailable);
  });

  test("uploaded non-DB-IP data has no attribution; DB-IP descriptions retain it", async () => {
    reader.install("city", database({ databaseType: "GeoLite2-City", description: "Example dataset" }, "uploaded"));
    expect(await ipCountry("8.8.8.8")).toEqual({ country: "AT", available: true, attribution: null });
    reader.install("city", database({ databaseType: "Custom-City", description: "Uses DB-IP data" }, "uploaded"));
    expect((await ipCountry("8.8.8.8")).attribution).toEqual(DBIP_ATTRIBUTION);
  });

  test("country lookups never inspect city names, network names or ASN records", async () => {
    const city = database();
    spyOn(city, "get").mockReturnValue({
      country: { iso_code: "at" },
      city: {
        get names() {
          throw new Error("City names must not be inspected");
        },
      },
    });
    reader.install("city", city);
    const asn = geoip.openGeoIpDatabase("asn", mmdbFixture("asn"))!;
    const asnRead = spyOn(asn, "get");
    reader.install("asn", asn);
    expect((await ipCountry("8.8.8.8")).country).toBe("AT");
    expect(asnRead).not.toHaveBeenCalled();
  });

  test("failed decoding logs once without the address or decoder error", async () => {
    const city = database();
    spyOn(city, "get").mockImplementation((ip) => {
      throw new Error(`Decoder failed for ${ip}`);
    });
    reader.install("city", city);
    for (let i = 0; i < 2; i++)
      expect(await ipCountry("8.8.8.8")).toEqual({ country: null, available: true, attribution: DBIP_ATTRIBUTION });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("8.8.8.8");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Decoder");
  });

  test("bounded decoding rejects a malformed MMDB record", async () => {
    reader.install("city", database({ corruptData: true }));
    expect((await ipCountry("8.8.8.8")).country).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("transport errors resolve unavailable and log once without error details", async () => {
    spyOn(globalThis, "fetch").mockRejectedValue(new Error("Upstream failed for 8.8.8.8"));
    expect(await ipCountry("8.8.8.8")).toEqual(unavailable);
    expect(await ipCountry("8.8.8.8")).toEqual(unavailable);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("8.8.8.8");
  });

  test("the two-second deadline cancels stalled transport without failing the caller", async () => {
    let aborted = false;
    spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        (input: RequestInfo | URL) =>
          new Promise<Response>((_, reject) => {
            if (!(input instanceof Request)) throw new Error("Expected Request");
            input.signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(input.signal.reason);
              },
              { once: true },
            );
          }),
        { preconnect: fetch.preconnect },
      ),
    );
    expect(await ipCountry("8.8.8.8")).toEqual(unavailable);
    expect(aborted).toBe(true);
  });

  test("missing keys, malformed and oversized responses resolve unavailable", async () => {
    Object.defineProperty(env, "CLOUD_APP_KEY", { value: undefined, configurable: true });
    expect(await ipCountry("8.8.8.8")).toEqual(unavailable);
    expect(fetch).not.toHaveBeenCalled();
    Object.defineProperty(env, "CLOUD_APP_KEY", { value: formatAppKey(key), configurable: true });
    for (const response of [new Response("x".repeat(513)), Response.json({ country: 12 }), new Response(null, { status: 503 })]) {
      spyOn(globalThis, "fetch").mockResolvedValue(response);
      expect(await ipCountry("8.8.8.8")).toEqual(unavailable);
    }
  });
});

describe("Core country route authorization", () => {
  test("anonymous, session, API key and legacy bearer callers cannot reach the lookup", async () => {
    const lookup = spyOn(reader, "country");
    const credentials: HeadersInit[] = [
      {},
      { Cookie: "session_token=person" },
      { Authorization: "Bearer api-key" },
      { Authorization: "Bearer legacy-workload" },
      { Authorization: "Bearer invalid.proof" },
    ];
    for (const headers of credentials) {
      const response = await app.request(endpoint, { method: "POST", headers, body: '{"ip":"8.8.8.8"}' });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain("8.8.8.8");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  test("country admission has separate counters and returns unavailable on rate limiting", async () => {
    const rate = spyOn(limits, "ratelimit");
    expect((await ipCountry("8.8.8.8")).country).toBe("AT");
    expect(rate).toHaveBeenCalledWith({ id: "ip-country-ingress", limit: 100 });
    expect(rate).toHaveBeenCalledWith({ id: "ip-country-key", limit: 100 });
    expect(rate).toHaveBeenCalledTimes(2);
    rate.mockImplementation(({ id }) => ({
      id,
      check: async () => ({ limited: true, remaining: 0, resetIn: 1000 }),
      checkOrThrow: async () => ({ limited: true, remaining: 0, resetIn: 1000 }),
    }));
    expect(await ipCountry("8.8.8.8")).toEqual(unavailable);
    const response = await app.fetch(await signed('{"ip":"8.8.8.8"}'));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("1");
  });

  test("a revoked key or modified signed body cannot reach the lookup", async () => {
    const lookup = spyOn(reader, "country");
    const request = await signed('{"ip":"8.8.8.8"}');
    const tampered = new Request(request, { body: '{"ip":"9.9.9.9"}' });
    expect((await app.fetch(tampered)).status).toBe(401);
    spyOn(keys, "getActiveAppKey").mockResolvedValue(null);
    expect((await app.fetch(await signed('{"ip":"8.8.8.8"}'))).status).toBe(401);
    expect(lookup).not.toHaveBeenCalled();
  });

  test("malformed or oversized bodies never echo the input", async () => {
    for (const [body, status] of [
      ["8.8.8.8", 400],
      ['{"ip":123}', 400],
      [JSON.stringify({ ip: "8".repeat(46) }), 413],
    ] as const) {
      const response = await app.fetch(await signed(body));
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain(body);
    }
  });
});

test("a country lookup follows changed uploads of both databases, so sign-ins never keep a stale one", async () => {
  let now = NOW;
  let version = "first";
  const read = mock<geoip.GeoIpUploads["read"]>(async (kind) =>
    kind === "city" ? mmdbFixture("city", { databaseType: "GeoLite2-City", description: "Example dataset" }) : mmdbFixture("asn"),
  );
  const geo = geoip.createGeoIp({
    paths: { cityPath: "/missing-country-test/city.mmdb", asnPath: "/missing-country-test/asn.mmdb" },
    now: () => now,
    uploads: { versions: async () => ({ city: version, asn: version }), read },
  });
  geo.install("city", database());
  expect(geo.country("8.8.8.8").attribution).toEqual(DBIP_ATTRIBUTION);
  await geo.refresh(); // joins the country lookup's in-flight refresh
  expect(read.mock.calls).toEqual([
    ["city", "first"],
    ["asn", "first"],
  ]);
  expect(geo.country("8.8.8.8").attribution).toBeNull();
  now += 60_000;
  version = "second";
  geo.country("8.8.8.8");
  await geo.refresh();
  expect(read.mock.calls.slice(2)).toEqual([
    ["city", "second"],
    ["asn", "second"],
  ]);
});
