import { describe, expect, test } from "bun:test";
import { argon2id } from "hash-wasm";
import { APP_APPROVAL_LIMITS, APP_APPROVAL_PATH, APP_APPROVAL_PROTOCOL } from "../contracts/app-approval";
import { appApproval } from "./app-approval";

const setup = async () => {
  const session = await appApproval.vault.create();
  const method = await session.pin("012345");
  return { session, config: { version: 1 as const, id: session.id, methods: [method] } };
};
const record = (value: unknown) => value;
describe("appApproval vault", () => {
  test("PIN key derivation matches independently maintained Argon2id vector", async () => {
    // Published hash-wasm Argon2id known-answer fixture (test/argon2.test.ts).
    expect(
      await argon2id({
        password: "text demo",
        salt: "123456789",
        parallelism: 2,
        iterations: 1,
        memorySize: 64,
        hashLength: 32,
        outputType: "hex",
      }),
    ).toBe("b3f9d902f65bd329cf0810c78b19c746b6f46fbb8243647a8942ab83b6850d47");
  });
  test("encrypted records survive PIN unlock; wrong PIN and tampering fail", async () => {
    const { session, config } = await setup();
    const key = await session.createKey();
    expect(key.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("pkcs8", key.privateKey)).rejects.toThrow();
    const data = { issuer: "https://one.example", key, label: "Private account" };
    const encrypted = await session.sealRecord(data, "one");
    expect(JSON.stringify(encrypted)).not.toContain("Private account");
    const another = await session.sealRecord(data, "one");
    expect(encrypted.iv).not.toBe(another.iv);
    session.lock();
    await expect(session.sealRecord(data, "one")).rejects.toThrow();
    await expect(appApproval.vault.unlock(config, "pin", "12345")).rejects.toThrow();
    await expect(appApproval.vault.unlock(config, "pin", "123456")).rejects.toThrow();
    const unlocked = await appApproval.vault.unlock(config, "pin", "012345");
    const restored = await unlocked.openRecord(encrypted, "one", record);
    expect(restored).toMatchObject({ issuer: "https://one.example", label: "Private account" });
    await expect(unlocked.openRecord(encrypted, "two", record)).rejects.toThrow();
    await expect(unlocked.openRecord({ ...encrypted, iv: another.iv }, "one", record)).rejects.toThrow();
    const mutated = { ...encrypted, data: (encrypted.data[0] === "A" ? "B" : "A") + encrypted.data.slice(1) };
    await expect(unlocked.openRecord(mutated, "one", record)).rejects.toThrow();
    unlocked.lock();
  });
  test("separate vaults and separate Cloud keys cannot be substituted", async () => {
    const a = await setup();
    const b = await setup();
    const key1 = await a.session.createKey();
    const key2 = await a.session.createKey();
    expect(key1.publicKey).not.toEqual(key2.publicKey);
    const blob = await a.session.sealRecord({ key: key1 }, "cloud-one");
    await expect(b.session.openRecord(blob, "cloud-one", record)).rejects.toThrow();
    await expect(a.session.sealRecord({ key: await appApproval.createKey() }, "legacy")).rejects.toThrow();
    a.session.lock();
    b.session.lock();
  });
  test("PIN change works without changing Cloud keys and rejects the old PIN", async () => {
    const { session, config } = await setup();
    const key = await session.createKey();
    const blob = await session.sealRecord({ key }, "one");
    const pin = await session.pin("987654");
    const changed = { ...config, methods: [pin] };
    await expect(appApproval.vault.unlock(changed, "pin", "012345")).rejects.toThrow();
    const unlocked = await appApproval.vault.unlock(changed, "pin", "987654");
    expect(await unlocked.openRecord(blob, "one", record)).toMatchObject({ key: { publicKey: key.publicKey } });
    unlocked.lock();
    session.lock();
  });
  test("PIN envelope decrypts using the documented WebCrypto format independently of the vault decoder", async () => {
    const { session, config } = await setup();
    const method = config.methods[0]!;
    if (method.type !== "pin") throw new Error("fixture");
    const decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const derived = await argon2id({
      password: "012345",
      salt: decode(method.salt),
      memorySize: 65536,
      iterations: 3,
      parallelism: 1,
      hashLength: 32,
      outputType: "binary",
    });
    const wrapping = await crypto.subtle.importKey("raw", new Uint8Array(derived), "AES-GCM", false, ["decrypt"]);
    derived.fill(0);
    const aad = new TextEncoder().encode(JSON.stringify(["cloud-login-vault", 1, config.id, "pin", method.salt, method.kdf]));
    const raw = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decode(method.wrapped.iv), additionalData: aad, tagLength: 128 },
      wrapping,
      decode(method.wrapped.data),
    );
    expect(raw.byteLength).toBe(32);
    const vaultKey = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    new Uint8Array(raw).fill(0);
    const blob = await session.sealRecord({ key: await session.createKey(), label: "known content" }, "fixture");
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: decode(blob.iv),
        additionalData: new TextEncoder().encode(JSON.stringify(["cloud-login-record", 1, config.id, "fixture"])),
        tagLength: 128,
      },
      vaultKey,
      decode(blob.data),
    );
    expect(JSON.parse(new TextDecoder().decode(plain)).label).toBe("known content");
    new Uint8Array(plain).fill(0);
    session.lock();
  });
  test("locked vault keys cannot issue SDK requests, including retained caller references", async () => {
    const { session } = await setup();
    const key = await session.createKey();
    let deviceCalls = 0;
    const issuer = "https://cloud.example",
      authenticatorOrigin = "https://auth.example";
    const client = await appApproval.connect({
      issuer,
      authenticatorOrigin,
      fetch: async (url) => {
        if (url.endsWith("/info"))
          return Response.json({
            protocol: APP_APPROVAL_PROTOCOL,
            issuer,
            api: issuer + APP_APPROVAL_PATH,
            appOrigin: authenticatorOrigin,
            algorithm: "ES256",
            limits: APP_APPROVAL_LIMITS,
          });
        deviceCalls++;
        return Response.json({ requests: [], pollAfterSeconds: 5 });
      },
    });
    const device = { issuer, deviceId: "ab811792-7476-4a8c-b676-2c6007bb9b5b", key };
    await client.pending(device);
    expect(deviceCalls).toBe(1);
    session.lock();
    await expect(client.pending(device)).rejects.toThrow();
    expect(deviceCalls).toBe(1);
  });
  test("unknown versions, KDF parameters, and missing/duplicate methods fail before derivation", async () => {
    const { session, config } = await setup();
    expect(() => appApproval.vault.parseConfig({ ...config, methods: [...config.methods, ...config.methods] })).toThrow();
    expect(() => appApproval.vault.parseConfig({ ...config, methods: [{ ...config.methods[0], kdf: "fast-sha" }] })).toThrow();
    session.lock();
    expect(() => appApproval.vault.parseConfig({ version: 2 })).toThrow();
    expect(() => appApproval.vault.parseConfig({ version: 1, id: btoa("x".repeat(16)), methods: [] })).toThrow();
  });
});
