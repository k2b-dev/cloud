import { describe, expect, test } from "bun:test";
import { isHeif } from "./formats";

const file = (name = "photo.bin", type = "") => new File([], name, { type });
export const ftyp = (major: string, compatible: string[] = []) => {
  const bytes = new Uint8Array(16 + compatible.length * 4);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set(new TextEncoder().encode(`ftyp${major}`), 4);
  compatible.forEach((brand, index) => bytes.set(new TextEncoder().encode(brand), 16 + index * 4));
  return bytes;
};

describe("HEIF recognition", () => {
  for (const type of ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"]) {
    test(type, () => expect(isHeif(file("photo", type))).toBe(true));
  }
  for (const extension of ["heic", "heif", "hif", "HEIC", "HeIf", "HIF"]) {
    test(extension, () => expect(isHeif(file(`photo.${extension}`))).toBe(true));
  }
  for (const major of ["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]) {
    test(`major ${major}`, () => expect(isHeif(file(), ftyp(major))).toBe(true));
  }
  for (const major of ["mif1", "msf1"]) {
    for (const compatible of ["heic", "heix", "hevc", "hevx"]) {
      test(`${major} with ${compatible}`, () => expect(isHeif(file(), ftyp(major, [compatible]))).toBe(true));
    }
  }
  test("AVIF and generic BMFF are not HEIF", () => {
    for (const bytes of [
      ftyp("avif", ["heic"]),
      ftyp("avis", ["heic"]),
      ftyp("mif1", ["avif", "heic"]),
      ftyp("mif1", ["avis"]),
      ftyp("mif1"),
      ftyp("mp42", ["heic"]),
    ]) {
      expect(isHeif(file(), bytes)).toBe(false);
    }
    expect(isHeif(file("photo.avif", "image/avif"))).toBe(false);
  });
  test("ignores truncated headers, other boxes, out-of-box and beyond-64-byte brands", () => {
    expect(isHeif(file(), new Uint8Array(15))).toBe(false);
    const bytes = ftyp("mif1", [...Array<string>(12).fill("jpeg"), "heic"]);
    expect(isHeif(file(), bytes)).toBe(false);
    const shortBox = ftyp("mif1", ["heic"]);
    new DataView(shortBox.buffer).setUint32(0, 16);
    expect(isHeif(file(), shortBox)).toBe(false);
    new DataView(shortBox.buffer).setUint32(0, 8);
    expect(isHeif(file(), shortBox)).toBe(false);
    const otherBox = ftyp("heic");
    otherBox[4] = 0;
    expect(isHeif(file(), otherBox)).toBe(false);
  });
});
