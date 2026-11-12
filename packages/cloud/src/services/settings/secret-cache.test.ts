import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { connectionFixture, stubConnections } from "../../runtime/connections.test-fixture";
import * as crypto from "./crypto";
import { registerSettings, SETTINGS } from "./defaults";
import { ENCRYPTED_SETTING_PREFIX, encodeSecretCache, readSecretCache } from "./secret-cache";

const key = "test.secret_cache";
const other = "test.secret_cache_other";
registerSettings([key, other].map((key) => ({ key, kind: "secret" as const, default: "", group: "test", description: "Cache probe" })));
afterEach(() => mock.restore());

test("a warm ciphertext is decrypted once, while a replacement is decoded independently", async () => {
  stubConnections();
  const first = await encodeSecretCache(key, "first");
  const next = await encodeSecretCache(key, "next");
  const decrypt = spyOn(crypto, "decryptValue");
  expect(await readSecretCache(key, first)).toBe("first");
  expect(await readSecretCache(key, first)).toBe("first");
  expect(decrypt).toHaveBeenCalledTimes(1);
  expect(await readSecretCache(key, next)).toBe("next");
  expect(decrypt).toHaveBeenCalledTimes(2);
});

test("cache ciphertext is bound to its setting, including memo hits", async () => {
  stubConnections();
  const encoded = await encodeSecretCache(key, "value");
  await expect(readSecretCache(other, encoded)).rejects.toThrow("key mismatch");
  expect(await readSecretCache(key, encoded)).toBe("value");
  await expect(readSecretCache(other, encoded)).rejects.toThrow("key mismatch");
  const legacy = ENCRYPTED_SETTING_PREFIX + (await crypto.encryptValue("value"));
  await expect(readSecretCache(key, legacy)).rejects.toThrow("key mismatch");
});

test("memoized values do not survive a change of encryption key", async () => {
  const snapshot = stubConnections();
  const encoded = await encodeSecretCache(key, "value");
  expect(await readSecretCache(key, encoded)).toBe("value");
  snapshot.mockRestore();
  stubConnections({ appSecret: { current: "different-process-secret" } });
  await expect(readSecretCache(key, encoded)).rejects.toThrow();
});

test("the declared setting count bounds the memo and recent entries survive eviction", async () => {
  stubConnections();
  const limit = SETTINGS.length;
  const values = await Promise.all(Array.from({ length: limit + 1 }, (_, index) => encodeSecretCache(key, `value-${index}`)));
  const decrypt = spyOn(crypto, "decryptValue");
  for (const value of values.slice(0, limit)) await readSecretCache(key, value);
  await readSecretCache(key, values[0]!);
  await readSecretCache(key, values[limit]!);
  const before = decrypt.mock.calls.length;
  await readSecretCache(key, values[0]!);
  expect(decrypt).toHaveBeenCalledTimes(before);
  await readSecretCache(key, values[1]!);
  expect(decrypt).toHaveBeenCalledTimes(before + 1);
});

test("a full ring change invalidates memoized and shared ciphertext even when current stays unchanged", async () => {
  const A = "ab".repeat(32),
    B = "cd".repeat(32);
  const snapshot = stubConnections({ appSecret: { current: B, previous: A } });
  const encoded = await encodeSecretCache(key, "previously readable");
  expect(await readSecretCache(key, encoded)).toBe("previously readable");
  snapshot.mockReturnValue(connectionFixture({ appSecret: { current: B } }));
  await expect(readSecretCache(key, encoded)).rejects.toThrow();
  snapshot.mockReturnValue(connectionFixture({ appSecret: { current: B, previous: A } }));
  expect(await readSecretCache(key, encoded)).toBe("previously readable");
});
