import { expect, test } from "bun:test";
import { documentAllowsPublicLinks } from "./document-sharing";

test("public sharing follows the primary PDF, not an artifact name or secondary PDF", () => {
  expect(documentAllowsPublicLinks({ primaryArtifactKey: "main", artifacts: [{ key: "main", mimeType: "application/pdf" }] })).toBe(true);
  expect(documentAllowsPublicLinks({ primaryArtifactKey: "pdf", artifacts: [{ key: "pdf", mimeType: "text/csv" }] })).toBe(false);
  expect(
    documentAllowsPublicLinks({
      primaryArtifactKey: "csv",
      artifacts: [
        { key: "csv", mimeType: "text/csv" },
        { key: "pdf", mimeType: "application/pdf" },
      ],
    }),
  ).toBe(false);
  expect(documentAllowsPublicLinks({ primaryArtifactKey: "missing", artifacts: [] })).toBe(false);
});
