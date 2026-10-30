import { describe, expect, test } from "bun:test";
import { APP_KEY_FIXTURES, INSTALLATION_ID, KEY_ID } from "../../../scripts/fixtures/app-key-fixtures";
import {
  appKeyFingerprint,
  deriveAppPublicKey,
  formatAppKey,
  importAppKeySeed,
  importAppPublicKey,
  parseAppKey,
  validateAppKeyAppId,
} from "./app-key";

const fixture = APP_KEY_FIXTURES[0];
const key = { installationId: INSTALLATION_ID, appId: "third-party", keyId: KEY_ID, seed: fixture.seed };

describe("portable app key format", () => {
  test("roundtrips the versioned private format exactly", () => {
    const value = `cloud-app-key-v1.${INSTALLATION_ID}.third-party.${KEY_ID}.${fixture.seed}`;
    expect(formatAppKey(key)).toBe(value);
    expect(parseAppKey(value)).toEqual(key);
    for (const invalid of [
      value + ".extra",
      value + "\n",
      value.replace("v1", "v2"),
      value.replace(INSTALLATION_ID, "installation"),
      value.replace(KEY_ID, "key"),
      value.replace(fixture.seed, fixture.seed + "="),
    ])
      expect(() => parseAppKey(invalid)).toThrow();
    expect(() => formatAppKey({ ...key, seed: fixture.seed.slice(0, -1) + "B" })).toThrow("canonical");
  });
  test("derives and fingerprints fixed RFC 8032 keys with WebCrypto", async () => {
    for (const vector of APP_KEY_FIXTURES) {
      expect(await deriveAppPublicKey(vector.seed)).toBe(vector.publicKey);
      expect(await appKeyFingerprint(vector.publicKey)).toBe(vector.fingerprint);
      const signature = await crypto.subtle.sign("Ed25519", await importAppKeySeed(vector.seed), new Uint8Array([1, 2, 3]));
      expect(await crypto.subtle.verify("Ed25519", await importAppPublicKey(vector.publicKey), signature, new Uint8Array([1, 2, 3]))).toBe(
        true,
      );
    }
  });
  test("rejects malformed, noncanonical, off-curve, and small-order public keys", async () => {
    for (const value of [
      "",
      "A".repeat(42),
      fixture.publicKey + "=",
      fixture.publicKey + "\n",
      "_".repeat(43),
      "A".repeat(43),
      "AQ" + "A".repeat(41),
      Buffer.alloc(32, 2).toString("base64url"),
    ])
      await expect(importAppPublicKey(value)).rejects.toThrow();
  });
  test("accepts third-party and oauth IDs before app registration and reserves Core/Gateway", () => {
    for (const id of ["a", "third-party", "oauth", "a".repeat(80)]) expect(validateAppKeyAppId(id)).toBe(id);
    for (const id of ["", "Core", "core", "gateway", "1app", "a_b", "a.b", "inventory\n", "a".repeat(81)])
      expect(() => validateAppKeyAppId(id)).toThrow();
  });
});

test("the documented OpenSSL DER extraction matches both generated layout and fixed RFC fixtures", async () => {
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "cloud-app-key-openssl-"));
  const run = async (...args: string[]) => {
    const child = Bun.spawn(["openssl", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    return stdout;
  };
  try {
    // Run the literal generation step, then fix the PEM so the extraction's
    // expected seed/public bytes never depend on randomness.
    await run("genpkey", "-algorithm", "ed25519", "-out", "app.pem");
    await run("pkey", "-in", "app.pem", "-outform", "DER", "-out", "app.der");
    await run("pkey", "-in", "app.pem", "-pubout", "-outform", "DER", "-out", "app-public.der");
    expect((await readFile(join(dir, "app.der"))).length).toBe(48);
    expect((await readFile(join(dir, "app-public.der"))).length).toBe(44);
    const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(fixture.seed, "base64url")]);
    await writeFile(join(dir, "fixture.der"), der, { mode: 0o600 });
    await run("pkey", "-inform", "DER", "-in", "fixture.der", "-out", "app.pem");
    await run("pkey", "-in", "app.pem", "-outform", "DER", "-out", "app.der");
    await run("pkey", "-in", "app.pem", "-pubout", "-outform", "DER", "-out", "app-public.der");
    const privateDer = await readFile(join(dir, "app.der"));
    const publicDer = await readFile(join(dir, "app-public.der"));
    expect(privateDer.length).toBe(48);
    expect(publicDer.length).toBe(44);
    expect(privateDer.subarray(0, 16).toString("hex")).toBe("302e020100300506032b657004220420");
    expect(publicDer.subarray(0, 12).toString("hex")).toBe("302a300506032b6570032100");
    const script =
      'set -eu; test "$(wc -c < app.der)" -eq 48; test "$(wc -c < app-public.der)" -eq 44; tail -c 32 app.der | openssl base64 -A | tr "+/" "-_" | tr -d "=" > seed; tail -c 32 app-public.der | openssl base64 -A | tr "+/" "-_" | tr -d "=" > public';
    const child = Bun.spawn(["bash", "-c", script], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code, error).toBe(0);
    expect(await readFile(join(dir, "seed"), "utf8")).toBe(fixture.seed);
    expect(await readFile(join(dir, "public"), "utf8")).toBe(fixture.publicKey);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
