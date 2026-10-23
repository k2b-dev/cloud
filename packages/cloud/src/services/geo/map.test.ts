import { expect, mock, test } from "bun:test";
import { GEO_MAX_TILE_BYTES } from "../../contracts/geo-map";
import { GeoError } from "./errors";
import { GEO_TEST_KEY, GEO_TEST_NOW, geoTestConfig, geoTestContext } from "./geo.test-fixture";
import type { GeoFetch } from "./geoapify";
import { createGeoMapService } from "./map";

const tile = { z: 8, x: 128, y: 128 };
const setup = (
  fetch: GeoFetch = async () => new Response(new Uint8Array([26, 0]), { headers: { "Content-Type": "application/x-protobuf" } }),
) => {
  const send = mock(fetch);
  const reserve = mock(async (_subject, _config, cost: number, group: string) => ({ cost, group, rows: [] }));
  const settle = mock(async () => {});
  const recordTransition = mock(async () => {});
  const release = mock(async () => {});
  const acquire = mock(async () => release);
  const config = mock(async () => geoTestConfig);
  const availability = mock(async () => ({
    cloud: { exhausted: false, resetsAt: GEO_TEST_NOW.toISOString() },
    person: { exhausted: false, resetsAt: GEO_TEST_NOW.toISOString() },
  }));
  const service = createGeoMapService({
    config,
    now: () => GEO_TEST_NOW,
    fetch: send,
    bucket: { acquire },
    ledger: { reserve, settle, recordTransition, availability },
  });
  return { service, config, send, reserve, settle, acquire, release, recordTransition };
};

test("tiles require an identity and configuration before admission, including direct service calls", async () => {
  const f = setup();
  await expect(f.service.tile(tile, {})).rejects.toMatchObject({ code: "GEO_FORBIDDEN" });
  f.config.mockImplementation(async () => ({ ...geoTestConfig, apiKey: "" }));
  await expect(f.service.tile(tile, geoTestContext)).rejects.toMatchObject({ code: "GEO_NOT_CONFIGURED" });
  expect(f.send).not.toHaveBeenCalled();
  expect(f.reserve).not.toHaveBeenCalled();
  expect(f.acquire).not.toHaveBeenCalled();
});

test("tile coordinates are bounded before paid work", async () => {
  const f = setup();
  for (const input of [
    { z: 15, x: 0, y: 0 },
    { z: 0, x: 1, y: 0 },
    { z: 4, x: -1, y: 0 },
    { z: 4, x: 0, y: 16 },
    { z: 1.2, x: 0, y: 0 },
  ])
    await expect(f.service.tile(input, geoTestContext)).rejects.toMatchObject({ code: "GEO_UNSUPPORTED_OPTION" });
  expect(f.send).not.toHaveBeenCalled();
  expect(f.acquire).not.toHaveBeenCalled();
});

test("a tile reserves 250 millicredits for the access subject and uses the EU origin with a header-only key", async () => {
  const f = setup();
  expect(await f.service.tile(tile, geoTestContext)).toEqual(new Uint8Array([26, 0]));
  expect(f.acquire).toHaveBeenCalledWith("tiles", 20);
  expect(f.reserve).toHaveBeenCalledWith(geoTestContext.accessSubject, geoTestConfig, 250, "tiles", GEO_TEST_NOW);
  const [url, init] = f.send.mock.calls[0]!;
  expect(url.href).toBe("https://api-eu.geoapify.com/v1/tile/osm-bright/8/128/128.pbf");
  expect(new Headers(init.headers).get("x-api-key")).toBe(GEO_TEST_KEY);
  expect(init.redirect).toBe("error");
  expect(init.credentials).toBe("omit");
  expect(f.release).toHaveBeenCalledTimes(1);
});

test("budget and Valkey failures send no paid request", async () => {
  const f = setup();
  f.reserve.mockImplementation(async () => {
    throw new GeoError("GEO_BUDGET_EXHAUSTED", { scope: "cloud", resetsAt: "2026-11-01T00:00:00Z" });
  });
  await expect(f.service.tile(tile, geoTestContext)).rejects.toMatchObject({ code: "GEO_BUDGET_EXHAUSTED" });
  expect(f.recordTransition).toHaveBeenCalledTimes(1);
  expect(f.send).not.toHaveBeenCalled();
  f.acquire.mockImplementation(async () => {
    throw new GeoError("GEO_BUSY");
  });
  await expect(f.service.tile(tile, geoTestContext)).rejects.toMatchObject({ code: "GEO_BUSY" });
  expect(f.send).not.toHaveBeenCalled();
});

test("unsent requests retry once and refund; uncertain network outcomes never retry", async () => {
  const unsent = setup(async () => {
    throw Object.assign(new Error("private provider details"), { code: "ECONNREFUSED" });
  });
  await expect(unsent.service.tile(tile, geoTestContext)).rejects.toMatchObject({
    code: "GEO_PROVIDER_FAILED",
    details: { costs: { settledCredits: 0, unknownCredits: 0 } },
  });
  expect(unsent.send).toHaveBeenCalledTimes(2);
  expect(unsent.settle).toHaveBeenCalledWith({ cost: 250, group: "tiles", rows: [] }, 0);
  const unknown = setup(async () => {
    throw new Error(`network failure ${GEO_TEST_KEY}`);
  });
  await expect(unknown.service.tile(tile, geoTestContext)).rejects.toMatchObject({
    code: "GEO_PROVIDER_FAILED",
    details: { costs: { settledCredits: 0, unknownCredits: 0.25 } },
  });
  expect(unknown.send).toHaveBeenCalledTimes(1);
  expect(unknown.settle).not.toHaveBeenCalled();
});

test("a failed refund remains an unknown cost", async () => {
  const f = setup(async () => {
    throw Object.assign(new Error(), { code: "ECONNREFUSED" });
  });
  f.settle.mockImplementation(async () => {
    throw new Error("ledger unavailable");
  });
  await expect(f.service.tile(tile, geoTestContext)).rejects.toMatchObject({ details: { costs: { unknownCredits: 0.25 } } });
});

test("invalid content, oversized streamed tiles and echoed keys never leave Core", async () => {
  for (const response of [
    new Response(GEO_TEST_KEY, { headers: { "Content-Type": "text/html" } }),
    new Response(GEO_TEST_KEY, { headers: { "Content-Type": "application/x-protobuf" } }),
    new Response(new Uint8Array(GEO_MAX_TILE_BYTES + 1), { headers: { "Content-Type": "application/x-protobuf" } }),
    new Response("redirect", { status: 302, headers: { Location: `https://example.test/${GEO_TEST_KEY}` } }),
  ]) {
    const f = setup(async () => response);
    try {
      await f.service.tile(tile, geoTestContext);
      throw new Error("Expected rejection");
    } catch (error) {
      expect(error).toMatchObject({ code: "GEO_PROVIDER_FAILED" });
      expect(JSON.stringify(error)).not.toContain(GEO_TEST_KEY);
    }
    expect(f.release).toHaveBeenCalledTimes(1);
  }
});

test("style is free and returns only Cloud URLs and attribution", async () => {
  const f = setup();
  const data = await f.service.style({ theme: "dark" }, geoTestContext);
  expect(data.styleUrl).toBe("/api/geo/style?theme=dark&locale=de");
  expect(data.attribution).toHaveLength(3);
  expect(f.send).not.toHaveBeenCalled();
  expect(f.reserve).not.toHaveBeenCalled();
});
