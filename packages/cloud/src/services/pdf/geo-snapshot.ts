import {
  GEO_SNAPSHOT_MAX_BYTES,
  GEO_SNAPSHOT_MAX_METADATA_BYTES,
  type GeoMapSnapshotManifest,
  GeoMapSnapshotManifestSchema,
  geoMapSnapshotPart,
} from "../../contracts/geo-snapshot";
import { type PreparePdfImageOptions, preparePdfImage } from "./image";

export type GeoMapSnapshotAsset = { id: string; name: string; data: Blob; type: "image/png" | "image/jpeg"; width: number; height: number };
export type GeoMapSnapshotAssetErrorCode = "invalid" | "stale" | "missing" | "too_large" | "unreadable" | "timed_out" | "aborted";
export class GeoMapSnapshotAssetError extends Error {
  constructor(readonly code: GeoMapSnapshotAssetErrorCode) {
    super(`Map snapshot upload: ${code}`);
    this.name = "GeoMapSnapshotAssetError";
  }
}

/**
 * Application calls only after authorizing and reading its canonical saved revision/maps.
 * Validates a presentation upload; it cannot attest that the client's pixels depict the saved geography.
 * Enforce a streaming HTTP body limit BEFORE parsing FormData. Never accept resource URLs or renderer credentials.
 */
export async function prepareGeoMapSnapshotAssets(
  form: FormData,
  expected: { revision: string; maps: Pick<GeoMapSnapshotManifest["images"][number], "id" | "fingerprint">[]; maxBytes: number },
  options: PreparePdfImageOptions = {},
): Promise<GeoMapSnapshotAsset[]> {
  const fail = (code: GeoMapSnapshotAssetErrorCode): never => {
    throw new GeoMapSnapshotAssetError(code);
  };
  if (!Number.isSafeInteger(expected.maxBytes) || expected.maxBytes < 0) throw new RangeError("Invalid PDF asset budget");
  const timeout = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 240_000) throw new RangeError("Invalid map preflight timeout");
  const deadline = Date.now() + timeout;
  const check = () => {
    if (options.signal?.aborted) fail("aborted");
    if (Date.now() >= deadline) fail("timed_out");
  };
  check();
  const metadata = form.getAll("mapSnapshots");
  if (metadata.length !== 1 || typeof metadata[0] !== "string") return fail("invalid");
  if (new TextEncoder().encode(metadata[0]).byteLength > GEO_SNAPSHOT_MAX_METADATA_BYTES) return fail("too_large");
  let manifest: GeoMapSnapshotManifest;
  try {
    manifest = GeoMapSnapshotManifestSchema.parse(JSON.parse(metadata[0]));
  } catch {
    return fail("invalid");
  }
  if (manifest.revision !== expected.revision) return fail("stale");
  const maps = new Map(expected.maps.map((map) => [map.id, map.fingerprint]));
  if (maps.size !== expected.maps.length) throw new Error("Expected maps must have unique IDs");
  if (manifest.images.length !== maps.size) return fail("missing");
  for (const image of manifest.images) {
    if (!maps.has(image.id)) return fail("invalid");
    if (maps.get(image.id) !== image.fingerprint) return fail("stale");
  }
  const names = new Set(manifest.images.map((image) => geoMapSnapshotPart(image.id)));
  for (const name of form.keys()) if (name.startsWith("map-snapshot-") && !names.has(name)) return fail("invalid");
  const maximum = Math.min(expected.maxBytes, GEO_SNAPSHOT_MAX_BYTES);
  let inputBytes = 0;
  const uploads = manifest.images.map((image) => {
    const parts = form.getAll(geoMapSnapshotPart(image.id));
    if (parts.length !== 1 || !(parts[0] instanceof Blob)) return fail("missing");
    const data = parts[0];
    if (data.type !== "image/png") return fail("invalid");
    inputBytes += data.size;
    if (data.size < 33 || inputBytes > maximum) return fail("too_large");
    return { image, data };
  });
  // Check every PNG IHDR before starting any expensive decoder. Filenames are ignored.
  for (const { image, data } of uploads) {
    check();
    const header = new Uint8Array(await data.slice(0, 33).arrayBuffer());
    const view = new DataView(header.buffer);
    if (
      ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header[index] === byte) ||
      view.getUint32(8) !== 13 ||
      view.getUint32(12) !== 0x49484452 ||
      view.getUint32(16) !== image.width ||
      view.getUint32(20) !== image.height
    )
      return fail("invalid");
  }
  const assets: GeoMapSnapshotAsset[] = [];
  let outputBytes = 0;
  for (const { image, data } of uploads) {
    check();
    const remaining = maximum - outputBytes;
    if (remaining < 1) return fail("too_large");
    const prepared = await preparePdfImage(
      { data, boxes: [{ width: image.width, height: image.height }], maxBytes: remaining },
      {
        signal: options.signal,
        timeoutMs: Math.max(1, deadline - Date.now()),
      },
    );
    check();
    if (!prepared.ok) return fail(prepared.code === "unsupported_format" ? "invalid" : prepared.code);
    const variant = prepared.variants[0];
    if (!variant) return fail("too_large");
    if (variant.width !== image.width || variant.height !== image.height) return fail("invalid");
    outputBytes += variant.data.size;
    assets.push({ id: image.id, name: `geo-map-${assets.length}.${variant.type === "image/png" ? "png" : "jpg"}`, ...variant });
  }
  return assets;
}
