import { describe, expect, test } from "bun:test";
import { normalizeAiFilePath, pickStoredAiFilePath } from "./files-store";

const nfd = "/Anlagevermo\u0308gen.pdf";
const nfc = "/Anlageverm\u00f6gen.pdf";

describe("normalizeAiFilePath", () => {
  test("accepts absolute clean paths and rejects traversal", () => {
    expect(normalizeAiFilePath("/a.txt")).toBe("/a.txt");
    expect(normalizeAiFilePath("/notes//b/./c.txt")).toBe("/notes/b/c.txt");
    expect(normalizeAiFilePath("relative.txt")).toBeNull();
    expect(normalizeAiFilePath("/notes/../etc/passwd")).toBeNull();
    expect(normalizeAiFilePath("/report\nignore.md")).toBeNull();
    expect(normalizeAiFilePath("/")).toBeNull();
  });

  test("normalizes Unicode to NFC in every segment", () => {
    expect(nfd).not.toBe(nfc);
    expect(normalizeAiFilePath(nfd)).toBe(nfc);
    expect(normalizeAiFilePath(nfc)).toBe(nfc);
    expect(normalizeAiFilePath("/Beru\u0308cksichtigung/Anlagevermo\u0308gen.pdf")).toBe("/Ber\u00fccksichtigung/Anlageverm\u00f6gen.pdf");
    expect(normalizeAiFilePath("/\u0308/../x")).toBeNull();
    expect(normalizeAiFilePath("/a\u0308\nb")).toBeNull();
  });
});

describe("pickStoredAiFilePath", () => {
  test("prefers the exact row, then a single equivalent row, and refuses to guess", () => {
    expect(pickStoredAiFilePath([], nfc)).toBe(nfc);
    expect(pickStoredAiFilePath([{ path: nfd }, { path: nfc }], nfc)).toBe(nfc);
    expect(pickStoredAiFilePath([{ path: nfd }], nfc)).toBe(nfd);
    expect(() => pickStoredAiFilePath([{ path: "/a\u0308\u0304" }, { path: "/\u00e4\u0304" }], "/\u01df")).toThrow(
      "Ambiguous file path /\\u{1df}: several stored files only differ in Unicode form (/a\\u{308}\\u{304}, /\\u{e4}\\u{304})",
    );
  });
});
