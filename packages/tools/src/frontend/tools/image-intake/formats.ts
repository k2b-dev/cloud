export const IMAGE_ACCEPT = "image/*,.jpg,.jpeg,.png,.webp,.gif,.bmp,.svg,.avif,.heic,.heif";

// A 48 MP iPhone HEIF Max fits; 50 MP RGBA is ~200 MB, held in wasm, ImageData and canvas.
export const HEIF_MAX_PIXELS = 50_000_000;
// A 48 MP phone HEIF is ~5–15 MB; much larger inputs would only grow the wasm heap.
export const HEIF_MAX_BYTES = 64 * 1024 * 1024;

const hevcBrands = new Set(["heic", "heix", "hevc", "hevx"]);
const heifBrands = new Set([...hevcBrands, "heim", "heis", "hevm", "hevs"]);

export function isHeif(file: File, head?: Uint8Array): boolean {
  if (/^image\/(heic|heif|heic-sequence|heif-sequence)$/iu.test(file.type) || /\.(heic|heif|hif)$/iu.test(file.name)) return true;
  if (!head || head.length < 16) return false;
  const bytes = head.subarray(0, 64);
  const brand = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (brand(4) !== "ftyp") return false;
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (size !== 0 && size < 16) return false;
  const major = brand(8);
  if (major === "avif" || major === "avis") return false;
  if (heifBrands.has(major)) return true;
  if (major !== "mif1" && major !== "msf1") return false;
  const compatible: string[] = [];
  for (let offset = 16; offset + 4 <= Math.min(size || bytes.length, bytes.length); offset += 4) compatible.push(brand(offset));
  return !compatible.includes("avif") && !compatible.includes("avis") && compatible.some((value) => hevcBrands.has(value));
}
