import { describe, expect, test } from "bun:test";
import {
  ChunkedUploadStartSchema,
  ChunkHeaderSchema,
  DuplicateRequestSchema,
  FileBaseParamSchema,
  FilePathQuerySchema,
  GlobalSearchQuerySchema,
  TransferRequestSchema,
  UploadHeaderSchema,
} from "./contracts";

describe("Files contracts", () => {
  test("accepts valid base params", () => {
    expect(FileBaseParamSchema.safeParse({ baseType: "group", baseId: "team" }).success).toBe(true);
  });

  test("rejects invalid base type", () => {
    expect(FileBaseParamSchema.safeParse({ baseType: "other", baseId: "team" }).success).toBe(false);
  });

  test("rejects file names with path separators", () => {
    expect(UploadHeaderSchema.safeParse({ "x-file-name": "../secret.txt" }).success).toBe(false);
    expect(DuplicateRequestSchema.safeParse({ path: "/source.txt", newName: "folder/copy.txt" }).success).toBe(false);
  });

  test("rejects blank or reserved file names", () => {
    expect(UploadHeaderSchema.safeParse({ "x-file-name": "   " }).success).toBe(false);
    expect(UploadHeaderSchema.safeParse({ "x-file-name": "." }).success).toBe(false);
    expect(DuplicateRequestSchema.safeParse({ path: "/source.txt", newName: ".." }).success).toBe(false);
  });

  test("rejects null bytes in paths", () => {
    expect(FilePathQuerySchema.safeParse({ path: "/folder/\0file.txt" }).success).toBe(false);
    expect(TransferRequestSchema.safeParse({ paths: ["/a"], targetBaseType: "home", targetBaseId: "eva", targetPath: "/\0" }).success).toBe(
      false,
    );
  });

  test("bounds global search input", () => {
    expect(GlobalSearchQuerySchema.safeParse({ pattern: "**/*.pdf", limit: "20" }).success).toBe(true);
    expect(GlobalSearchQuerySchema.safeParse({ pattern: "", limit: "20" }).success).toBe(false);
  });

  test("validates chunk checksums", () => {
    expect(
      ChunkedUploadStartSchema.safeParse({
        filename: "report.pdf",
        size: 1,
        checksum: `sha256:${"a".repeat(64)}`,
        chunkSize: 1,
      }).success,
    ).toBe(true);
    expect(ChunkHeaderSchema.safeParse({ "x-chunk-checksum": "sha256:abc" }).success).toBe(false);
  });
});
