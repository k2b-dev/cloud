import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocumentZipBoundError, DocumentZipWriter, zipEntryOverheadBytes, zipMethodForMediaType } from "./document-zip-archive";
import { readZipArchive } from "./document-zip-test-reader";

const collect = () => {
  const chunks: Uint8Array[] = [];
  const sink = async (bytes: Uint8Array) => {
    chunks.push(Uint8Array.from(bytes));
  };
  const archive = () => {
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  };
  return { chunks, sink, archive };
};

describe("DocumentZipWriter", () => {
  test("stores and deflates entries that an independent reader and unzip accept", async () => {
    const { chunks, sink, archive } = collect();
    const writer = new DocumentZipWriter(new Date("2026-09-22T10:20:30Z"), sink);
    const pdf = new TextEncoder().encode("%PDF-1.7\n% binary content that stays verbatim\n");
    const csv = new TextEncoder().encode("id;amount\n".repeat(5_000));
    const random = new Uint8Array(70_000);
    crypto.getRandomValues(random);
    await writer.add("invoices/Rechnung Müller.pdf", pdf, zipMethodForMediaType("application/pdf"));
    await writer.add("payments.csv", csv, zipMethodForMediaType("text/csv"));
    await writer.add("noise.bin", random, zipMethodForMediaType("application/octet-stream"));
    const finished = await writer.finish();
    const bytes = archive();
    expect(finished).toEqual({ sizeBytes: bytes.byteLength, entryCount: 3 });
    expect(chunks.every((chunk) => chunk.byteLength <= 1024 * 1024)).toBe(true);
    expect(writer.entries.map((entry) => entry.method)).toEqual(["store", "deflate", "store"]);
    expect(writer.entries[1]!.compressedBytes).toBeLessThan(csv.byteLength);

    const entries = readZipArchive(bytes);
    expect(entries.map((entry) => [entry.path, entry.method])).toEqual([
      ["invoices/Rechnung Müller.pdf", 0],
      ["payments.csv", 8],
      ["noise.bin", 0],
    ]);
    expect(entries[0]!.bytes).toEqual(pdf);
    expect(entries[1]!.bytes).toEqual(csv);
    expect(entries[2]!.bytes).toEqual(random);

    const unzip = Bun.which("unzip");
    if (unzip) {
      const directory = await mkdtemp(join(tmpdir(), "grids-zip-"));
      try {
        const path = join(directory, "archive.zip");
        await Bun.write(path, bytes);
        const check = Bun.spawn([unzip, "-t", path], { stdout: "pipe", stderr: "pipe" });
        const output = await new Response(check.stdout).text();
        expect(await check.exited, output).toBe(0);
        expect(output).toContain("No errors detected");
      } finally {
        await rm(directory, { recursive: true });
      }
    }
  });

  test("rejects unsafe paths and enforces entry and byte bounds without partial output", async () => {
    const { sink } = collect();
    const writer = new DocumentZipWriter(new Date(), sink, { maxEntries: 2, maxBytes: 400 });
    for (const path of ["", "/abs.pdf", "a\\b.pdf", "../x.pdf", "dir//x.pdf", "bad\u0000.pdf", "x/./y.pdf"]) {
      await expect(writer.add(path, new Uint8Array(1), "store")).rejects.toThrow("Unsafe archive path");
    }
    await writer.add("one.pdf", new Uint8Array(10), "store");
    await writer.add("two.pdf", new Uint8Array(10), "store");
    await expect(writer.add("three.pdf", new Uint8Array(10), "store")).rejects.toBeInstanceOf(DocumentZipBoundError);
    const bounded = new DocumentZipWriter(new Date(), sink, { maxEntries: 5, maxBytes: 100 });
    await expect(bounded.add("big.pdf", new Uint8Array(200), "store")).rejects.toMatchObject({ bound: "bytes", limit: 100 });
  });

  test("entry overhead bound covers headers, names and the end record", async () => {
    const { sink, archive } = collect();
    const writer = new DocumentZipWriter(new Date(), sink);
    const paths = ["a.pdf", "folder/äöü.pdf", "x".repeat(200)];
    let bound = 22;
    for (const path of paths) {
      await writer.add(path, new Uint8Array(33), "store");
      bound += 33 + zipEntryOverheadBytes(path);
    }
    await writer.finish();
    expect(archive().byteLength).toBe(bound);
  });

  test("classifies media types", () => {
    expect(zipMethodForMediaType("application/pdf")).toBe("store");
    expect(zipMethodForMediaType("IMAGE/JPEG")).toBe("store");
    expect(zipMethodForMediaType("video/mp4")).toBe("store");
    expect(zipMethodForMediaType("text/csv")).toBe("deflate");
    expect(zipMethodForMediaType("application/xml")).toBe("deflate");
  });
});
