import { describe, expect, test } from "bun:test";
import { DocumentExtractionError } from "@k2b/cloud/services/document-extraction";
import { attachmentExtractionJobKey, attachmentExtractionStatusForError, sliceUtf8Text } from "./attachment-extraction";

describe("Mail attachment extraction outcomes", () => {
  test("maps safe terminal document outcomes without retrying", () => {
    expect(attachmentExtractionStatusForError(new DocumentExtractionError("input_too_large", "private"))).toBe("resource_limit");
    expect(attachmentExtractionStatusForError(new DocumentExtractionError("ocr_required", "private"))).toBe("ocr_required");
    expect(attachmentExtractionStatusForError(new DocumentExtractionError("encrypted", "private"))).toBe("encrypted");
    expect(attachmentExtractionStatusForError(new DocumentExtractionError("unsupported", "private"))).toBe("unsupported");
    expect(attachmentExtractionStatusForError(new DocumentExtractionError("malformed", "private"))).toBe("malformed");
  });

  test("keeps cancellation and runtime failures retryable", () => {
    expect(attachmentExtractionStatusForError(new DocumentExtractionError("cancelled", "private"))).toBeNull();
    expect(attachmentExtractionStatusForError(new DocumentExtractionError("internal", "private"))).toBeNull();
  });

  test("uses a stable opaque job key instead of tracing an internal blob ID", () => {
    const blobId = "10000000-0000-4000-8000-000000000001";
    expect(attachmentExtractionJobKey(blobId)).toBe(attachmentExtractionJobKey(blobId));
    expect(attachmentExtractionJobKey(blobId, "csv")).not.toBe(attachmentExtractionJobKey(blobId));
    expect(attachmentExtractionJobKey(blobId)).not.toContain(blobId);
  });

  test("pages extracted text by UTF-8 bytes without splitting characters", () => {
    const first = sliceUtf8Text("A😀BéC", 0, 5);
    expect(first).toEqual({ text: "A😀", offset: 0, length: 5, totalBytes: 9, nextOffset: 5 });
    expect(sliceUtf8Text("A😀BéC", first.nextOffset!, 3)).toEqual({
      text: "Bé",
      offset: 5,
      length: 3,
      totalBytes: 9,
      nextOffset: 8,
    });
  });

  test("rejects offsets beyond content or inside a UTF-8 character", () => {
    expect(() => sliceUtf8Text("A😀B", 2, 256)).toThrow("UTF-8 character boundary");
    expect(() => sliceUtf8Text("A😀B", 7, 256)).toThrow("exceeds the extracted content length");
  });
});
