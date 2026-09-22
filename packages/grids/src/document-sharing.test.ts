import { expect, test } from "bun:test";
import { documentProfiles } from "./document-profiles";
import { financialQueryProfiles } from "./document-profiles/financial";
import { zipDocumentProfile } from "./document-profiles/zip";
import { documentAllowsPublicLinks, documentMediaTypeAllowsPublicLinks, PUBLIC_DOCUMENT_LINK_MEDIA_TYPES } from "./document-sharing";

test("the public link allow-list is exactly the primary formats Grids renderers produce", () => {
  const produced = new Set([
    "application/pdf",
    ...[...documentProfiles, ...financialQueryProfiles, zipDocumentProfile].map((profile) => profile.primaryArtifact.mediaType),
  ]);
  expect(new Set<string>(PUBLIC_DOCUMENT_LINK_MEDIA_TYPES)).toEqual(produced);
});

test("public sharing follows the primary artifact's format, not an artifact name or secondary file", () => {
  for (const mimeType of PUBLIC_DOCUMENT_LINK_MEDIA_TYPES) {
    expect(documentAllowsPublicLinks({ primaryArtifactKey: "main", artifacts: [{ key: "main", mimeType }] })).toBe(true);
  }
  expect(
    documentAllowsPublicLinks({
      primaryArtifactKey: "csv",
      artifacts: [
        { key: "csv", mimeType: "text/csv" },
        { key: "pdf", mimeType: "application/pdf" },
      ],
    }),
  ).toBe(true);
  expect(
    documentAllowsPublicLinks({
      primaryArtifactKey: "page",
      artifacts: [
        { key: "page", mimeType: "text/html" },
        { key: "pdf", mimeType: "application/pdf" },
      ],
    }),
  ).toBe(false);
  expect(documentAllowsPublicLinks({ primaryArtifactKey: "missing", artifacts: [] })).toBe(false);
});

test("browser-renderable and unknown media types are never shareable", () => {
  for (const mimeType of [
    "text/html",
    "text/html; charset=utf-8",
    "image/svg+xml",
    "application/xhtml+xml",
    "application/javascript",
    "application/octet-stream",
    "APPLICATION/PDF",
    "",
    null,
    undefined,
  ]) {
    expect(documentMediaTypeAllowsPublicLinks(mimeType)).toBe(false);
  }
});
