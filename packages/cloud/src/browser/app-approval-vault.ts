import { z } from "zod";
import { AppDevicePublicKeySchema } from "../contracts/app-approval";
import type { AppApprovalKey } from "./app-approval";

const keyGuards = new WeakMap<CryptoKey, () => void>();
export function assertVaultKey(key: CryptoKey) {
  keyGuards.get(key)?.();
}
const bytes = (length: number) => crypto.getRandomValues(new Uint8Array(length));
const encode = (value: Uint8Array<ArrayBuffer>) => btoa(String.fromCharCode(...value));
const decode = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const text = new TextEncoder();
const base64 = (length: number) =>
  z
    .string()
    .max(length * 2)
    .refine((s) => {
      try {
        return decode(s).length === length && encode(decode(s)) === s;
      } catch {
        return false;
      }
    });
const blobSchema = z.object({ iv: base64(12), data: z.string().max(2_000_000) }).strict();
const pinSchema = z
  .object({ type: z.literal("pin"), salt: base64(16), kdf: z.literal("argon2id-64m-t3-p1"), wrapped: blobSchema })
  .strict();
const passkeySchema = z
  .object({ type: z.literal("passkey"), credentialId: z.string().min(1).max(2048), salt: base64(32), wrapped: blobSchema })
  .strict();
const methodSchema = z.discriminatedUnion("type", [pinSchema, passkeySchema]);
const configSchema = z
  .object({ version: z.literal(1), id: base64(16), methods: z.array(methodSchema).min(1).max(2) })
  .strict()
  .refine((c) => new Set(c.methods.map((m) => m.type)).size === c.methods.length);
export type AppVaultConfig = z.infer<typeof configSchema>;
export type AppVaultBlob = z.infer<typeof blobSchema>;
export type AppVaultMethod = AppVaultConfig["methods"][number];
export type AppVaultSession = ReturnType<typeof session>;
export class AppVaultError extends Error {
  constructor(public readonly code: "LOCKED" | "INVALID" | "UNSUPPORTED") {
    super(`App vault: ${code}`);
  }
}
const invalid = () => new AppVaultError("INVALID");
const aes = (raw: Uint8Array<ArrayBuffer>) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
async function encrypt(key: CryptoKey, data: Uint8Array<ArrayBuffer>, context: string): Promise<AppVaultBlob> {
  const iv = bytes(12);
  return {
    iv: encode(iv),
    data: encode(
      new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: text.encode(context), tagLength: 128 }, key, data)),
    ),
  };
}
async function decrypt(key: CryptoKey, value: AppVaultBlob, context: string) {
  const b = blobSchema.parse(value);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: decode(b.iv), additionalData: text.encode(context), tagLength: 128 },
        key,
        decode(b.data),
      ),
    );
  } catch {
    throw invalid();
  }
}
async function pinKey(pin: string, salt: string) {
  if (!/^[0-9]{6}$/.test(pin)) throw invalid();
  const { argon2id } = await import("hash-wasm");
  // Based on RFC 9106's memory-constrained profile: 64 MiB, three passes; one browser lane.
  const raw = await argon2id({
    password: pin,
    salt: decode(salt),
    parallelism: 1,
    iterations: 3,
    memorySize: 65536,
    hashLength: 32,
    outputType: "binary",
  });
  try {
    return await aes(new Uint8Array(raw));
  } finally {
    raw.fill(0);
  }
}
function wrapContext(id: string, method: Omit<z.infer<typeof pinSchema>, "wrapped"> | Omit<z.infer<typeof passkeySchema>, "wrapped">) {
  return JSON.stringify(["cloud-login-vault", 1, id, method.type, method.salt, method.type === "pin" ? method.kdf : method.credentialId]);
}
function methodContext(id: string, method: AppVaultMethod) {
  return wrapContext(
    id,
    method.type === "pin"
      ? { type: "pin", salt: method.salt, kdf: method.kdf }
      : { type: "passkey", salt: method.salt, credentialId: method.credentialId },
  );
}
function extension(credential: Credential | null): { id: string; enabled: boolean; output?: Uint8Array<ArrayBuffer> } {
  if (!(credential instanceof PublicKeyCredential)) throw invalid();
  const result: unknown = credential.getClientExtensionResults();
  const parsed = z
    .object({
      prf: z.object({ enabled: z.boolean().optional(), results: z.object({ first: z.instanceof(ArrayBuffer) }).optional() }).optional(),
    })
    .parse(result);
  const first = parsed.prf?.results?.first;
  if (first && first.byteLength !== 32) throw invalid();
  return {
    id: encode(new Uint8Array(credential.rawId)),
    enabled: parsed.prf?.enabled === true,
    output: first ? new Uint8Array(first) : undefined,
  };
}
async function passkeyKey(credentialId: string, salt: string, signal?: AbortSignal) {
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: bytes(32),
      rpId: location.hostname,
      allowCredentials: [{ type: "public-key", id: decode(credentialId) }],
      userVerification: "required",
      extensions: { prf: { eval: { first: decode(salt) } } },
    },
    signal,
  });
  const result = extension(credential);
  if (result.id !== credentialId || !result.output) throw new AppVaultError("UNSUPPORTED");
  try {
    const ikm = await crypto.subtle.importKey("raw", result.output, "HKDF", false, ["deriveKey"]);
    return await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: text.encode(location.origin), info: text.encode("cloud-login-vault-wrap-v1") },
      ikm,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } finally {
    result.output.fill(0);
  }
}
async function capability(): Promise<"supported" | "unknown" | "unsupported"> {
  if (
    !globalThis.isSecureContext ||
    !globalThis.PublicKeyCredential ||
    !navigator.credentials ||
    /^(?:[0-9]+\.){3}[0-9]+$|^\[/.test(location.hostname)
  )
    return "unsupported";
  if (!PublicKeyCredential.getClientCapabilities) return "unknown";
  try {
    const caps = await PublicKeyCredential.getClientCapabilities();
    const prf = caps["extension:prf"];
    return prf === true ? "supported" : prf === false ? "unsupported" : "unknown";
  } catch {
    return "unknown";
  }
}
function session(id: string, raw: Uint8Array<ArrayBuffer>, key: CryptoKey) {
  let live = true;
  const imported = new Map<string, AppApprovalKey>();
  const materials = new Map<CryptoKey, Uint8Array<ArrayBuffer>>();
  const check = () => {
    if (!live) throw new AppVaultError("LOCKED");
  };
  const importPrivate = async (material: Uint8Array<ArrayBuffer>, publicKey: AppApprovalKey["publicKey"]): Promise<AppApprovalKey> => {
    check();
    const cacheId = encode(material);
    const cached = imported.get(cacheId);
    if (cached && JSON.stringify(cached.publicKey) === JSON.stringify(publicKey)) return cached;
    const privateKey = await crypto.subtle.importKey("pkcs8", material, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const pub = await crypto.subtle.importKey("jwk", publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const challenge = bytes(32);
    const proof = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, challenge);
    if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, proof, challenge))) throw invalid();
    check();
    materials.set(privateKey, material.slice());
    keyGuards.set(privateKey, check);
    const value = { privateKey, publicKey };
    imported.set(cacheId, value);
    return value;
  };
  return {
    id,
    check,
    lock() {
      live = false;
      raw.fill(0);
      for (const material of materials.values()) material.fill(0);
      materials.clear();
      imported.clear();
    },
    async createKey() {
      check();
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
      const publicKey = AppDevicePublicKeySchema.parse({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
      const material = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
      try {
        return await importPrivate(material, publicKey);
      } finally {
        material.fill(0);
      }
    },
    async sealRecord<T extends { key: AppApprovalKey }>(record: T, context: string) {
      check();
      const material = materials.get(record.key.privateKey);
      if (!material) throw invalid();
      const plain = text.encode(JSON.stringify({ ...record, key: { privateKey: encode(material), publicKey: record.key.publicKey } }));
      try {
        const blob = await encrypt(key, plain, JSON.stringify(["cloud-login-record", 1, id, context]));
        check();
        return blob;
      } finally {
        plain.fill(0);
      }
    },
    async openRecord<T>(blob: AppVaultBlob, context: string, validate: (value: unknown) => T): Promise<T> {
      check();
      const plain = await decrypt(key, blob, JSON.stringify(["cloud-login-record", 1, id, context]));
      try {
        const parsed = z
          .object({ key: z.object({ privateKey: z.string().max(512), publicKey: AppDevicePublicKeySchema }).strict() })
          .passthrough()
          .parse(JSON.parse(new TextDecoder().decode(plain)));
        const material = decode(parsed.key.privateKey);
        try {
          const result = validate({ ...parsed, key: await importPrivate(material, parsed.key.publicKey) });
          check();
          return result;
        } finally {
          material.fill(0);
        }
      } finally {
        plain.fill(0);
      }
    },
    async pin(pin: string): Promise<AppVaultMethod> {
      check();
      const method = { type: "pin" as const, salt: encode(bytes(16)), kdf: "argon2id-64m-t3-p1" as const };
      const wrapping = await pinKey(pin, method.salt);
      check();
      const wrapped = await encrypt(wrapping, raw, wrapContext(id, method));
      check();
      return { ...method, wrapped };
    },
    async passkey(signal?: AbortSignal): Promise<AppVaultMethod> {
      check();
      const credential = await navigator.credentials.create({
        publicKey: {
          challenge: bytes(32),
          rp: { id: location.hostname, name: "Cloud Login" },
          user: { id: bytes(32), name: "Cloud Login", displayName: "Cloud Login" },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          authenticatorSelection: { residentKey: "required", userVerification: "required" },
          attestation: "none",
          extensions: { prf: {} },
        },
        signal,
      });
      const result = extension(credential);
      result.output?.fill(0);
      if (!result.enabled) throw new AppVaultError("UNSUPPORTED");
      const method = { type: "passkey" as const, credentialId: result.id, salt: encode(bytes(32)) };
      const wrapping = await passkeyKey(method.credentialId, method.salt, signal);
      check();
      const wrapped = await encrypt(wrapping, raw, wrapContext(id, method));
      check();
      return { ...method, wrapped };
    },
  };
}
async function create() {
  const raw = bytes(32);
  return session(encode(bytes(16)), raw, await aes(raw));
}
async function unlock(config: AppVaultConfig, type: "pin" | "passkey", pin?: string, signal?: AbortSignal) {
  const value = configSchema.parse(config);
  const method = value.methods.find((m) => m.type === type);
  if (!method) throw invalid();
  const wrapping =
    method.type === "pin" ? await pinKey(pin ?? "", method.salt) : await passkeyKey(method.credentialId, method.salt, signal);
  const raw = await decrypt(wrapping, method.wrapped, methodContext(value.id, method));
  if (raw.length !== 32) {
    raw.fill(0);
    throw invalid();
  }
  try {
    signal?.throwIfAborted();
    const key = await aes(raw);
    signal?.throwIfAborted();
    return session(value.id, raw, key);
  } catch (error) {
    raw.fill(0);
    throw error;
  }
}
export const appApprovalVault = { create, unlock, capability, parseConfig: (value: unknown) => configSchema.parse(value) };
