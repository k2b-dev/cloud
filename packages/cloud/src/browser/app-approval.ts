import { z } from "zod";
import {
  APP_APPROVAL_LIMITS,
  APP_APPROVAL_PATH,
  APP_APPROVAL_PROTOCOL,
  AppDevicePublicKeySchema,
  AppDeviceCommandSchema,
  AppDeviceProofSchema,
  AppDeviceResponseSchema,
  AppPairingClaimSchema,
  AppPairingClaimResultSchema,
  AppPairingPayloadSchema,
  AppPairingResultSchema,
  AppPendingLoginSchema,
  appDeviceProofMessage,
  appPairingProofMessage,
  appPairingLink,
  parseAppPairingLink,
  type AppDevicePublicKey,
  type AppPairingPayload,
  type AppPendingLogin,
} from "../contracts/app-approval";

export interface AppApprovalKey {
  privateKey: CryptoKey;
  publicKey: AppDevicePublicKey;
}
export interface AppApprovalDevice {
  issuer: string;
  deviceId: string;
  key: AppApprovalKey;
}

/** No remote error body or credential material is retained in an error. */
export class AppApprovalClientError extends Error {
  constructor(
    public readonly code: "HTTP" | "INVALID_RESPONSE" | "NETWORK" | "INVALID_INPUT",
    public readonly status?: number,
  ) {
    super(`App approval: ${code}`);
  }
}

const origin = (input: string): string => {
  const url = new URL(input);
  if (
    url.origin !== input ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  ) {
    throw new AppApprovalClientError("INVALID_INPUT");
  }
  return url.origin;
};

const createKey = async (): Promise<AppApprovalKey> => {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  return { privateKey: keys.privateKey, publicKey: AppDevicePublicKeySchema.parse({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }) };
};

const sign = async (key: AppApprovalKey, message: string) => {
  if (key.privateKey.extractable || key.privateKey.type !== "private") throw new AppApprovalClientError("INVALID_INPUT");
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, new TextEncoder().encode(message)),
  );
  return btoa(String.fromCharCode(...signature))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

const InfoSchema = z.object({
  protocol: z.literal(APP_APPROVAL_PROTOCOL),
  issuer: z.string(),
  api: z.string(),
  appOrigin: z.string(),
  algorithm: z.literal("ES256"),
  limits: z.object(Object.fromEntries(Object.entries(APP_APPROVAL_LIMITS).map(([key, value]) => [key, z.literal(value)]))),
});

/** Call only after the user explicitly trusts the issuer from a pairing link.
 * Connect validates discovery before returning a client. */
const connect = async (options: {
  issuer: string;
  authenticatorOrigin: string;
  signal?: AbortSignal;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}) => {
  const issuer = origin(options.issuer);
  const appOrigin = origin(options.authenticatorOrigin);
  const fetcher = options.fetch ?? globalThis.fetch;
  const request = async <T>(path: string, schema: z.ZodType<T>, body?: unknown, signal?: AbortSignal): Promise<T> => {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized && new TextEncoder().encode(serialized).length > APP_APPROVAL_LIMITS.bodyBytes)
      throw new AppApprovalClientError("INVALID_INPUT");
    let response: Response;
    const timeout = AbortSignal.timeout(APP_APPROVAL_LIMITS.proofSeconds * 1000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      response = await fetcher(`${issuer}${APP_APPROVAL_PATH}${path}`, {
        method: serialized === undefined ? "GET" : "POST",
        body: serialized,
        headers: serialized === undefined ? undefined : { "Content-Type": "application/json" },
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: requestSignal,
      });
    } catch {
      signal?.throwIfAborted();
      throw new AppApprovalClientError("NETWORK");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppApprovalClientError("HTTP", response.status);
    }
    // The response budget matches the bounded v1 request/pending-list budget.
    const reader = response.body?.getReader();
    if (!reader) throw new AppApprovalClientError("INVALID_RESPONSE");
    const decoder = new TextDecoder();
    let text = "",
      bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > APP_APPROVAL_LIMITS.bodyBytes) {
          await reader.cancel();
          throw new AppApprovalClientError("INVALID_RESPONSE");
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      return schema.parse(JSON.parse(text));
    } catch {
      signal?.throwIfAborted();
      throw new AppApprovalClientError("INVALID_RESPONSE");
    } finally {
      reader.releaseLock();
    }
  };
  const info = await request("/info", InfoSchema, undefined, options.signal);
  if (info.issuer !== issuer || info.appOrigin !== appOrigin || info.api !== `${issuer}${APP_APPROVAL_PATH}`)
    throw new AppApprovalClientError("INVALID_RESPONSE");

  const pairing = (payload: AppPairingPayload) => {
    const parsed = AppPairingPayloadSchema.parse(payload);
    if (parsed.issuer !== issuer || Date.parse(parsed.expiresAt) <= Date.now()) throw new AppApprovalClientError("INVALID_INPUT");
    return parsed;
  };
  const command = async (device: AppApprovalDevice, input: z.infer<typeof AppDeviceCommandSchema>, signal?: AbortSignal) => {
    if (device.issuer !== issuer) throw new AppApprovalClientError("INVALID_INPUT");
    const now = Math.floor(Date.now() / 1000);
    const proof = AppDeviceProofSchema.parse({
      issuer,
      deviceId: device.deviceId,
      jti: crypto.randomUUID(),
      issuedAt: now,
      expiresAt: now + APP_APPROVAL_LIMITS.proofSeconds,
      command: AppDeviceCommandSchema.parse(input),
    });
    return request("/device", AppDeviceResponseSchema, { proof, signature: await sign(device.key, appDeviceProofMessage(proof)) }, signal);
  };
  return {
    issuer,
    info,
    claim: async (payload: AppPairingPayload, key: AppApprovalKey, name: string, signal?: AbortSignal) => {
      const p = pairing(payload);
      const input = AppPairingClaimSchema.omit({ signature: true }).parse({
        pairingId: p.pairingId,
        secret: p.secret,
        publicKey: key.publicKey,
        name,
      });
      return request(
        "/pairings/claim",
        AppPairingClaimResultSchema,
        { ...input, signature: await sign(key, appPairingProofMessage(issuer, input)) },
        signal,
      );
    },
    pairingResult: (payload: AppPairingPayload, key: AppApprovalKey, signal?: AbortSignal) => {
      const p = pairing(payload);
      return request(
        "/pairings/result",
        AppPairingResultSchema,
        { pairingId: p.pairingId, secret: p.secret, publicKey: AppDevicePublicKeySchema.parse(key.publicKey) },
        signal,
      );
    },
    pending: async (device: AppApprovalDevice, signal?: AbortSignal) => {
      const result = await command(device, { operation: "pending" }, signal);
      if (!("requests" in result)) throw new AppApprovalClientError("INVALID_RESPONSE");
      return result;
    },
    decide: async (device: AppApprovalDevice, login: AppPendingLogin, decision: "approve" | "deny", signal?: AbortSignal) => {
      login = AppPendingLoginSchema.parse(login);
      if (Date.parse(login.expiresAt) <= Date.now()) throw new AppApprovalClientError("INVALID_INPUT");
      const result = await command(
        device,
        { operation: "decide", requestId: login.requestId, challenge: login.challenge, comparison: login.comparison, decision },
        signal,
      );
      if (!("state" in result) || result.state !== (decision === "approve" ? "approved" : "denied"))
        throw new AppApprovalClientError("INVALID_RESPONSE");
      return result;
    },
    revoke: async (device: AppApprovalDevice, signal?: AbortSignal) => {
      const result = await command(device, { operation: "revoke" }, signal);
      if (!("state" in result) || result.state !== "revoked") throw new AppApprovalClientError("INVALID_RESPONSE");
      return result;
    },
  };
};

/** Browser-only SDK. Never polls, approves, retries mutations, or reads clipboard automatically. */
export const appApproval = {
  createPairingLink: appPairingLink,
  parsePairingLink: parseAppPairingLink,
  createKey,
  connect,
  limits: APP_APPROVAL_LIMITS,
};
