import { createHash } from "node:crypto";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { PrimaryDocumentArtifact } from "../document-profile-contracts";
import type { DocumentArtifactDraft } from "../document-profiles";
import { documentServiceText } from "./document-messages";

export const MAX_DOCUMENT_ARTIFACTS = 8;
export const MAX_DOCUMENT_ARTIFACT_BYTES = 100 * 1024 * 1024;

type ValidatedArtifact = DocumentArtifactDraft & { sha256: string };

// Content types are persisted and later sent as HTTP headers. Keep them canonical.
const mediaTypePattern = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

export const validateDocumentArtifactDrafts = (
  drafts: readonly DocumentArtifactDraft[],
  primary: PrimaryDocumentArtifact,
  locale?: string,
): Result<{ artifacts: ValidatedArtifact[]; primary: ValidatedArtifact }> => {
  const t = documentServiceText(locale);
  if (drafts.length < 1 || drafts.length > MAX_DOCUMENT_ARTIFACTS) {
    return fail(err.badInput(t.artifactCount({ minimum: 1, maximum: MAX_DOCUMENT_ARTIFACTS })));
  }
  const keys = new Set<string>();
  let totalBytes = 0;
  for (const artifact of drafts) {
    if (!/^[a-z][a-z0-9._-]{0,63}$/.test(artifact.key) || keys.has(artifact.key)) {
      return fail(err.badInput(t.artifactKeysInvalid));
    }
    keys.add(artifact.key);
    if (
      !artifact.filename.trim() ||
      artifact.filename !== artifact.filename.trim() ||
      artifact.filename === "." ||
      artifact.filename === ".." ||
      artifact.filename.length > 255 ||
      /[\\/\u0000-\u001f\u007f]/.test(artifact.filename)
    ) {
      return fail(err.badInput(t.artifactFilenameInvalid({ key: artifact.key })));
    }
    if (artifact.mediaType.length > 255 || !mediaTypePattern.test(artifact.mediaType)) {
      return fail(err.badInput(t.artifactMediaTypeInvalid({ key: artifact.key })));
    }
    if (artifact.bytes.byteLength === 0) return fail(err.badInput(t.artifactEmpty({ key: artifact.key })));
    totalBytes += artifact.bytes.byteLength;
    if (totalBytes > MAX_DOCUMENT_ARTIFACT_BYTES) {
      return fail(err.badInput(t.artifactBytesExceeded({ limit: MAX_DOCUMENT_ARTIFACT_BYTES })));
    }
    if (artifact.mediaType === "application/pdf" && new TextDecoder().decode(artifact.bytes.subarray(0, 5)) !== "%PDF-") {
      return fail(err.badInput(t.pdfArtifactRequired));
    }
  }
  const selected = drafts.find((artifact) => artifact.key === primary.key);
  if (!selected || selected.mediaType !== primary.mediaType) {
    return fail(err.badInput(t.primaryArtifactRequired({ key: primary.key, mediaType: primary.mediaType })));
  }
  const artifacts = drafts.map((artifact) => {
    // Retain the exact validated bytes even if a renderer reuses its buffer.
    const bytes = Uint8Array.from(artifact.bytes);
    return { ...artifact, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const validatedPrimary = artifacts.find((artifact) => artifact.key === primary.key);
  if (!validatedPrimary) return fail(err.internal(t.artifactsMissing));
  return ok({ artifacts, primary: validatedPrimary });
};
