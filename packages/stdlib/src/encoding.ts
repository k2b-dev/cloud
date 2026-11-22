//====================================
// COMMON UTILITIES
//====================================

// Base32 alphabet (RFC 4648)
const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const base32ReverseMap = new Map<string, number>();

// Initialize base32ReverseMap
for (let i = 0; i < base32Alphabet.length; i++) {
  base32ReverseMap.set(base32Alphabet[i]!, i);
}

// Check if native hex functions are available
const hasHexBuiltin = (() => typeof Uint8Array.prototype.toHex === "function" && typeof Uint8Array.fromHex === "function")();

//====================================
// BASE 64
//====================================

/**
 * Converts bytes to a standard Base64 string.
 *
 * Uses `Buffer` on Node.js for maximum speed. In the browser, processes data
 * in 32 KB chunks via `String.fromCharCode` + `btoa` to avoid stack overflows
 * on large inputs.
 *
 * @param bytes - Raw bytes to encode
 */
export function toBase64(bytes: Uint8Array): string {
  // Node.js - use Buffer (fastest)
  if (typeof globalThis.Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  // Browser - chunked processing for large data
  const CHUNK_SIZE = 0x8000; // 32KB chunks to avoid stack overflow
  let binary = "";

  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

/**
 * Decodes a standard Base64 string back to bytes.
 *
 * Uses `Buffer` on Node.js; falls back to `atob` in the browser.
 *
 * @param base64 - Base64-encoded string
 * @throws (via `atob` / `Buffer`) if the input contains invalid Base64 characters
 */
export function fromBase64(base64: string): Uint8Array {
  // Node.js - use Buffer (fastest)
  if (typeof globalThis.Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(base64, "base64"));
  }

  // Browser - optimized version
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

/**
 * Strict variant of {@link fromBase64} that validates input format before
 * decoding. Throws `TypeError` for invalid characters, wrong length,
 * misplaced padding, or stray data after `=`.
 *
 * Use this when the input is untrusted (e.g. user-supplied) and you want
 * cross-runtime parity — Node.js / Bun's `Buffer.from(s, "base64")` silently
 * accepts garbage that browsers' `atob` rejects.
 *
 * @example
 * fromBase64Strict("SGVsbG8="); // valid → Uint8Array of "Hello"
 * fromBase64Strict("SGVsbG8=!"); // throws TypeError
 */
export function fromBase64Strict(base64: string): Uint8Array {
  // Allow standard or URL-safe alphabet, with optional `=` padding only at
  // the end. Reject any other characters (whitespace included).
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(base64)) {
    throw new TypeError("fromBase64Strict: invalid Base64 input");
  }
  // Length must be a multiple of 4 once padding is counted.
  if (base64.length % 4 !== 0) {
    throw new TypeError("fromBase64Strict: input length is not a multiple of 4");
  }
  // Normalize URL-safe alphabet so the underlying decoder accepts it.
  const standard = base64.replace(/-/g, "+").replace(/_/g, "/");
  return fromBase64(standard);
}

//====================================
// HEX
//====================================

/**
 * Converts bytes to a lowercase hexadecimal string with no "0x" prefix.
 * Uses the native `Uint8Array.prototype.toHex` when available (e.g. modern runtimes);
 * otherwise falls back to a manual loop.
 *
 * @param bytes - Raw bytes to encode
 * @example toHex(new Uint8Array([0xca, 0xfe])); // "cafe"
 */
export function toHex(bytes: Uint8Array): string {
  if (hasHexBuiltin) return bytes.toHex();

  const hex: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    hex.push(bytes[i]!.toString(16).padStart(2, "0"));
  }
  return hex.join("");
}

/**
 * Decodes a hexadecimal string (case-insensitive, no "0x" prefix) to bytes.
 * Uses the native `Uint8Array.fromHex` when available; otherwise parses manually.
 *
 * @param hex - Hex-encoded string (must have even length)
 * @throws If the string has odd length ("unpadded hex string") or contains non-hex characters
 */
export function fromHex(hex: string): Uint8Array {
  if (hasHexBuiltin) return Uint8Array.fromHex(hex);

  if (hex.length % 2) throw new Error("unpadded hex string");

  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error("invalid hex characters");

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

//====================================
// BASE 32
//====================================

/**
 * Encodes bytes to an RFC 4648 Base32 string (uppercase alphabet A-Z, 2-7).
 * Output includes "=" padding to a multiple of 8 characters.
 *
 * @param bytes - Raw bytes to encode
 */
export function toBase32(bytes: Uint8Array): string {
  let result = "";
  let buffer = 0;
  let bufferBits = 0;

  for (let i = 0; i < bytes.length; i++) {
    buffer = (buffer << 8) | bytes[i]!;
    bufferBits += 8;

    while (bufferBits >= 5) {
      const index = (buffer >> (bufferBits - 5)) & 0x1f;
      result += base32Alphabet[index];
      bufferBits -= 5;
    }
  }

  // Handle remaining bits
  if (bufferBits > 0) {
    const index = (buffer << (5 - bufferBits)) & 0x1f;
    result += base32Alphabet[index];
  }

  // Add padding if needed
  const padding = (8 - (result.length % 8)) % 8;
  result += "=".repeat(padding);

  return result;
}

/**
 * Decodes an RFC 4648 Base32 string to bytes. Case-insensitive; padding ("=") is optional.
 *
 * @param base32 - Base32-encoded string
 * @throws If the input contains characters outside the Base32 alphabet (A-Z, 2-7, =)
 */
export function fromBase32(base32: string): Uint8Array {
  // Remove any padding and convert to uppercase
  const normalized = base32.toUpperCase().replace(/=/g, "");

  // Decode Base32
  const bytes: number[] = [];
  let buffer = 0;
  let bufferBits = 0;

  for (let i = 0; i < normalized.length; i++) {
    const value = base32ReverseMap.get(normalized[i]!);
    if (value === undefined) throw new Error(`invalid base32 character: ${normalized[i]}`);

    buffer = (buffer << 5) | value;
    bufferBits += 5;

    while (bufferBits >= 8) {
      bytes.push((buffer >> (bufferBits - 8)) & 0xff);
      bufferBits -= 8;
    }
  }

  return new Uint8Array(bytes);
}

const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Encode a non-negative integer as a Base62 string.
 *
 * Uses digits 0-9, A-Z, a-z (62 characters). Useful for compact,
 * URL-safe identifiers and short tokens.
 *
 * @param num - Non-negative integer to encode.
 * @param minLength - Minimum output length, zero-padded if shorter (default: 1).
 * @returns Base62 encoded string.
 * @throws If num is negative or not a safe integer.
 */
export const toBase62 = (num: number, minLength: number = 1): string => {
  if (!Number.isSafeInteger(num) || num < 0) throw new Error("toBase62 requires a non-negative safe integer");
  if (num === 0) return "0".padStart(minLength, "0");
  let result = "";
  let n = num;
  while (n > 0) {
    result = BASE62_CHARS[n % 62]! + result;
    n = Math.floor(n / 62);
  }
  return result.padStart(minLength, "0");
};

/**
 * Decode a Base62 string back to a non-negative integer.
 *
 * @param str - Base62 encoded string (digits 0-9, A-Z, a-z).
 * @returns Decoded non-negative integer.
 * @throws If string contains invalid characters.
 */
export const fromBase62 = (str: string): number => {
  let result = 0;
  for (const char of str) {
    const idx = BASE62_CHARS.indexOf(char);
    if (idx === -1) throw new Error(`invalid base62 character: ${char}`);
    result = result * 62 + idx;
  }
  return result;
};

/**
 * Convenience namespace re-exporting all encoding/decoding functions.
 * Each function is also available as a named export.
 */
export const encoding = {
  fromBase64Strict,
  toBase64,
  fromBase64,
  toHex,
  fromHex,
  toBase32,
  fromBase32,
  toBase62,
  fromBase62,
} as const;
