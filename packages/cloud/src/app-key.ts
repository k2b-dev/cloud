/** Portable Ed25519 app-key format. No server, environment, or barrel dependencies. */
const PREFIX = "cloud-app-key-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const APP_ID = /^[a-z][a-z0-9-]{0,79}$/;
const PKCS8_PREFIX = new Uint8Array([48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 112, 4, 34, 4, 32]);

export type AppKey = { installationId: string; appId: string; keyId: string; seed: string };

export const validateAppKeyAppId = (appId: string): string => {
  if (!APP_ID.test(appId) || appId.trim() !== appId) throw new Error("App ID must match ^[a-z][a-z0-9-]{0,79}$");
  if (appId === "core" || appId === "gateway") throw new Error("Core and Gateway cannot have app keys");
  return appId;
};

const encode = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const decode32 = (value: string, label: string): Uint8Array<ArrayBuffer> => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error(`${label} must be 32 bytes in unpadded base64url`);
  const bytes = Uint8Array.from(atob(`${value.replaceAll("-", "+").replaceAll("_", "/")}=`), (c) => c.charCodeAt(0));
  if (bytes.length !== 32 || encode(bytes) !== value) throw new Error(`${label} must use canonical base64url`);
  return bytes;
};

export const parseAppKey = (value: string): AppKey => {
  const parts = value.split(".");
  if (parts.length !== 5 || parts[0] !== PREFIX) throw new Error("Expected cloud-app-key-v1.<installationId>.<appId>.<keyId>.<seed>");
  const [, installationId, appId, keyId, seed] = parts;
  if (!installationId || installationId.length !== 36 || !UUID.test(installationId))
    throw new Error("Invalid app-key installation ID (expected canonical UUID)");
  if (!keyId || keyId.length !== 36 || !UUID.test(keyId)) throw new Error("Invalid app-key key ID (expected canonical UUID)");
  validateAppKeyAppId(appId ?? "");
  decode32(seed ?? "", "App-key seed");
  return { installationId, appId: appId!, keyId, seed: seed! };
};

export const formatAppKey = (key: AppKey): string => {
  const value = `${PREFIX}.${key.installationId}.${key.appId}.${key.keyId}.${key.seed}`;
  parseAppKey(value);
  return value;
};

export const importAppKeySeed = async (seed: string): Promise<CryptoKey> => {
  const der = new Uint8Array(48);
  der.set(PKCS8_PREFIX);
  der.set(decode32(seed, "App-key seed"), 16);
  return crypto.subtle.importKey("pkcs8", der, "Ed25519", true, ["sign"]);
};

export const deriveAppPublicKey = async (seed: string): Promise<string> => {
  const jwk = await crypto.subtle.exportKey("jwk", await importAppKeySeed(seed));
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x) throw new Error("Ed25519 public key export failed");
  decode32(jwk.x, "App public key");
  return jwk.x;
};

// WebCrypto raw import accepts arbitrary 32-byte strings in Bun. Check the
// canonical compressed Edwards point as well, including small-order points.
const P = (1n << 255n) - 19n;
const mod = (x: bigint): bigint => ((x % P) + P) % P;
const pow = (x: bigint, exponent: bigint): bigint => {
  let result = 1n;
  for (let n = exponent; n > 0n; n >>= 1n) {
    if (n & 1n) result = mod(result * x);
    x = mod(x * x);
  }
  return result;
};
const D = mod(-121665n * pow(121666n, P - 2n));
const validPoint = (bytes: Uint8Array): boolean => {
  let compressed = 0n;
  for (let i = 31; i >= 0; i--) compressed = (compressed << 8n) | BigInt(bytes[i]!);
  const sign = compressed >> 255n;
  const y = compressed & ((1n << 255n) - 1n);
  if (y >= P) return false;
  const y2 = mod(y * y);
  const x2 = mod((y2 - 1n) * pow(mod(D * y2 + 1n), P - 2n));
  let x = pow(x2, (P + 3n) / 8n);
  if (mod(x * x) !== x2) x = mod(x * pow(2n, (P - 1n) / 4n));
  if (mod(x * x) !== x2 || (x === 0n && sign !== 0n)) return false;
  if ((x & 1n) !== sign) x = P - x;
  // Three projective doublings: [8]P must not be the identity.
  let X = x;
  let Y = y;
  let Z = 1n;
  for (let i = 0; i < 3; i++) {
    const a = mod(X * X),
      b = mod(Y * Y),
      c = mod(2n * Z * Z),
      d = mod(-a);
    const e = mod((X + Y) ** 2n - a - b),
      g = mod(d + b),
      f = mod(g - c),
      h = mod(d - b);
    X = mod(e * f);
    Y = mod(g * h);
    Z = mod(f * g);
  }
  return X !== 0n || mod(Y - Z) !== 0n;
};

export const importAppPublicKey = async (publicKey: string): Promise<CryptoKey> => {
  const bytes = decode32(publicKey, "App public key");
  if (!validPoint(bytes)) throw new Error("App public key must be a canonical Ed25519 point of non-small order");
  return crypto.subtle.importKey("raw", bytes, "Ed25519", true, ["verify"]);
};

/** First 16 bytes of SHA-256(raw public key), displayed as 32 lowercase hex characters. */
export const appKeyFingerprint = async (publicKey: string): Promise<string> => {
  await importAppPublicKey(publicKey);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", decode32(publicKey, "App public key")));
  return Array.from(hash.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/**
 * WebKit on Linux refuses about one Ed25519 generateKey in a hundred with an OperationError (#2286). Each attempt draws
 * a new random pair, so a refusal is not repeated; three attempts leave about one failure in a million.
 */
const GENERATE_ATTEMPTS = 3;

export const generateAppKeyPair = async (): Promise<{ seed: string; publicKey: string }> => {
  let pair: CryptoKeyPair | undefined;
  for (let attempt = 1; !pair; attempt++) {
    try {
      pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    } catch (error) {
      if (attempt >= GENERATE_ATTEMPTS || !(error instanceof DOMException && error.name === "OperationError")) throw error;
    }
  }
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.d || !jwk.x) throw new Error("Ed25519 key generation failed");
  decode32(jwk.d, "App-key seed");
  await importAppPublicKey(jwk.x);
  return { seed: jwk.d, publicKey: jwk.x };
};
