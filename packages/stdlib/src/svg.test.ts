import { describe, it, expect } from "bun:test";
import { generateSvgAvatar, parseWebpDataUrl } from "./svg";
import { toBase64 } from "./encoding";

// ==========================
// generateSvgAvatar
// ==========================

describe("generateSvgAvatar", () => {
  it("returns Uint8Array containing valid SVG", () => {
    const result = generateSvgAvatar("id", "ab");
    const svg = new TextDecoder().decode(result);
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  });

  it("includes uppercased initials from text", () => {
    const svg = new TextDecoder().decode(generateSvgAvatar("id", "ab"));
    expect(svg).toContain("AB");
  });

  it("takes only first 2 characters", () => {
    const svg = new TextDecoder().decode(generateSvgAvatar("id", "hello"));
    expect(svg).toContain("HE");
    expect(svg).not.toContain("HELLO");
  });

  it("is deterministic: same id produces same color", () => {
    const a = generateSvgAvatar("test", "ab");
    const b = generateSvgAvatar("test", "ab");
    expect(a).toEqual(b);
  });

  it("different ids produce different colors", () => {
    const a = new TextDecoder().decode(generateSvgAvatar("id1", "ab"));
    const b = new TextDecoder().decode(generateSvgAvatar("id2", "ab"));
    // Extract fill color from SVG
    const colorA = a.match(/fill="(#[0-9a-f]+)"/)?.[1];
    const colorB = b.match(/fill="(#[0-9a-f]+)"/)?.[1];
    expect(colorA).not.toBe(colorB);
  });

  it("handles empty text", () => {
    expect(() => generateSvgAvatar("id", "")).not.toThrow();
    const svg = new TextDecoder().decode(generateSvgAvatar("id", ""));
    expect(svg).toContain("<svg");
  });

  it("handles single character text", () => {
    const svg = new TextDecoder().decode(generateSvgAvatar("id", "A"));
    expect(svg).toContain("A");
  });

  it("escapes XML special characters in text", () => {
    const result = generateSvgAvatar("id", "<&");
    const svg = new TextDecoder().decode(result);
    expect(svg).not.toContain("<&");
    expect(svg).toContain("&lt;");
    expect(svg).toContain("&amp;");
    expect(svg).toContain("<svg");
  });
});

// ==========================
// parseWebpDataUrl
// ==========================

describe("parseWebpDataUrl", () => {
  it("extracts bytes from valid webp data URL", () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const dataUrl = `data:image/webp;base64,${toBase64(data)}`;
    const result = parseWebpDataUrl(dataUrl);
    expect(result).toEqual(data);
  });

  it("returns null for non-webp data URL", () => {
    expect(parseWebpDataUrl("data:image/png;base64,AAAA")).toBeNull();
  });

  it("returns null for malformed data URL", () => {
    expect(parseWebpDataUrl("not-a-data-url")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseWebpDataUrl("")).toBeNull();
  });
});
