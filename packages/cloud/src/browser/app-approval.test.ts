import { describe, expect, test } from "bun:test";
import { appApproval, AppApprovalClientError } from "./app-approval";
import {
  APP_APPROVAL_PROTOCOL,
  APP_APPROVAL_PATH,
  APP_APPROVAL_LIMITS,
  AppPairingClaimSchema,
  AppDeviceRequestSchema,
  appPairingProofMessage,
  appDeviceProofMessage,
} from "../contracts/app-approval";

const issuer = "https://cloud.example";
const authenticatorOrigin = "https://auth.example";
const id = "ab811792-7476-4a8c-b676-2c6007bb9b5b";
const secret = "A".repeat(43);
const info = {
  protocol: APP_APPROVAL_PROTOCOL,
  issuer,
  api: issuer + APP_APPROVAL_PATH,
  appOrigin: authenticatorOrigin,
  algorithm: "ES256",
  limits: APP_APPROVAL_LIMITS,
};
const expiresAt = () => new Date(Date.now() + 300_000).toISOString();
const payload = (): import("../contracts/app-approval").AppPairingPayload => ({
  protocol: APP_APPROVAL_PROTOCOL,
  issuer,
  pairingId: id,
  secret,
  expiresAt: expiresAt(),
});
const verify = async (key: Awaited<ReturnType<typeof appApproval.createKey>>, message: string, signature: string) => {
  const publicKey = await crypto.subtle.importKey("jwk", key.publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const bytes = Uint8Array.from(atob(signature.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
  expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, bytes, new TextEncoder().encode(message))).toBe(true);
};

describe("public authenticator browser SDK", () => {
  test("one namespace transfers issuer and creates distinct nonextractable keys", async () => {
    const p = payload();
    expect(appApproval.parsePairingLink(appApproval.createPairingLink(authenticatorOrigin, p), authenticatorOrigin)).toEqual(p);
    const first = await appApproval.createKey(),
      second = await appApproval.createKey();
    expect(first.privateKey.extractable).toBe(false);
    expect(first.publicKey).not.toEqual(second.publicKey);
    await expect(crypto.subtle.exportKey("jwk", first.privateKey)).rejects.toThrow();
    expect(structuredClone(first).privateKey.extractable).toBe(false);
  });
  test("claims and device commands use server-verifiable signatures and isolated transport", async () => {
    const key = await appApproval.createKey();
    const calls: string[] = [],
      nonces = new Set<string>();
    const client = await appApproval.connect({
      issuer,
      authenticatorOrigin,
      fetch: async (url, init) => {
        expect(init.credentials).toBe("omit");
        expect(init.redirect).toBe("error");
        expect(init.referrerPolicy).toBe("no-referrer");
        expect(init.cache).toBe("no-store");
        expect(init.signal).toBeDefined();
        calls.push(url);
        if (url.endsWith("/info")) return Response.json(info);
        const body = JSON.parse(String(init.body));
        if (url.endsWith("/pairings/claim")) {
          const claim = AppPairingClaimSchema.parse(body);
          expect(claim.name).toBe("Phone");
          await verify(key, appPairingProofMessage(issuer, claim), claim.signature);
          return Response.json({ deviceId: id, comparison: "000123", expiresAt: expiresAt() });
        }
        if (url.endsWith("/pairings/result")) {
          expect(body.publicKey).toEqual(key.publicKey);
          return Response.json({ state: "confirmed", deviceId: id, comparison: "000123" });
        }
        const request = AppDeviceRequestSchema.parse(body);
        await verify(key, appDeviceProofMessage(request.proof), request.signature);
        expect(nonces.has(request.proof.jti)).toBe(false);
        nonces.add(request.proof.jti);
        const operation = request.proof.command.operation;
        return Response.json(
          operation === "pending"
            ? { requests: [], pollAfterSeconds: 5 }
            : { state: operation === "revoke" ? "revoked" : request.proof.command.decision === "approve" ? "approved" : "denied" },
        );
      },
    });
    expect(calls).toHaveLength(1);
    await client.claim(payload(), key, " Phone ");
    await client.pairingResult(payload(), key);
    const device = { issuer, deviceId: id, key };
    await client.pending(device);
    await client.pending(device);
    const login = { requestId: id, challenge: secret, comparison: "000123", createdAt: new Date().toISOString(), expiresAt: expiresAt() };
    await client.decide(device, login, "approve");
    await client.decide(device, login, "deny");
    await client.revoke(device);
    expect(nonces.size).toBe(5);
    const count = calls.length;
    await expect(client.pending({ ...device, issuer: "https://other.example" })).rejects.toThrow();
    await expect(client.claim({ ...payload(), issuer: "https://other.example" }, key, "Phone")).rejects.toThrow();
    await expect(client.claim({ ...payload(), expiresAt: "2020-01-01T00:00:00.000Z" }, key, "Phone")).rejects.toThrow();
    expect(calls).toHaveLength(count);
  });
  test("discovery cannot substitute another origin, API, protocol or algorithm", async () => {
    for (const changed of [
      { issuer: "https://other.example" },
      { api: "https://other.example/api" },
      { appOrigin: "https://other.example" },
      { protocol: "v2" },
      { algorithm: "none" },
      { limits: {} },
    ]) {
      await expect(
        appApproval.connect({ issuer, authenticatorOrigin, fetch: async () => Response.json({ ...info, ...changed }) }),
      ).rejects.toThrow();
    }
  });
  test("network failures are not retried or leaked; response bodies are bounded", async () => {
    let calls = 0;
    await expect(
      appApproval.connect({
        issuer,
        authenticatorOrigin,
        fetch: async () => {
          calls++;
          throw Error(secret);
        },
      }),
    ).rejects.toThrow("App approval: NETWORK");
    expect(calls).toBe(1);
    await expect(
      appApproval.connect({ issuer, authenticatorOrigin, fetch: async () => new Response(secret, { status: 403 }) }),
    ).rejects.toEqual(new AppApprovalClientError("HTTP", 403));
    await expect(appApproval.connect({ issuer, authenticatorOrigin, fetch: async () => new Response("x".repeat(8193)) })).rejects.toThrow(
      "INVALID_RESPONSE",
    );
  });
});
