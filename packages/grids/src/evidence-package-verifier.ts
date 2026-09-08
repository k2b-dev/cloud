import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { type EvidenceExportManifest, EvidenceExportManifestSchema } from "./evidence-export-contracts";
import { assertSafeArchivePath, EVIDENCE_EXPORT_MAX_ENTRIES, EVIDENCE_EXPORT_MAX_PACKAGE_BYTES } from "./service/evidence-archive";

const TAR_BLOCK_BYTES = 512;
const TAR_END_BYTES = TAR_BLOCK_BYTES * 2;
const MAX_MANIFEST_BYTES = EVIDENCE_EXPORT_MAX_ENTRIES * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const decoder = new TextDecoder();

type EvidenceVerificationIssue = {
  code: string;
  message: string;
  path?: string;
};

type EvidencePackageVerification = {
  valid: boolean;
  package: { path: string; sizeBytes: number; sha256: string | null; expectedSha256: string | null };
  manifest: {
    sha256: string | null;
    expectedSha256: string | null;
    schema: string | null;
    version: number | null;
  };
  scope: EvidenceExportManifest["scope"] | null;
  consistency: EvidenceExportManifest["consistency"] | null;
  coverage: EvidenceExportManifest["coverage"] | null;
  counts: EvidenceExportManifest["counts"] | null;
  limits: EvidenceExportManifest["limits"] | null;
  verifiedEntries: number;
  issues: EvidenceVerificationIssue[];
};

type ActualEntry = { path: string; sizeBytes: number; sha256: string };

const textField = (header: Uint8Array, start: number, length: number): string =>
  decoder.decode(header.subarray(start, start + length)).replace(/\0.*$/, "");

const octalField = (header: Uint8Array, start: number, length: number): number | null => {
  const value = textField(header, start, length).trim();
  if (!/^[0-7]+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 8);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const isZeroBlock = (bytes: Uint8Array): boolean => bytes.every((byte) => byte === 0);

const normalizedHash = (value: string | undefined, label: string): string | null => {
  if (value === undefined) return null;
  const hash = value.toLowerCase();
  if (!HASH_PATTERN.test(hash)) throw new Error(`${label} must be a 64-character SHA-256 value.`);
  return hash;
};

const tarChecksum = (header: Uint8Array): number => {
  const checksumHeader = header.slice();
  checksumHeader.fill(0x20, 148, 156);
  return checksumHeader.reduce((sum, byte) => sum + byte, 0);
};

const addIssue = (issues: EvidenceVerificationIssue[], code: string, message: string, path?: string): void => {
  issues.push({ code, message, ...(path ? { path } : {}) });
};

export const verifyEvidencePackage = async (
  path: string,
  expected: { packageSha256?: string; manifestSha256?: string } = {},
): Promise<EvidencePackageVerification> => {
  const expectedPackageSha256 = normalizedHash(expected.packageSha256, "Package SHA-256");
  const expectedManifestSha256 = normalizedHash(expected.manifestSha256, "Manifest SHA-256");
  const issues: EvidenceVerificationIssue[] = [];
  const actualEntries = new Map<string, ActualEntry>();
  const seenPaths = new Set<string>();
  const packageHash = createHash("sha256");
  let manifestBytes: Uint8Array | null = null;
  let manifestSha256: string | null = null;
  let manifest: EvidenceExportManifest | null = null;
  let sizeBytes = 0;
  let position = 0;
  let sawEnd = false;
  let archiveEntryCount = 0;
  const handle = await open(path, "r");

  const readExact = async (length: number): Promise<Uint8Array | null> => {
    const bytes = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const read = await handle.read(bytes, offset, length - offset, position + offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset === 0) return null;
    const result = offset === length ? bytes : bytes.subarray(0, offset);
    position += offset;
    packageHash.update(result);
    return result;
  };

  try {
    const stat = await handle.stat();
    sizeBytes = stat.size;
    if (sizeBytes > EVIDENCE_EXPORT_MAX_PACKAGE_BYTES) {
      addIssue(
        issues,
        "package.too_large",
        `Package is ${sizeBytes} bytes; Grids evidence packages are limited to ${EVIDENCE_EXPORT_MAX_PACKAGE_BYTES} bytes.`,
      );
      return {
        valid: false,
        package: { path, sizeBytes, sha256: null, expectedSha256: expectedPackageSha256 },
        manifest: { sha256: null, expectedSha256: expectedManifestSha256, schema: null, version: null },
        scope: null,
        consistency: null,
        coverage: null,
        counts: null,
        limits: null,
        verifiedEntries: 0,
        issues,
      };
    }
    if (sizeBytes < TAR_END_BYTES || sizeBytes % TAR_BLOCK_BYTES !== 0) {
      addIssue(issues, "tar.size", "Package is not a complete block-aligned TAR archive.");
    }

    while (position < sizeBytes && !sawEnd) {
      const header = await readExact(TAR_BLOCK_BYTES);
      if (!header || header.byteLength !== TAR_BLOCK_BYTES) {
        addIssue(issues, "tar.truncated_header", "TAR header is truncated.");
        break;
      }
      if (isZeroBlock(header)) {
        const second = await readExact(TAR_BLOCK_BYTES);
        if (!second || second.byteLength !== TAR_BLOCK_BYTES || !isZeroBlock(second)) {
          addIssue(issues, "tar.invalid_end", "TAR archive must end with two empty blocks.");
        }
        sawEnd = true;
        break;
      }
      archiveEntryCount += 1;
      if (archiveEntryCount > EVIDENCE_EXPORT_MAX_ENTRIES) {
        addIssue(issues, "package.too_many_entries", `Package exceeds the ${EVIDENCE_EXPORT_MAX_ENTRIES} entry limit.`);
        break;
      }

      const pathValue = textField(header, 0, 100);
      const declaredChecksum = octalField(header, 148, 8);
      const entrySize = octalField(header, 124, 12);
      const type = header[156];
      const format = textField(header, 257, 6);
      const version = textField(header, 263, 2);
      const linkName = textField(header, 157, 100);
      const prefix = textField(header, 345, 155);
      if (declaredChecksum === null || declaredChecksum !== tarChecksum(header)) {
        addIssue(issues, "tar.checksum", "TAR header checksum does not match.", pathValue || undefined);
      }
      if (type !== 0 && type !== "0".charCodeAt(0)) {
        addIssue(issues, "tar.entry_type", "Only regular files are supported in evidence packages.", pathValue || undefined);
      }
      if (format !== "ustar" || version !== "00" || linkName || prefix) {
        addIssue(issues, "tar.unsupported_header", "TAR entry uses unsupported header fields.", pathValue || undefined);
      }
      try {
        assertSafeArchivePath(pathValue);
      } catch {
        addIssue(issues, "tar.unsafe_path", `Unsafe archive path: ${pathValue || "<empty>"}.`, pathValue || undefined);
      }
      if (seenPaths.has(pathValue)) {
        addIssue(issues, "tar.duplicate_path", "Archive path occurs more than once.", pathValue);
      }
      seenPaths.add(pathValue);
      if (entrySize === null || entrySize > sizeBytes - position) {
        addIssue(issues, "tar.invalid_size", "TAR entry has an invalid or truncated size.", pathValue || undefined);
        break;
      }
      if (pathValue === "manifest.json" && entrySize > MAX_MANIFEST_BYTES) {
        addIssue(issues, "manifest.too_large", `Manifest exceeds the ${MAX_MANIFEST_BYTES} byte metadata budget.`, pathValue);
      }

      const entryHash = createHash("sha256");
      const collectManifest = pathValue === "manifest.json" && entrySize <= MAX_MANIFEST_BYTES;
      const collected = collectManifest ? new Uint8Array(entrySize) : null;
      let remaining = entrySize;
      let collectedOffset = 0;
      while (remaining > 0) {
        const chunkSize = Math.min(1024 * 1024, remaining);
        const chunk = await readExact(chunkSize);
        if (!chunk || chunk.byteLength !== chunkSize) {
          addIssue(issues, "tar.truncated_entry", "TAR entry content is truncated.", pathValue || undefined);
          remaining = -1;
          break;
        }
        entryHash.update(chunk);
        collected?.set(chunk, collectedOffset);
        collectedOffset += chunk.byteLength;
        remaining -= chunk.byteLength;
      }
      if (remaining < 0) break;

      const paddingSize = (TAR_BLOCK_BYTES - (entrySize % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
      if (paddingSize > 0) {
        const padding = await readExact(paddingSize);
        if (!padding || padding.byteLength !== paddingSize) {
          addIssue(issues, "tar.truncated_padding", "TAR entry padding is truncated.", pathValue || undefined);
          break;
        }
        if (!isZeroBlock(padding)) addIssue(issues, "tar.padding", "TAR entry padding must be empty.", pathValue || undefined);
      }

      const actual = { path: pathValue, sizeBytes: entrySize, sha256: entryHash.digest("hex") };
      if (pathValue === "manifest.json") {
        manifestBytes = collected;
        manifestSha256 = actual.sha256;
      } else if (!actualEntries.has(pathValue)) {
        actualEntries.set(pathValue, actual);
      }
    }

    if (!sawEnd) addIssue(issues, "tar.missing_end", "TAR archive has no complete end marker.");
    if (sawEnd && position !== sizeBytes) {
      const trailing = sizeBytes - position;
      while (position < sizeBytes) {
        const chunk = await readExact(Math.min(1024 * 1024, sizeBytes - position));
        if (!chunk) break;
      }
      addIssue(issues, "tar.trailing_data", `TAR archive contains ${trailing} trailing byte(s).`);
    }
    while (position < sizeBytes) {
      const chunk = await readExact(Math.min(1024 * 1024, sizeBytes - position));
      if (!chunk) break;
    }
  } finally {
    await handle.close();
  }

  const packageSha256 = packageHash.digest("hex");
  if (expectedPackageSha256 && expectedPackageSha256 !== packageSha256) {
    addIssue(issues, "package.hash_mismatch", "Package SHA-256 does not match the expected value.");
  }
  if (!manifestBytes) {
    addIssue(issues, "manifest.missing", "Package does not contain one readable manifest.json.");
  } else {
    if (expectedManifestSha256 && expectedManifestSha256 !== manifestSha256) {
      addIssue(issues, "manifest.hash_mismatch", "Manifest SHA-256 does not match the expected value.", "manifest.json");
    }
    try {
      const parsed = EvidenceExportManifestSchema.safeParse(JSON.parse(decoder.decode(manifestBytes)));
      if (parsed.success) manifest = parsed.data;
      else {
        const details = parsed.error.issues
          .slice(0, 10)
          .map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
          .join("; ");
        addIssue(issues, "manifest.invalid", `Manifest does not match the evidence export contract: ${details}.`, "manifest.json");
      }
    } catch (error) {
      addIssue(
        issues,
        "manifest.invalid",
        `Manifest is not valid JSON: ${error instanceof Error ? error.message.slice(0, 500) : "parse failed"}.`,
        "manifest.json",
      );
    }
  }

  if (manifest) {
    const declared = new Map<string, EvidenceExportManifest["entries"][number]>();
    for (const entry of manifest.entries) {
      try {
        assertSafeArchivePath(entry.path);
      } catch {
        addIssue(issues, "manifest.unsafe_path", `Manifest contains an unsafe path: ${entry.path}.`, entry.path);
      }
      if (entry.path === "manifest.json") {
        addIssue(issues, "manifest.self_reference", "Manifest must not list itself as an evidence entry.", entry.path);
      }
      if (declared.has(entry.path)) addIssue(issues, "manifest.duplicate_path", "Manifest path occurs more than once.", entry.path);
      else declared.set(entry.path, entry);
    }
    for (const [entryPath, entry] of declared) {
      const actual = actualEntries.get(entryPath);
      if (!actual) {
        addIssue(issues, "entry.missing", "Manifest entry is missing from the package.", entryPath);
        continue;
      }
      if (actual.sizeBytes !== entry.sizeBytes)
        addIssue(issues, "entry.size_mismatch", "Entry size does not match the manifest.", entryPath);
      if (actual.sha256 !== entry.sha256) addIssue(issues, "entry.hash_mismatch", "Entry SHA-256 does not match the manifest.", entryPath);
    }
    for (const entryPath of actualEntries.keys()) {
      if (!declared.has(entryPath)) addIssue(issues, "entry.unexpected", "Package entry is not declared by the manifest.", entryPath);
    }
  }

  return {
    valid: issues.length === 0,
    package: { path, sizeBytes, sha256: packageSha256, expectedSha256: expectedPackageSha256 },
    manifest: {
      sha256: manifestSha256,
      expectedSha256: expectedManifestSha256,
      schema: manifest?.schema ?? null,
      version: manifest?.version ?? null,
    },
    scope: manifest?.scope ?? null,
    consistency: manifest?.consistency ?? null,
    coverage: manifest?.coverage ?? null,
    counts: manifest?.counts ?? null,
    limits: manifest?.limits ?? null,
    verifiedEntries: manifest ? actualEntries.size : 0,
    issues,
  };
};
