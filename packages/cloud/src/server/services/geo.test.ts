import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as transport from "../../services/allowed-network-fetch";
import * as logging from "../../services/logging";
import { geoService } from "./geo";

afterEach(() => mock.restore());
const mockFetch = (response: Response) => {
  const fetch = mock(async () => response);
  spyOn(transport, "createAllowedNetworkFetch").mockReturnValue(fetch);
  return fetch;
};

describe("geo service", () => {
  test("validates upstream places before bounded local pagination", async () => {
    const fetchMock = mockFetch(
      new Response(
        JSON.stringify({
          places: [
            {
              name: "Ulm",
              latitude: 48.4,
              longitude: 9.99,
              country_code: "DE",
              admin1_code: "Baden-Württemberg",
              feature_class: "P",
            },
            { name: "Invalid coordinates", latitude: 900, longitude: 9.99, country_code: "DE", feature_class: "P" },
            { name: "Not a city", latitude: 48.5, longitude: 10, country_code: "DE", feature_class: "A" },
          ],
        }),
      ),
    );

    const result = await geoService.place.list({
      baseUrl: "https://geo.example.test/",
      pagination: { page: 1, perPage: 1 },
      filter: { query: "Ulm", country: "DE", featureClass: "P" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: true,
      data: {
        items: [
          {
            name: "Ulm",
            lat: 48.4,
            lon: 9.99,
            country: "DE",
            state: "Baden-Württemberg",
            featureClass: "P",
            featureCode: undefined,
          },
        ],
        page: 1,
        perPage: 1,
        total: 1,
        hasNext: false,
      },
    });
  });

  test("fails oversized and malformed upstream responses without leaking details", async () => {
    mockFetch(new Response("not-json", { headers: { "content-length": String(256 * 1024 + 1) } }));

    const result = await geoService.place.list({
      baseUrl: "https://geo.example.test",
      filter: { query: "Ulm" },
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "GEO_UNAVAILABLE", message: "Geo service is unavailable", status: 500 },
    });
  });

  test("combines caller cancellation with the fixed request timeout", async () => {
    const controller = new AbortController();
    let outboundSignal: AbortSignal | undefined;
    const fetchMock = Object.assign(
      async (...[_input, init]: Parameters<typeof fetch>) => {
        outboundSignal = init?.signal ?? undefined;
        return new Response(JSON.stringify({ places: [] }));
      },
      { preconnect: globalThis.fetch.preconnect },
    ) satisfies typeof fetch;
    spyOn(transport, "createAllowedNetworkFetch").mockReturnValue(fetchMock);

    const result = await geoService.place.list({
      baseUrl: "https://geo.example.test",
      signal: controller.signal,
      filter: { query: "Ulm" },
    });
    controller.abort();

    expect(result.ok).toBeTrue();
    expect(outboundSignal).toBeInstanceOf(AbortSignal);
    expect(outboundSignal?.aborted).toBeTrue();
  });
});

test("blocked Geo target stays unavailable on both call paths without exposing queries", async () => {
  const warn = mock(() => {});
  spyOn(logging, "logger").mockReturnValue({ warn, info: mock(() => {}), error: mock(() => {}), debug: mock(() => {}) });
  const original = process.env.GEO_ALLOWED_TARGETS;
  delete process.env.GEO_ALLOWED_TARGETS;
  try {
    for (const result of [
      await geoService.place.list({ baseUrl: "http://127.0.0.1", filter: { query: "private query" } }),
      await geoService.place.get({ baseUrl: "http://127.0.0.1", lat: 1, lon: 2 }),
    ])
      expect(result).toMatchObject({ ok: false, error: { code: "GEO_UNAVAILABLE" } });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).toContain("GEO_ALLOWED_TARGETS");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private query");
  } finally {
    if (original === undefined) delete process.env.GEO_ALLOWED_TARGETS;
    else process.env.GEO_ALLOWED_TARGETS = original;
  }
});

test("Geo default allows only its shipped internal host and rejects invalid startup configuration", async () => {
  const { geoAllowlist } = await import("./geo");
  const previous = process.env.GEO_ALLOWED_TARGETS;
  try {
    delete process.env.GEO_ALLOWED_TARGETS;
    expect([...geoAllowlist().hosts]).toEqual(["geo"]);
    process.env.GEO_ALLOWED_TARGETS = "127.0.0.1";
    expect(geoAllowlist().hosts.has("geo")).toBe(false);
    process.env.GEO_ALLOWED_TARGETS = "0.0.0.0/0";
    expect(geoAllowlist).toThrow("GEO_ALLOWED_TARGETS");
  } finally {
    if (previous === undefined) delete process.env.GEO_ALLOWED_TARGETS;
    else process.env.GEO_ALLOWED_TARGETS = previous;
  }
});

test("Geo refuses loopback without an allowlist and supports search and reverse lookup when allowed", async () => {
  const { createServer } = await import("node:http");
  const warn = mock(() => {});
  spyOn(logging, "logger").mockReturnValue({ warn, info: mock(() => {}), error: mock(() => {}), debug: mock(() => {}) });
  let received = 0;
  const server = createServer((_req, res) => {
    received++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ places: [{ name: "Ulm", latitude: 48.4, longitude: 9.99 }] }));
  });
  const original = process.env.GEO_ALLOWED_TARGETS;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected IP address");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    delete process.env.GEO_ALLOWED_TARGETS;
    expect(await geoService.place.list({ baseUrl, filter: { query: "Ulm" } })).toMatchObject({
      ok: false,
      error: { code: "GEO_UNAVAILABLE" },
    });
    expect(await geoService.place.get({ baseUrl, lat: 48.4, lon: 9.99 })).toMatchObject({ ok: false, error: { code: "GEO_UNAVAILABLE" } });
    expect(received).toBe(0);
    process.env.GEO_ALLOWED_TARGETS = "127.0.0.1";
    expect(await geoService.place.list({ baseUrl, filter: { query: "Ulm" } })).toMatchObject({
      ok: true,
      data: { items: [{ name: "Ulm" }] },
    });
    expect(await geoService.place.get({ baseUrl, lat: 48.4, lon: 9.99 })).toMatchObject({ ok: true, data: { name: "Ulm" } });
    expect(received).toBe(2);
  } finally {
    if (original === undefined) delete process.env.GEO_ALLOWED_TARGETS;
    else process.env.GEO_ALLOWED_TARGETS = original;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
