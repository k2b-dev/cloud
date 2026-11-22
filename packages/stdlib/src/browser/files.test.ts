import { describe, it, expect } from "bun:test";
import zlib from "node:zlib";

// ─── Polyfill CompressionStream / DecompressionStream for Bun ──────────────────
// Bun 1.3 does not expose these Web API globals. We polyfill them using Node's
// zlib so the source module (which targets browsers) can be tested as-is.
//
// The source code uses two patterns:
//   1. compress/decompress (gzip): blob.stream().pipeThrough(new XStream("gzip"))
//   2. deflate/inflate (zip):      writer = cs.writable.getWriter(); writer.write(data); writer.close();
//                                  new Response(cs.readable).arrayBuffer()
//
// We implement a TransformStream-compatible polyfill that handles both patterns.

function makeStreamPair(transformFn: (buf: Buffer) => Buffer) {
  const chunks: Uint8Array[] = [];
  let resolveReadable: (() => void) | null = null;
  const writableClosed = new Promise<void>((r) => (resolveReadable = r));

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(new Uint8Array(chunk));
    },
    close() {
      resolveReadable?.();
    },
  });

  const readable = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await writableClosed;
      const totalLen = chunks.reduce((s, c) => s + c.length, 0);
      const combined = new Uint8Array(totalLen);
      let offset = 0;
      for (const c of chunks) {
        combined.set(c, offset);
        offset += c.length;
      }
      const result = transformFn(Buffer.from(combined));
      controller.enqueue(new Uint8Array(result));
      controller.close();
    },
  });

  return { readable, writable };
}

if (typeof globalThis.CompressionStream === "undefined") {
  const fns: Record<string, (buf: Buffer) => Buffer> = {
    gzip: (buf) => zlib.gzipSync(buf),
    deflate: (buf) => zlib.deflateSync(buf),
    "deflate-raw": (buf) => zlib.deflateRawSync(buf),
  };

  (globalThis as any).CompressionStream = class CompressionStream {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    constructor(format: string) {
      const fn = fns[format];
      if (!fn) throw new Error(`Unsupported format: ${format}`);
      const pair = makeStreamPair(fn);
      this.readable = pair.readable;
      this.writable = pair.writable;
    }
  };
}

if (typeof globalThis.DecompressionStream === "undefined") {
  const fns: Record<string, (buf: Buffer) => Buffer> = {
    gzip: (buf) => zlib.gunzipSync(buf),
    deflate: (buf) => zlib.inflateSync(buf),
    "deflate-raw": (buf) => zlib.inflateRawSync(buf),
  };

  (globalThis as any).DecompressionStream = class DecompressionStream {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    constructor(format: string) {
      const fn = fns[format];
      if (!fn) throw new Error(`Unsupported format: ${format}`);
      const pair = makeStreamPair(fn);
      this.readable = pair.readable;
      this.writable = pair.writable;
    }
  };
}

// ─── Now import the module under test ──────────────────────────────────────────

import {
  mimeTypesToAccept,
  checkMimeType,
  compress,
  decompress,
  createZip,
  extractZip,
  path,
  getMimeType,
  getExtension,
} from "./files";

// ==========================
// mimeTypesToAccept
// ==========================

describe("mimeTypesToAccept", () => {
  it("converts MIME types to accept string with extensions", () => {
    const result = mimeTypesToAccept("application/pdf");
    expect(result).toContain(".pdf");
    expect(result).toContain("application/pdf");
  });

  it("handles wildcard MIME types (image/*)", () => {
    const result = mimeTypesToAccept("image/*");
    // Wildcards are kept as-is, no extension expansion
    expect(result).toBe("image/*");
  });

  it("combines wildcards and specific types", () => {
    const result = mimeTypesToAccept("image/*,application/pdf");
    expect(result).toContain("image/*");
    expect(result).toContain(".pdf");
    expect(result).toContain("application/pdf");
  });

  it("handles unknown MIME types gracefully", () => {
    const result = mimeTypesToAccept("application/x-custom-unknown");
    // Unknown types are passed through without extension
    expect(result).toBe("application/x-custom-unknown");
  });

  it("deduplicates extensions", () => {
    // image/jpeg maps to .jpg; adding it twice should not duplicate
    const result = mimeTypesToAccept("image/jpeg,image/jpeg");
    const parts = result.split(",");
    const unique = new Set(parts);
    expect(parts.length).toBe(unique.size);
  });

  it("returns empty string for empty input", () => {
    expect(mimeTypesToAccept("")).toBe("");
  });

  it("resolves multiple MIME types to their extensions", () => {
    const result = mimeTypesToAccept("image/jpeg,image/png");
    expect(result).toContain(".jpg");
    expect(result).toContain(".png");
    expect(result).toContain("image/jpeg");
    expect(result).toContain("image/png");
  });
});

// ==========================
// checkMimeType
// ==========================

describe("checkMimeType", () => {
  it("matches exact MIME type", () => {
    expect(checkMimeType("application/pdf", "application/pdf")).toBe(true);
  });

  it("matches wildcard pattern (image/*)", () => {
    expect(checkMimeType("image/png", "image/*")).toBe(true);
    expect(checkMimeType("image/jpeg", "image/*")).toBe(true);
  });

  it("does not match wrong wildcard category", () => {
    expect(checkMimeType("audio/mpeg", "image/*")).toBe(false);
  });

  it("matches file extension (.pdf)", () => {
    // When the input is a MIME type string, .pdf should resolve to application/pdf
    expect(checkMimeType("application/pdf", ".pdf")).toBe(true);
  });

  it("returns false for non-matching type", () => {
    expect(checkMimeType("text/plain", "image/*")).toBe(false);
    expect(checkMimeType("application/pdf", "image/png")).toBe(false);
  });

  it("handles string input (MIME type string, not File)", () => {
    expect(checkMimeType("text/html", "text/*")).toBe(true);
    expect(checkMimeType("text/html", "text/html")).toBe(true);
    expect(checkMimeType("text/html", "application/json")).toBe(false);
  });

  it("returns true when accept is empty (everything accepted)", () => {
    expect(checkMimeType("anything/here", "")).toBe(true);
  });

  it("handles comma-separated accept list", () => {
    expect(checkMimeType("image/png", ".pdf,image/*")).toBe(true);
    expect(checkMimeType("application/pdf", ".pdf,image/*")).toBe(true);
    expect(checkMimeType("audio/mpeg", ".pdf,image/*")).toBe(false);
  });
});

// ==========================
// compress / decompress
// ==========================

describe("compress / decompress", () => {
  it("roundtrips small data", async () => {
    const original = new TextEncoder().encode("Hello, World!");
    const compressed = await compress(original);
    expect(compressed.length).toBeLessThanOrEqual(original.length + 20); // gzip has headers
    const decompressed = await decompress(compressed);
    expect(decompressed).toEqual(original);
  });

  it("roundtrips large data", async () => {
    // 64KB of repeated data (should compress well)
    const original = new Uint8Array(65536);
    for (let i = 0; i < original.length; i++) original[i] = i % 256;
    const compressed = await compress(original);
    expect(compressed.length).toBeLessThan(original.length);
    const decompressed = await decompress(compressed);
    expect(decompressed).toEqual(original);
  });

  it("roundtrips empty data", async () => {
    const empty = new Uint8Array(0);
    const compressed = await compress(empty);
    const decompressed = await decompress(compressed);
    expect(decompressed).toEqual(empty);
  });

  it("compressed data is smaller than original for repetitive content", async () => {
    const repetitive = new TextEncoder().encode("abcdefgh".repeat(10000));
    const compressed = await compress(repetitive);
    expect(compressed.length).toBeLessThan(repetitive.length / 10);
  });
});

// ==========================
// createZip / extractZip
// ==========================

describe("createZip / extractZip", () => {
  it("roundtrips single text file", async () => {
    const files = [{ filename: "hello.txt", source: "Hello, World!" }];
    const zip = await createZip(files);
    expect(zip).toBeInstanceOf(Uint8Array);
    expect(zip.length).toBeGreaterThan(0);

    const extracted = await extractZip(zip);
    expect(extracted.length).toBe(1);
    expect(extracted[0]!.filename).toBe("hello.txt");
    expect(new TextDecoder().decode(extracted[0]!.data)).toBe("Hello, World!");
  });

  it("roundtrips multiple files", async () => {
    const files = [
      { filename: "a.txt", source: "File A" },
      { filename: "b.txt", source: "File B" },
      { filename: "data/c.json", source: '{"key":"value"}' },
    ];
    const zip = await createZip(files);
    const extracted = await extractZip(zip);

    expect(extracted.length).toBe(3);
    expect(extracted.map((e) => e.filename).sort()).toEqual([
      "a.txt",
      "b.txt",
      "data/c.json",
    ]);
  });

  it("roundtrips binary data", async () => {
    const binaryData = new Uint8Array([0, 1, 2, 255, 254, 253]);
    const files = [{ filename: "binary.bin", source: binaryData }];
    const zip = await createZip(files);
    const extracted = await extractZip(zip);

    expect(extracted[0]!.data).toEqual(binaryData);
  });

  it("roundtrips large file", async () => {
    const large = new Uint8Array(100_000);
    for (let i = 0; i < large.length; i++) large[i] = i % 256;
    const files = [{ filename: "large.bin", source: large }];
    const zip = await createZip(files);
    const extracted = await extractZip(zip);

    expect(extracted[0]!.data).toEqual(large);
  });

  it("roundtrips empty file", async () => {
    const files = [{ filename: "empty.txt", source: "" }];
    const zip = await createZip(files);
    const extracted = await extractZip(zip);

    expect(extracted[0]!.data.length).toBe(0);
  });

  it("calls onProgress callback for createZip", async () => {
    const files = [
      { filename: "a.txt", source: "A" },
      { filename: "b.txt", source: "B" },
      { filename: "c.txt", source: "C" },
    ];
    const progress: { current: number; total: number; percent: number }[] = [];
    await createZip(files, { onProgress: (p) => progress.push({ ...p }) });

    expect(progress.length).toBe(3);
    expect(progress[0]!.current).toBe(1);
    expect(progress[0]!.total).toBe(3);
    expect(progress[2]!.percent).toBe(1);
  });

  it("calls onProgress callback for extractZip", async () => {
    const files = [
      { filename: "a.txt", source: "A" },
      { filename: "b.txt", source: "B" },
    ];
    const zip = await createZip(files);

    const progress: { current: number; total: number; percent: number }[] = [];
    await extractZip(zip, { onProgress: (p) => progress.push({ ...p }) });

    expect(progress.length).toBe(2);
    expect(progress[1]!.percent).toBe(1);
  });

  it("preserves file content across multiple files", async () => {
    const files = [
      { filename: "a.txt", source: "Content A" },
      { filename: "b.txt", source: "Content B" },
    ];
    const zip = await createZip(files);
    const extracted = await extractZip(zip);

    const map = new Map(extracted.map((e) => [e.filename, new TextDecoder().decode(e.data)]));
    expect(map.get("a.txt")).toBe("Content A");
    expect(map.get("b.txt")).toBe("Content B");
  });

  // Regression: Zip Slip protection at archive-creation time.
  it("rejects unsafe filenames during createZip", async () => {
    await expect(
      createZip([{ filename: "../escape.txt", source: "x" }]),
    ).rejects.toThrow(/refusing to add unsafe filename/);
    await expect(
      createZip([{ filename: "/abs.txt", source: "x" }]),
    ).rejects.toThrow();
    await expect(
      createZip([{ filename: "back\\slash.txt", source: "x" }]),
    ).rejects.toThrow();
  });

  // Regression: extractZip uses LOCAL header filename length (different
  // archives put extended timestamps in local extras). This test creates
  // a normal zip and just verifies it still extracts; a synthetic test
  // with mismatched lengths would require manual byte-poking.
  it("extracts archives whose local-header lengths may differ from CD", async () => {
    const zip = await createZip([{ filename: "ok.txt", source: "ok" }]);
    const extracted = await extractZip(zip);
    expect(extracted).toHaveLength(1);
    expect(new TextDecoder().decode(extracted[0]!.data)).toBe("ok");
  });

  // Regression: zip-bomb caps.
  it("rejects archives whose declared entry count exceeds maxEntries", async () => {
    const zip = await createZip([
      { filename: "a.txt", source: "1" },
      { filename: "b.txt", source: "2" },
    ]);
    await expect(extractZip(zip, { maxEntries: 1 })).rejects.toThrow(/declares.*entries/);
  });

  it("rejects extraction once total declared size exceeds maxBytes", async () => {
    const big = new Uint8Array(64).fill(65);
    const zip = await createZip([
      { filename: "a.bin", source: big },
      { filename: "b.bin", source: big },
    ]);
    await expect(extractZip(zip, { maxBytes: 100 })).rejects.toThrow(/maxBytes/);
  });

  // Regression: UTF-8 general-purpose bit (0x0800) is set on filenames so
  // standards-compliant unzip tools decode non-ASCII names correctly.
  it("sets the UTF-8 general-purpose flag on local + central headers", async () => {
    const zip = await createZip([{ filename: "ü.txt", source: "x" }]);
    // Local header GP flag is at offset 6 of the local file header; the
    // archive starts with the local header. setUint16 little-endian at
    // offset 6 → bytes [zip[6], zip[7]] = [0x00, 0x08] for 0x0800.
    expect(zip[6]).toBe(0x00);
    expect(zip[7]).toBe(0x08);
  });
});

// ==========================
// path
// ==========================

describe("path", () => {
  it("builds safe file paths from template", () => {
    const result = path`uploads/${"John Doe"}/${"my-file"}.txt`;
    expect(result).toContain("uploads/");
    expect(result).toContain(".txt");
    expect(result).not.toContain(" "); // spaces removed
  });

  it("lowercases segments", () => {
    const result = path`${"HELLO"}`;
    expect(result).toMatch(/^hello/);
  });

  it("replaces non-word characters with hyphens", () => {
    const result = path`${"hello world!@#"}`;
    expect(result).not.toMatch(/[!@# ]/);
  });

  it("produces deterministic output", () => {
    const a = path`data/${"user-input"}`;
    const b = path`data/${"user-input"}`;
    expect(a).toBe(b);
  });

  it("handles multiple segments", () => {
    const result = path`${"a"}/${"b"}/${"c"}`;
    const parts = result.split("/");
    expect(parts.length).toBe(3);
  });

  it("handles nested paths in interpolated values", () => {
    const result = path`${"dir/subdir"}`;
    // The slash inside the value creates separate sanitized segments
    expect(result.split("/").length).toBe(2);
  });
});

// ==========================
// getMimeType
// ==========================

describe("getMimeType", () => {
  it("returns MIME type for known extension", () => {
    expect(getMimeType("photo.jpg")).toBe("image/jpeg");
    expect(getMimeType("document.pdf")).toBe("application/pdf");
  });
  it("returns null for unknown extension", () => {
    expect(getMimeType("file.xyz123")).toBeNull();
  });
  it("handles bare extension without dot", () => {
    expect(getMimeType("png")).toBe("image/png");
  });
});

// ==========================
// getExtension
// ==========================

describe("getExtension", () => {
  it("returns extension for known MIME type", () => {
    expect(getExtension("image/jpeg")).toBe("jpg");
    expect(getExtension("application/pdf")).toBe("pdf");
  });
  it("returns null for unknown MIME type", () => {
    expect(getExtension("application/x-unknown-thing")).toBeNull();
  });
});
