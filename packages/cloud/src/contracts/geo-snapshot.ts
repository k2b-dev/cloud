import { z } from "zod";

// Matches the geo result JSON envelope and the existing print decoder budgets.
export const GEO_SNAPSHOT_MAX_METADATA_BYTES = 256 * 1024;
export const GEO_SNAPSHOT_MAX_PIXELS = 16 * 1024 * 1024;
export const GEO_SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024;
export const GeoMapSnapshotIdSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);
export const GeoMapSnapshotImageSchema = z
  .strictObject({
    id: GeoMapSnapshotIdSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    width: z.number().int().min(1).max(16383),
    height: z.number().int().min(1).max(16383),
  })
  .refine((image) => image.width * image.height <= GEO_SNAPSHOT_MAX_PIXELS, "Map image exceeds decoded pixel budget");
export const GeoMapSnapshotManifestSchema = z
  .strictObject({
    version: z.literal(1),
    revision: z.string().min(1).max(300),
    // Even IDs with one character need a 64-byte SHA-256: this bounds schema work independently of input parsing.
    images: z.array(GeoMapSnapshotImageSchema).max(GEO_SNAPSHOT_MAX_METADATA_BYTES / 64),
  })
  .refine((value) => new Set(value.images.map((image) => image.id)).size === value.images.length, "Duplicate map ID");
export type GeoMapSnapshotManifest = z.infer<typeof GeoMapSnapshotManifestSchema>;
export const geoMapSnapshotPart = (id: string) => `map-snapshot-${GeoMapSnapshotIdSchema.parse(id)}`;

/** Hash the validated saved GeoDocument, not a lossy geometry projection. Same algorithm in browser and server. */
export async function geoMapSnapshotFingerprint(value: unknown): Promise<string> {
  // First enforce genuine JSON (and bound traversal) without invoking caller-defined toJSON/accessors.
  let remaining = GEO_SNAPSHOT_MAX_METADATA_BYTES;
  const ancestors = new Set<object>();
  const canonical = (input: unknown): string => {
    if (--remaining < 0) throw new RangeError("Map snapshot input exceeds geo JSON budget");
    if (
      input === null ||
      typeof input === "boolean" ||
      typeof input === "string" ||
      (typeof input === "number" && Number.isFinite(input))
    ) {
      const result = JSON.stringify(input);
      remaining -= result.length;
      return result;
    }
    if (typeof input !== "object" || !input || ancestors.has(input)) throw new TypeError("Map snapshot input must be JSON");
    if (!Array.isArray(input) && Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
      throw new TypeError("Map snapshot input must be plain JSON");
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        if (input.length > remaining) throw new RangeError("Map snapshot input exceeds geo JSON budget");
        const items: string[] = [];
        for (let index = 0; index < input.length; index++) {
          const property = Object.getOwnPropertyDescriptor(input, String(index));
          if (!property || !("value" in property)) throw new TypeError("Map snapshot input must be plain JSON");
          items.push(canonical(property.value));
        }
        return `[${items.join(",")}]`;
      }
      return `{${Object.keys(input)
        .sort()
        .map((key) => {
          const property = Object.getOwnPropertyDescriptor(input, key)!;
          if (!("value" in property)) throw new TypeError("Map snapshot input must not contain accessors");
          remaining -= key.length;
          return `${JSON.stringify(key)}:${canonical(property.value)}`;
        })
        .join(",")}}`;
    } finally {
      ancestors.delete(input);
    }
  };
  let serialized: string;
  try {
    serialized = canonical(value);
  } catch (error) {
    if (error instanceof RangeError) throw new RangeError("Map snapshot input exceeds geo JSON budget");
    throw error;
  }
  const bytes = new TextEncoder().encode(serialized);
  if (bytes.byteLength > GEO_SNAPSHOT_MAX_METADATA_BYTES) throw new RangeError("Map snapshot input exceeds geo JSON budget");
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
