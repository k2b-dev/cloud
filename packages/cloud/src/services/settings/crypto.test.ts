import { afterEach, expect, test } from "bun:test";
import { createCipheriv, createHash, hkdfSync } from "node:crypto";
import { connectionFixture, stubConnections } from "../../runtime/connections.test-fixture";
import { decryptSecretBytes, decryptValue, encryptValue, getAppSecret } from "./crypto";

const A = "ab".repeat(32),
  B = "cd".repeat(32);
let snapshot: ReturnType<typeof stubConnections> | undefined;
afterEach(() => snapshot?.mockRestore());

/** Independent deterministic encoder for the deployed legacy byte layout. */
const legacy = (keyHex: string, plaintext: string) => {
  const salt = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
  const iv = Buffer.from("101112131415161718191a1b", "hex");
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(keyHex, "hex"), salt, "sym:v1:encrypt", 32));
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([Buffer.from([1, 0]), salt, iv, encrypted]).toString("hex");
};

test("deployed hex and passphrase ciphertexts keep their normalization and JSON/raw-string reads", async () => {
  for (const [root, key] of [
    [`  ${A.toUpperCase()}  `, A],
    ["  legacy recovery phrase  ", createHash("sha256").update("legacy recovery phrase").digest("hex")],
    ["a1b2", "a1b2"],
  ]) {
    snapshot = stubConnections({ appSecret: { current: root! } });
    expect(getAppSecret().toLowerCase()).toBe(key!);
    expect(await decryptValue(legacy(key!, '{"answer":42}'))).toEqual({ answer: 42 });
    expect(await decryptValue(legacy(key!, "legacy raw string\n"))).toBe("legacy raw string\n");
    snapshot.mockRestore();
  }
});

test("A-written data reads under B/PREVIOUS=A; B-written data reads under A/NEXT=B", async () => {
  snapshot = stubConnections({ appSecret: { current: A } });
  const a = await encryptValue({ credential: "unchanged" });
  snapshot.mockReturnValue(connectionFixture({ appSecret: { current: B, previous: A } }));
  expect(await decryptValue(a)).toEqual({ credential: "unchanged" });
  const b = await encryptValue([false, null, "B"]);
  await expect(decryptSecretBytes(b, A)).rejects.toThrow();
  expect(await decryptSecretBytes(b, B)).toBe('[false,null,"B"]');
  snapshot.mockReturnValue(connectionFixture({ appSecret: { current: A, next: B } }));
  expect(await decryptValue(b)).toEqual([false, null, "B"]);
  snapshot.mockReturnValue(connectionFixture({ appSecret: { current: B } }));
  await expect(decryptValue(a)).rejects.toThrow("configured APP_SECRET ring");
  await expect(decryptValue("unreadable")).rejects.toThrow("configured APP_SECRET ring");
});
