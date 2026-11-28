import { describe, expect, test } from "bun:test";
import { detectImageType } from "./image-type";

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(parts.flatMap((part) => (typeof part === "string" ? Array.from(part, (char) => char.charCodeAt(0)) : part)));

describe("menu image type detection", () => {
  test("names each supported format by its signature", () => {
    expect(detectImageType(bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe("image/png");
    expect(detectImageType(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(detectImageType(bytes("GIF87a", [1]))).toBe("image/gif");
    expect(detectImageType(bytes("GIF89a", [1]))).toBe("image/gif");
    expect(detectImageType(bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 "))).toBe("image/webp");
  });

  test("names nothing else, also a near miss or a short file", () => {
    expect(detectImageType(bytes("<svg/>"))).toBeNull();
    expect(detectImageType(bytes("RIFF", [0, 0, 0, 0], "WAVE"))).toBeNull();
    expect(detectImageType(bytes("GIF90a"))).toBeNull();
    expect(detectImageType(bytes([0xff, 0xd8]))).toBeNull();
    expect(detectImageType(new Uint8Array())).toBeNull();
  });
});
