import { type GeoMapSnapshotManifest, geoMapSnapshotFingerprint, geoMapSnapshotPart } from "@k2b/cloud/contracts/geo-snapshot";
import { type GeoDocument, GeoDocumentSchema, serializeGeoDocument } from "@k2b/cloud/geo/document";
import { prepareGeoMapSnapshotAssets } from "@k2b/cloud/services/pdf";
import type { MapViewSnapshot } from "@k2b/ui";

/** The browser submits the complete document fingerprint alongside its captured PNG. */
export async function savedMapUpload(document: GeoDocument, revision: string, snapshot: MapViewSnapshot) {
  const saved = GeoDocumentSchema.parse(document);
  const manifest: GeoMapSnapshotManifest = {
    version: 1,
    revision,
    images: [{ id: "map-1", fingerprint: await geoMapSnapshotFingerprint(saved), width: snapshot.width, height: snapshot.height }],
  };
  const form = new FormData();
  form.set("mapSnapshots", JSON.stringify(manifest));
  form.set(geoMapSnapshotPart("map-1"), snapshot.data, "map.png");
  return { markdown: serializeGeoDocument(saved), form };
}

/** Call on the server after authorizing the document and bounding the multipart body. */
export async function prepareAuthorizedMapExport(
  form: FormData,
  authorizedDocument: GeoDocument,
  revision: string,
  remainingPdfBytes: number,
  signal: AbortSignal,
) {
  return prepareGeoMapSnapshotAssets(
    form,
    { revision, maps: [{ id: "map-1", fingerprint: await geoMapSnapshotFingerprint(authorizedDocument) }], maxBytes: remainingPdfBytes },
    { signal },
  );
}
