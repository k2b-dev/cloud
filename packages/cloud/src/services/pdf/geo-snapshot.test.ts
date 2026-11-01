import { expect, test } from "bun:test";
import sharp from "sharp";
import { geoMapSnapshotFingerprint, geoMapSnapshotPart } from "../../contracts/geo-snapshot";
import { prepareGeoMapSnapshotAssets } from "./geo-snapshot";

const document = { version: 1, title: "Walk", pins: [{ id: "museum", label: "Museum", point: { lat: 48.4, lon: 10 } }] };
const fingerprint = await geoMapSnapshotFingerprint(document);
const expected = { revision: "rev-17", maps: [{ id: "block-1", fingerprint }], maxBytes: 1024 * 1024 };
// Real, small raster with a known red pin over a land-coloured background, not an image-worker stub.
const png = await sharp({ create: { width: 200, height: 100, channels: 3, background: "#f1efe9" } })
  .composite([{ input: Buffer.from('<svg width="200" height="100"><circle cx="100" cy="50" r="10" fill="red"/></svg>') }])
  .png()
  .toBuffer();
function form(data: Uint8Array = png) {
  const upload = new FormData();
  upload.set(
    "mapSnapshots",
    JSON.stringify({ version: 1, revision: expected.revision, images: [{ ...expected.maps[0], width: 200, height: 100 }] }),
  );
  upload.set(geoMapSnapshotPart("block-1"), new Blob([Uint8Array.from(data)], { type: "image/png" }), "../../untrusted-name.png");
  return upload;
}

test("canonical map hashes bind full saved data across browser/JSON key order", async () => {
  expect(await geoMapSnapshotFingerprint(JSON.parse(JSON.stringify(document)))).toBe(fingerprint);
  expect(await geoMapSnapshotFingerprint({ pins: document.pins, title: document.title, version: 1 })).toBe(fingerprint);
  expect(await geoMapSnapshotFingerprint({ ...document, title: "Different" })).not.toBe(fingerprint);
  expect(await geoMapSnapshotFingerprint({ ...document, pins: [{ ...document.pins[0], point: { lat: 49, lon: 10 } }] })).not.toBe(
    fingerprint,
  );
  for (const value of [undefined, NaN, { bad: undefined }, { fn: () => 1 }, new Date("2026-10-22T00:00:00Z")])
    await expect(geoMapSnapshotFingerprint(value)).rejects.toThrow();
  let reads = 0;
  const accessor = Object.defineProperty({}, "field", {
    enumerable: true,
    get() {
      reads++;
      return "bad";
    },
  });
  const arrayAccessor = Object.defineProperty([], "0", {
    enumerable: true,
    get() {
      reads++;
      return "bad";
    },
  });
  await expect(geoMapSnapshotFingerprint(accessor)).rejects.toThrow();
  await expect(geoMapSnapshotFingerprint(arrayAccessor)).rejects.toThrow();
  await expect(geoMapSnapshotFingerprint(new Array(1000000))).rejects.toThrow();
  expect(reads).toBe(0);
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  await expect(geoMapSnapshotFingerprint(cycle)).rejects.toThrow();
  await expect(geoMapSnapshotFingerprint({ text: "x".repeat(256 * 1024) })).rejects.toThrow();
});

test("revision-bound preflight decodes a PNG in the isolated worker into a named offline image", async () => {
  const [asset] = await prepareGeoMapSnapshotAssets(form(), expected);
  expect(asset).toMatchObject({ id: "block-1", name: "geo-map-0.jpg", type: "image/jpeg", width: 200, height: 100 });
  const decoded = await sharp(Buffer.from(await asset!.data.arrayBuffer()))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) =>
    Array.from(decoded.data.subarray((y * 200 + x) * decoded.info.channels, (y * 200 + x) * decoded.info.channels + 3));
  const red = at(100, 50);
  expect(red[0]).toBeGreaterThan(240);
  expect(red[1]).toBeLessThan(20);
  expect(red[2]).toBeLessThan(20);
  const land = at(5, 5);
  expect(land[0]).toBeGreaterThan(235);
  expect(land[1]).toBeGreaterThan(235);
  expect(land[2]).toBeGreaterThan(225);
}, 30_000);

test("rejects stale revisions, changed geometry, missing/extra/duplicate parts and unsafe manifests", async () => {
  await expect(prepareGeoMapSnapshotAssets(form(), { ...expected, revision: "rev-18" })).rejects.toMatchObject({ code: "stale" });
  await expect(
    prepareGeoMapSnapshotAssets(form(), { ...expected, maps: [{ id: "block-1", fingerprint: "0".repeat(64) }] }),
  ).rejects.toMatchObject({ code: "stale" });
  const missing = form();
  missing.delete(geoMapSnapshotPart("block-1"));
  await expect(prepareGeoMapSnapshotAssets(missing, expected)).rejects.toMatchObject({ code: "missing" });
  const duplicate = form();
  duplicate.append(geoMapSnapshotPart("block-1"), new Blob([png], { type: "image/png" }));
  await expect(prepareGeoMapSnapshotAssets(duplicate, expected)).rejects.toMatchObject({ code: "missing" });
  const extra = form();
  extra.append("map-snapshot-injected", new Blob([png]));
  await expect(prepareGeoMapSnapshotAssets(extra, expected)).rejects.toMatchObject({ code: "invalid" });
  for (const id of ["../block-1", "https://example.org/", "file:///etc/passwd", "<img>"]) {
    const unsafe = form();
    unsafe.set(
      "mapSnapshots",
      JSON.stringify({ version: 1, revision: expected.revision, images: [{ id, fingerprint, width: 200, height: 100 }] }),
    );
    await expect(prepareGeoMapSnapshotAssets(unsafe, expected)).rejects.toMatchObject({ code: "invalid" });
  }
  const remote = form();
  remote.set(geoMapSnapshotPart("block-1"), "https://example.org/map.png");
  await expect(prepareGeoMapSnapshotAssets(remote, expected)).rejects.toMatchObject({ code: "missing" });
});

test("bounds total bytes, metadata and decoded dimensions before decode; corrupt PNGs never pass", async () => {
  await expect(prepareGeoMapSnapshotAssets(form(), { ...expected, maxBytes: png.byteLength - 1 })).rejects.toMatchObject({
    code: "too_large",
  });
  const huge = form();
  huge.set("mapSnapshots", " ".repeat(256 * 1024 + 1));
  await expect(prepareGeoMapSnapshotAssets(huge, expected)).rejects.toMatchObject({ code: "too_large" });
  const dimensions = form();
  dimensions.set(
    "mapSnapshots",
    JSON.stringify({ version: 1, revision: expected.revision, images: [{ ...expected.maps[0], width: 200, height: 101 }] }),
  );
  await expect(prepareGeoMapSnapshotAssets(dimensions, expected)).rejects.toMatchObject({ code: "invalid" });
  const oversized = form();
  oversized.set(
    "mapSnapshots",
    JSON.stringify({ version: 1, revision: expected.revision, images: [{ ...expected.maps[0], width: 10000, height: 10000 }] }),
  );
  await expect(prepareGeoMapSnapshotAssets(oversized, expected)).rejects.toMatchObject({ code: "invalid" });
  await expect(prepareGeoMapSnapshotAssets(form(png.subarray(0, 40)), expected)).rejects.toMatchObject({ code: "unreadable" });
  await expect(prepareGeoMapSnapshotAssets(form(new TextEncoder().encode("<svg>".repeat(20))), expected)).rejects.toMatchObject({
    code: "invalid",
  });
}, 30_000);

test("preflight respects cancellation without producing assets", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(prepareGeoMapSnapshotAssets(form(), expected, { signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
});
