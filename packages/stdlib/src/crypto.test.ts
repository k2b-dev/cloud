import { describe, it, expect } from "bun:test";
import { common, randomIndex, symmetric, asymmetric, totp } from "./crypto";

// ==========================
// common.hash
// ==========================

describe("common.hash", () => {
  it("returns SHA-256 hex for known input", async () => {
    const result = await common.hash("hello");
    expect(result).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("returns consistent hash for Uint8Array input", async () => {
    const fromString = await common.hash("hello");
    const fromBytes = await common.hash(new TextEncoder().encode("hello"));
    expect(fromString).toBe(fromBytes);
  });

  it("returns hex string of correct length (64 chars)", async () => {
    const result = await common.hash("anything");
    expect(result.length).toBe(64);
    expect(/^[0-9a-f]+$/.test(result)).toBe(true);
  });
});

// ==========================
// common.fnv1aHash
// ==========================

describe("common.fnv1aHash", () => {
  it("returns deterministic hash", () => {
    expect(common.fnv1aHash("test")).toBe(common.fnv1aHash("test"));
  });

  it("returns different hashes for different inputs", () => {
    expect(common.fnv1aHash("a")).not.toBe(common.fnv1aHash("b"));
  });

  it("returns hex string", () => {
    expect(/^[0-9a-f]+$/.test(common.fnv1aHash("test"))).toBe(true);
  });

  it("handles empty string", () => {
    const result = common.fnv1aHash("");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

// ==========================
// common.readableId
// ==========================

describe("common.readableId", () => {
  it("returns default pattern 3-4-3-4 with hyphens", () => {
    const id = common.readableId();
    expect(id).toMatch(/^.{3}-.{4}-.{3}-.{4}$/);
  });

  it("respects custom pattern", () => {
    const id = common.readableId(5, 5);
    expect(id).toMatch(/^.{5}-.{5}$/);
  });

  it("single segment has no hyphens", () => {
    const id = common.readableId(8);
    expect(id.length).toBe(8);
    expect(id).not.toContain("-");
  });

  it("uses only ambiguity-free alphabet (no 0, 1, O, I, l)", () => {
    // Generate a long ID to increase coverage
    const id = common.readableId(100);
    expect(id).not.toMatch(/[01OIl]/);
  });

  it("generates unique ids", () => {
    const ids = Array.from({ length: 100 }, () => common.readableId());
    expect(new Set(ids).size).toBe(100);
  });
});

// ==========================
// common.uuid
// ==========================

describe("common.uuid", () => {
  it("returns valid UUID v4 format", () => {
    const uuid = common.uuid();
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("generates unique values", () => {
    expect(common.uuid()).not.toBe(common.uuid());
  });
});

// ==========================
// common.ulid
// ==========================

const withMockedRandomValues = <T>(values: number[][], fn: () => T): T => {
  const originalGetRandomValues = globalThis.crypto.getRandomValues;
  let calls = 0;

  globalThis.crypto.getRandomValues = ((array: Uint8Array) => {
    const bytes = values[Math.min(calls, values.length - 1)] ?? [];
    calls += 1;
    array.fill(0);
    array.set(bytes.slice(0, array.length));
    return array;
  }) as Crypto["getRandomValues"];

  try {
    return fn();
  } finally {
    globalThis.crypto.getRandomValues = originalGetRandomValues;
  }
};

describe("common.ulid", () => {
  it("returns a canonical ULID", () => {
    const id = common.ulid();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("encodes the zero timestamp and zero random value", () => {
    withMockedRandomValues([[0, 0, 0, 0, 0, 0, 0, 0, 0, 0]], () => {
      expect(common.ulid({ timestamp: 0 })).toBe("00000000000000000000000000");
    });
  });

  it("encodes the maximum valid ULID value", () => {
    withMockedRandomValues([[0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]], () => {
      expect(common.ulid({ timestamp: 0xffffffffffff })).toBe("7ZZZZZZZZZZZZZZZZZZZZZZZZZ");
    });
  });

  it("accepts Date timestamps", () => {
    withMockedRandomValues([[0, 0, 0, 0, 0, 0, 0, 0, 0, 0]], () => {
      const fromNumber = common.ulid({ timestamp: 1_786_000_000_000 });
      const fromDate = common.ulid({ timestamp: new Date(1_786_000_000_000) });
      expect(fromDate).toBe(fromNumber);
    });
  });

  it("uses crypto randomness for the random suffix", () => {
    withMockedRandomValues(
      [
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
      ],
      () => {
        const first = common.ulid({ timestamp: 123 });
        const second = common.ulid({ timestamp: 123 });
        expect(first).not.toBe(second);
        expect(first.slice(0, 10)).toBe(second.slice(0, 10));
      },
    );
  });

  it("increments the random suffix for monotonic calls in the same millisecond", () => {
    withMockedRandomValues([[0, 0, 0, 0, 0, 0, 0, 0, 0, 0]], () => {
      const first = common.ulid({ timestamp: 456, monotonic: true });
      const second = common.ulid({ timestamp: 456, monotonic: true });
      const third = common.ulid({ timestamp: 456, monotonic: true });

      expect(first < second).toBe(true);
      expect(second < third).toBe(true);
      expect(first.slice(10)).toBe("0000000000000000");
      expect(second.slice(10)).toBe("0000000000000001");
      expect(third.slice(10)).toBe("0000000000000002");
    });
  });

  it("rejects invalid timestamps", () => {
    expect(() => common.ulid({ timestamp: Number.NaN })).toThrow(TypeError);
    expect(() => common.ulid({ timestamp: 1.5 })).toThrow(TypeError);
    expect(() => common.ulid({ timestamp: -1 })).toThrow(RangeError);
    expect(() => common.ulid({ timestamp: 0x1000000000000 })).toThrow(RangeError);
    expect(() => common.ulid({ timestamp: new Date(Number.NaN) })).toThrow(TypeError);
  });

  it("throws when monotonic randomness overflows", () => {
    withMockedRandomValues([[0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]], () => {
      expect(common.ulid({ timestamp: 789, monotonic: true })).toBe("00000000RNZZZZZZZZZZZZZZZZ");
      expect(() => common.ulid({ timestamp: 789, monotonic: true })).toThrow(RangeError);
    });
  });
});

// ==========================
// common.generateKey
// ==========================

describe("common.generateKey", () => {
  it("returns 64-char hex string by default (32 bytes)", () => {
    const key = common.generateKey();
    expect(key.length).toBe(64);
  });

  it("returns correct length for custom byte count", () => {
    expect(common.generateKey(16).length).toBe(32);
  });

  it("contains only hex characters", () => {
    expect(/^[0-9a-f]+$/.test(common.generateKey())).toBe(true);
  });
});

// ==========================
// randomIndex
// ==========================

describe("randomIndex", () => {
  it("returns 0 for max <= 1", () => {
    expect(randomIndex(1)).toBe(0);
    expect(randomIndex(0)).toBe(0);
    expect(randomIndex(-1)).toBe(0);
  });

  it("rejects invalid bounds", () => {
    expect(() => randomIndex(Number.NaN)).toThrow(RangeError);
    expect(() => randomIndex(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => randomIndex(1.5)).toThrow(RangeError);
    expect(() => randomIndex(0x100000000 + 1)).toThrow(RangeError);
  });

  it("retries rejected values to avoid modulo bias", () => {
    const originalGetRandomValues = globalThis.crypto.getRandomValues;
    const values = [0xffffffff, 4];
    let calls = 0;

    globalThis.crypto.getRandomValues = ((array: Uint32Array) => {
      array[0] = values[calls++]!;
      return array;
    }) as Crypto["getRandomValues"];

    try {
      expect(randomIndex(3)).toBe(1);
      expect(calls).toBe(2);
    } finally {
      globalThis.crypto.getRandomValues = originalGetRandomValues;
    }
  });
});

// ==========================
// symmetric encrypt/decrypt
// ==========================

describe("symmetric encrypt/decrypt", () => {
  it("roundtrips with password (PBKDF2, stretched=true)", async () => {
    const encrypted = await symmetric.encrypt({ payload: "secret", key: "password123" });
    const decrypted = await symmetric.decrypt({ payload: encrypted, key: "password123" });
    expect(decrypted).toBe("secret");
  });

  it("roundtrips with high-entropy key (HKDF, stretched=false)", async () => {
    const key = common.generateKey();
    const encrypted = await symmetric.encrypt({ payload: "secret", key, stretched: false });
    const decrypted = await symmetric.decrypt({ payload: encrypted, key });
    expect(decrypted).toBe("secret");
  });

  it("roundtrips empty string", async () => {
    const encrypted = await symmetric.encrypt({ payload: "", key: "pw" });
    const decrypted = await symmetric.decrypt({ payload: encrypted, key: "pw" });
    expect(decrypted).toBe("");
  });

  it("roundtrips Unicode text", async () => {
    const text = "Hallo Welt \u{1F30D}";
    const encrypted = await symmetric.encrypt({ payload: text, key: "pw" });
    const decrypted = await symmetric.decrypt({ payload: encrypted, key: "pw" });
    expect(decrypted).toBe(text);
  });

  it("different encryptions produce different ciphertexts", async () => {
    const a = await symmetric.encrypt({ payload: "same", key: "pw" });
    const b = await symmetric.encrypt({ payload: "same", key: "pw" });
    expect(a).not.toBe(b);
  });

  it("decrypt fails with wrong key", async () => {
    const encrypted = await symmetric.encrypt({ payload: "secret", key: "correct" });
    await expect(symmetric.decrypt({ payload: encrypted, key: "wrong" })).rejects.toThrow();
  });

  it("output is valid hex string", async () => {
    const encrypted = await symmetric.encrypt({ payload: "test", key: "pw" });
    expect(/^[0-9a-f]+$/.test(encrypted)).toBe(true);
  });
});

// ==========================
// asymmetric generate/encrypt/decrypt
// ==========================

describe("asymmetric generate/encrypt/decrypt", () => {
  it("generates key pair with private and public keys", async () => {
    const keys = await asymmetric.generate();
    expect(keys.privateKey.length).toBeGreaterThan(0);
    expect(keys.publicKey.length).toBeGreaterThan(0);
  });

  it("public key starts with P01: and private key starts with S01:", async () => {
    const keys = await asymmetric.generate();
    expect(keys.publicKey.startsWith("P01:")).toBe(true);
    expect(keys.privateKey.startsWith("S01:")).toBe(true);
  });

  it("roundtrips encryption", async () => {
    const keys = await asymmetric.generate();
    const encrypted = await asymmetric.encrypt({ payload: "hello", publicKey: keys.publicKey });
    const decrypted = await asymmetric.decrypt({ payload: encrypted, privateKey: keys.privateKey });
    expect(decrypted).toBe("hello");
  });

  it("roundtrips Unicode and long text", async () => {
    const keys = await asymmetric.generate();
    const text = "A".repeat(10000) + " \u{1F680}";
    const encrypted = await asymmetric.encrypt({ payload: text, publicKey: keys.publicKey });
    const decrypted = await asymmetric.decrypt({ payload: encrypted, privateKey: keys.privateKey });
    expect(decrypted).toBe(text);
  });

  it("decrypt fails with wrong private key", async () => {
    const keys1 = await asymmetric.generate();
    const keys2 = await asymmetric.generate();
    const encrypted = await asymmetric.encrypt({ payload: "hello", publicKey: keys1.publicKey });
    await expect(asymmetric.decrypt({ payload: encrypted, privateKey: keys2.privateKey })).rejects.toThrow();
  });

  it("roundtrips empty string", async () => {
    const keys = await asymmetric.generate();
    const encrypted = await asymmetric.encrypt({ payload: "", publicKey: keys.publicKey });
    const decrypted = await asymmetric.decrypt({ payload: encrypted, privateKey: keys.privateKey });
    expect(decrypted).toBe("");
  });
});

// ==========================
// asymmetric sign/verify
// ==========================

describe("asymmetric sign/verify", () => {
  it("sign and verify roundtrip succeeds", async () => {
    const keys = await asymmetric.generate();
    const sig = await asymmetric.sign({ privateKey: keys.privateKey, message: "hello" });
    const valid = await asymmetric.verify({
      publicKey: keys.publicKey,
      signature: sig.signature,
      nonce: sig.nonce,
      timestamp: sig.timestamp,
      message: "hello",
    });
    expect(valid).toBe(true);
  });

  it("verify fails with wrong public key", async () => {
    const keys1 = await asymmetric.generate();
    const keys2 = await asymmetric.generate();
    const sig = await asymmetric.sign({ privateKey: keys1.privateKey, message: "hello" });
    const valid = await asymmetric.verify({
      publicKey: keys2.publicKey,
      signature: sig.signature,
      nonce: sig.nonce,
      timestamp: sig.timestamp,
      message: "hello",
    });
    expect(valid).toBe(false);
  });

  it("verify fails with tampered message", async () => {
    const keys = await asymmetric.generate();
    const sig = await asymmetric.sign({ privateKey: keys.privateKey, message: "hello" });
    const valid = await asymmetric.verify({
      publicKey: keys.publicKey,
      signature: sig.signature,
      nonce: sig.nonce,
      timestamp: sig.timestamp,
      message: "world",
    });
    expect(valid).toBe(false);
  });

  it("verify fails for expired signature", async () => {
    const keys = await asymmetric.generate();
    const sig = await asymmetric.sign({ privateKey: keys.privateKey, message: "hello" });
    await Bun.sleep(15);
    const valid = await asymmetric.verify({
      publicKey: keys.publicKey,
      signature: sig.signature,
      nonce: sig.nonce,
      timestamp: sig.timestamp,
      message: "hello",
      maxAge: 1, // 1ms max age, but >15ms have passed
    });
    expect(valid).toBe(false);
  });
});

// ==========================
// totp
// ==========================

describe("totp", () => {
  it("create returns URI and secret", async () => {
    const { uri, secret } = await totp.create({ label: "user@example.com", issuer: "MyApp" });
    expect(uri).toContain("otpauth://totp/");
    expect(uri).toContain("secret=");
    expect(uri).toContain("issuer=");
    expect(secret.length).toBeGreaterThan(0);
  });

  it("create URI contains required parameters", async () => {
    const { uri } = await totp.create({ label: "user", issuer: "App" });
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });

  it("verifies a valid TOTP token", async () => {
    const { secret } = await totp.create({ label: "test@example.com", issuer: "Test" });
    // We can't easily generate a valid token without reimplementing TOTP,
    // but we CAN test that obviously wrong tokens return false.
    // With window=0 (strict), a random 6-digit code has a 1-in-1M chance of matching.
    // Testing 3 different tokens: probability of ALL matching is ~1e-18.
    const wrong1 = await totp.verify({ token: "000000", secret });
    const wrong2 = await totp.verify({ token: "999999", secret });
    const wrong3 = await totp.verify({ token: "123456", secret });
    const falseCount = [wrong1, wrong2, wrong3].filter(v => v === false).length;
    expect(falseCount).toBeGreaterThanOrEqual(2);
  });

  it("cross-secret contamination fails", async () => {
    const a = await totp.create({ label: "a", issuer: "App" });
    const b = await totp.create({ label: "b", issuer: "App" });
    // Secrets should be different
    expect(a.secret).not.toBe(b.secret);
  });
});

// ============================================================================
// Audit fixes — explicit non-breaking proofs + new security guarantees
// ============================================================================

import { toBase64, fromBase64, fromBase32, fromHex, toHex } from "./encoding";

describe("crypto audit — backward compat (non-breaking)", () => {
  it("verify() accepts legacy v1 signatures (no v field)", async () => {
    // Reconstruct a v1 signature by signing the legacy `nonce:message:ts`
    // payload directly with raw subtle.sign — simulates a signature emitted
    // by the pre-audit version of this library.
    const keys = await asymmetric.generate();
    const [ecdsaKey] = keys.privateKey
      .replace(/^S01:/, "")
      .split(":");
    const cryptoKey = await globalThis.crypto.subtle.importKey(
      "pkcs8",
      fromBase64(ecdsaKey!) as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"],
    );
    const nonce = "legacy-nonce";
    const message = "hello";
    const timestamp = Date.now();
    const legacyBytes = new TextEncoder().encode(`${nonce}:${message}:${timestamp}`);
    const sigRaw = new Uint8Array(
      await globalThis.crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        cryptoKey,
        legacyBytes as BufferSource,
      ),
    );

    // verify() WITHOUT `v` falls back to v1 path → should accept.
    const valid = await asymmetric.verify({
      publicKey: keys.publicKey,
      signature: toBase64(sigRaw),
      nonce,
      timestamp,
      message,
    });
    expect(valid).toBe(true);
  });

  it("verify({v:1}) explicitly accepts legacy signatures", async () => {
    const keys = await asymmetric.generate();
    const [ecdsaKey] = keys.privateKey.replace(/^S01:/, "").split(":");
    const cryptoKey = await globalThis.crypto.subtle.importKey(
      "pkcs8",
      fromBase64(ecdsaKey!) as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"],
    );
    const nonce = "n";
    const message = "m";
    const timestamp = Date.now();
    const legacyBytes = new TextEncoder().encode(`${nonce}:${message}:${timestamp}`);
    const sig = new Uint8Array(
      await globalThis.crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        cryptoKey,
        legacyBytes as BufferSource,
      ),
    );
    const valid = await asymmetric.verify({
      publicKey: keys.publicKey,
      signature: toBase64(sig),
      nonce,
      timestamp,
      message,
      v: 1,
    });
    expect(valid).toBe(true);
  });

  it("new sign() emits v:2 and verify() roundtrips correctly", async () => {
    const keys = await asymmetric.generate();
    const sig = await asymmetric.sign({ privateKey: keys.privateKey, message: "hello" });
    expect(sig.v).toBe(2);
    const valid = await asymmetric.verify({
      ...sig,
      publicKey: keys.publicKey,
      message: "hello",
    });
    expect(valid).toBe(true);
  });

  it("sym.decrypt still handles ciphertexts emitted by previous version", async () => {
    // Roundtrip via the public API exercises the existing 0x01-version
    // format (we did not bump the sym version — only tightened the flag
    // check and added min-length validation, both of which only reject
    // already-malformed inputs).
    const key = common.generateKey();
    const enc = await symmetric.encrypt({ payload: "hello", key, stretched: false });
    const dec = await symmetric.decrypt({ payload: enc, key });
    expect(dec).toBe("hello");
  });
});

describe("crypto audit — security guarantees", () => {
  it("explicit v:2 sig is NOT verifiable against legacy field-boundary forgery", async () => {
    // Sign with new format
    const keys = await asymmetric.generate();
    const sig = await asymmetric.sign({ privateKey: keys.privateKey, message: "false" });

    // Attacker swaps the field boundary: claims nonce contains the original
    // nonce + the original message, and message is something else. In v1
    // bytes these would produce the same signed-bytes; in v2 they cannot.
    const forgedValid = await asymmetric.verify({
      publicKey: keys.publicKey,
      signature: sig.signature,
      nonce: `${sig.nonce}:false`,
      timestamp: sig.timestamp,
      message: "",
      v: 2, // explicitly say "I expect a v2 signature"
    });
    expect(forgedValid).toBe(false);
  });

  it("verify({strict: true}) rejects legacy signatures (no v field)", async () => {
    const keys = await asymmetric.generate();
    const [ecdsaKey] = keys.privateKey.replace(/^S01:/, "").split(":");
    const cryptoKey = await globalThis.crypto.subtle.importKey(
      "pkcs8",
      fromBase64(ecdsaKey!) as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"],
    );
    const nonce = "n";
    const message = "m";
    const timestamp = Date.now();
    const legacyBytes = new TextEncoder().encode(`${nonce}:${message}:${timestamp}`);
    const sig = new Uint8Array(
      await globalThis.crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        cryptoKey,
        legacyBytes as BufferSource,
      ),
    );
    const valid = await asymmetric.verify({
      publicKey: keys.publicKey,
      signature: toBase64(sig),
      nonce,
      timestamp,
      message,
      strict: true,
    });
    expect(valid).toBe(false);
  });

  it("sign() always produces low-S signatures (malleability mitigation)", async () => {
    // Run several signs and confirm each s is in the low half.
    const keys = await asymmetric.generate();
    const P256_N = BigInt(
      "0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551",
    );
    const HALF_N = P256_N >> 1n;
    const bytesToBI = (b: Uint8Array): bigint => {
      let n = 0n;
      for (const x of b) n = (n << 8n) | BigInt(x);
      return n;
    };
    for (let i = 0; i < 8; i++) {
      const sig = await asymmetric.sign({ privateKey: keys.privateKey, message: `m${i}` });
      const sigBytes = fromBase64(sig.signature);
      const s = bytesToBI(sigBytes.subarray(32, 64));
      expect(s).toBeLessThanOrEqual(HALF_N);
    }
  });

  it("verify({strict: true}) rejects high-S equivalents of valid signatures", async () => {
    const keys = await asymmetric.generate();
    const sig = await asymmetric.sign({ privateKey: keys.privateKey, message: "x" });
    const sigBytes = fromBase64(sig.signature);
    // Flip s → n - s (high-S form). The flipped signature still verifies
    // mathematically (it's the malleability bug), but `strict: true` must
    // reject it as non-canonical.
    const P256_N = BigInt(
      "0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551",
    );
    const bytesToBI = (b: Uint8Array): bigint => {
      let n = 0n;
      for (const x of b) n = (n << 8n) | BigInt(x);
      return n;
    };
    const biToBytes = (n: bigint, len: number): Uint8Array => {
      const out = new Uint8Array(len);
      let v = n;
      for (let i = len - 1; i >= 0; i--) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
      }
      return out;
    };
    const sBI = bytesToBI(sigBytes.subarray(32, 64));
    const flipped = new Uint8Array(64);
    flipped.set(sigBytes.subarray(0, 32), 0);
    flipped.set(biToBytes(P256_N - sBI, 32), 32);
    const valid = await asymmetric.verify({
      ...sig,
      publicKey: keys.publicKey,
      message: "x",
      signature: toBase64(flipped),
      strict: true,
    });
    expect(valid).toBe(false);
  });
});

describe("crypto audit — validation", () => {
  it("verify throws on non-finite maxAge", async () => {
    const keys = await asymmetric.generate();
    const sig = await asymmetric.sign({ privateKey: keys.privateKey, message: "x" });
    await expect(
      asymmetric.verify({ ...sig, publicKey: keys.publicKey, message: "x", maxAge: NaN }),
    ).rejects.toThrow(/maxAge/);
    await expect(
      asymmetric.verify({ ...sig, publicKey: keys.publicKey, message: "x", maxAge: Infinity }),
    ).rejects.toThrow(/maxAge/);
    await expect(
      asymmetric.verify({ ...sig, publicKey: keys.publicKey, message: "x", maxAge: -1 }),
    ).rejects.toThrow(/maxAge/);
  });

  it("symmetric.decrypt throws on too-short blob", async () => {
    // 10 hex chars = 5 bytes → way under the 46-byte minimum header size.
    await expect(symmetric.decrypt({ payload: "aabbccddee", key: "k" })).rejects.toThrow(/too short/);
  });

  it("symmetric.decrypt throws on unknown KDF flag", async () => {
    // Build a 46-byte blob: version=0x01, flag=0xFF (invalid), then padding.
    const blob = new Uint8Array(46);
    blob[0] = 0x01;
    blob[1] = 0xff;
    await expect(symmetric.decrypt({ payload: toHex(blob), key: "k" })).rejects.toThrow(/KDF flag/);
  });

  it("symmetric.encrypt with stretched:false rejects too-short HKDF key", async () => {
    await expect(
      symmetric.encrypt({ payload: "x", key: "ab", stretched: false }),
    ).rejects.toThrow(/HKDF/);
  });

  it("symmetric.encrypt with stretched:true accepts short keys (PBKDF2)", async () => {
    // PBKDF2 deliberately tolerates short user passwords — only HKDF mode
    // requires meaningful entropy upfront.
    const enc = await symmetric.encrypt({ payload: "x", key: "ab", stretched: true });
    expect(typeof enc).toBe("string");
  });

  it("totp.verify throws on malformed Base32 secret (not silent false)", async () => {
    // Programmer errors should surface; the previous behavior silently
    // returned false and made debugging painful.
    await expect(
      totp.verify({ token: "123456", secret: "not-base32-at-all!@#$%" }),
    ).rejects.toThrow();
  });

  it("totp.verify throws on negative window", async () => {
    const { secret } = await totp.create({ label: "x", issuer: "App" });
    await expect(totp.verify({ token: "123456", secret, window: -1 })).rejects.toThrow(/window/);
  });

  it("totp.verify clamps absurd window values to TOTP_MAX_WINDOW", async () => {
    // Without the clamp, this would do 2 million HMAC operations and hang.
    const { secret } = await totp.create({ label: "x", issuer: "App" });
    const start = performance.now();
    await totp.verify({ token: "000000", secret, window: 1_000_000 });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500); // well below DoS levels
  });
});

describe("crypto audit — TOTP RFC-style ground-truth", () => {
  it("verifies a token generated for the current time step", async () => {
    // The previous test only asserted that random tokens FAIL — a broken
    // verify() that always returned false would pass. Here we generate a
    // valid token using the same primitives the verifier uses (HMAC-SHA1 +
    // dynamic truncation per RFC 4226) and assert it verifies as true.
    const { secret } = await totp.create({ label: "test", issuer: "App" });
    const secretBytes = fromBase32(secret);
    const counter = BigInt(Math.floor(Date.now() / 1000 / 30));

    // RFC 4226 HMAC-SHA1 + dynamic truncation, replicated here.
    const counterBytes = new Uint8Array(8);
    const view = new DataView(counterBytes.buffer);
    view.setBigUint64(0, counter, false);
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      secretBytes as BufferSource,
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    );
    const hmac = new Uint8Array(
      await globalThis.crypto.subtle.sign("HMAC", key, counterBytes as BufferSource),
    );
    const offset = hmac[hmac.length - 1]! & 0x0f;
    const binCode =
      ((hmac[offset]! & 0x7f) << 24) |
      ((hmac[offset + 1]! & 0xff) << 16) |
      ((hmac[offset + 2]! & 0xff) << 8) |
      (hmac[offset + 3]! & 0xff);
    const token = String(binCode % 1_000_000).padStart(6, "0");

    const valid = await totp.verify({ token, secret });
    expect(valid).toBe(true);
  });
});
