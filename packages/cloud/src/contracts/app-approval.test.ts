import { describe, expect, test } from "bun:test";
import {
  AppDevicePublicKeySchema,
  AppDeviceRequestSchema,
  AppPairingClaimSchema,
  appDeviceProofMessage,
  appPairingProofMessage,
  appPairingLink,
  parseAppPairingLink,
  APP_APPROVAL_PROTOCOL,
  type AppDeviceProof,
} from "./app-approval";

const coordinate = "A".repeat(43);
const key = { kty: "EC", crv: "P-256", x: coordinate, y: coordinate } as const;
const id = "ab811792-7476-4a8c-b676-2c6007bb9b5b";
const proof: AppDeviceProof = {
  issuer: "https://cloud.example",
  deviceId: id,
  jti: id,
  issuedAt: 100,
  expiresAt: 160,
  command: { operation: "pending" },
};
describe("app approval wire encoding", () => {
  const pairing: import("./app-approval").AppPairingPayload = {
    protocol: APP_APPROVAL_PROTOCOL,
    issuer: proof.issuer,
    pairingId: id,
    secret: coordinate,
    expiresAt: "2026-09-08T18:00:00.000Z",
  };
  const authenticator = "https://auth.example";
  test("QR, copied text and same-device links carry the identical pairing payload", () => {
    const link = appPairingLink(authenticator, pairing);
    expect(parseAppPairingLink(link, authenticator)).toEqual(pairing);
    expect(parseAppPairingLink(`  ${link}\n`, authenticator)).toEqual(pairing);
    const url = new URL(link);
    expect(url.pathname).toBe("/");
    expect(url.search).toBe("");
    expect(url.hash).toContain("pairing=");
    expect(
      parseAppPairingLink(appPairingLink(authenticator, { ...pairing, issuer: "https://other-cloud.example" }), authenticator).issuer,
    ).toBe("https://other-cloud.example");
  });
  test("copied links reject other authenticators, query secrets and malformed payloads", () => {
    const link = appPairingLink(authenticator, pairing);
    for (const invalid of [
      link.replace(authenticator, "https://evil.example"),
      link.replace("/#", "/?secret=leak#"),
      `${authenticator}/#pairing=%XX`,
      `${authenticator}/#pairing=%7B%7D`,
      "123456",
      "x".repeat(8193),
    ]) {
      expect(() => parseAppPairingLink(invalid, authenticator)).toThrow();
    }
  });
  test("issuer origins reject remote HTTP, credentials and paths; local tests remain possible", () => {
    for (const issuer of [
      "http://cloud.example",
      "https://user:secret@cloud.example",
      "https://cloud.example/path",
      "https://cloud.example?secret=x",
      "javascript:alert(1)",
    ]) {
      expect(() => appPairingLink(authenticator, { ...pairing, issuer })).toThrow();
      const forged = `${authenticator}/#pairing=${encodeURIComponent(JSON.stringify({ ...pairing, issuer }))}`;
      expect(() => parseAppPairingLink(forged, authenticator)).toThrow();
    }
    const local = { ...pairing, issuer: "http://localhost:3000" };
    expect(parseAppPairingLink(appPairingLink("http://localhost:4000", local), "http://localhost:4000")).toEqual(local);
  });
  test("fixed golden signing messages bind purpose and every command field", () => {
    expect(appDeviceProofMessage(proof)).toBe(
      `["cloud-app-approval-v1","device","https://cloud.example","${id}","${id}",100,160,"pending"]`,
    );
    const command = { operation: "decide", requestId: id, challenge: coordinate, comparison: "000123", decision: "approve" } as const;
    expect(appDeviceProofMessage({ ...proof, command })).toBe(
      `["cloud-app-approval-v1","device","https://cloud.example","${id}","${id}",100,160,"decide","${id}","${coordinate}","000123","approve"]`,
    );
    expect(appDeviceProofMessage({ ...proof, command: { ...command, decision: "deny" } })).not.toBe(
      appDeviceProofMessage({ ...proof, command }),
    );
  });
  test("pairing binds exact issuer, secret, public key and escaped device name", () => {
    const claim = { pairingId: id, secret: coordinate, publicKey: key, name: 'Phone "one"' };
    expect(JSON.parse(appPairingProofMessage(proof.issuer, claim))).toEqual([
      "cloud-app-approval-v1",
      "pair",
      proof.issuer,
      id,
      coordinate,
      "EC",
      "P-256",
      coordinate,
      coordinate,
      claim.name,
    ]);
  });
  test("private keys, extra commands and noncanonical base64url are rejected", () => {
    expect(AppDevicePublicKeySchema.safeParse({ ...key, d: coordinate }).success).toBe(false);
    expect(AppDevicePublicKeySchema.safeParse({ ...key, x: "A".repeat(42) + "B" }).success).toBe(false);
    expect(
      AppDeviceRequestSchema.safeParse({ proof: { ...proof, command: { operation: "pending", userId: id } }, signature: "A".repeat(86) })
        .success,
    ).toBe(false);
  });
  test("name normalization precedes signing and request-size fields are bounded", () => {
    const claim = { pairingId: id, secret: coordinate, publicKey: key, name: " Phone ", signature: "A".repeat(86) };
    expect(AppPairingClaimSchema.parse(claim).name).toBe("Phone");
    expect(AppPairingClaimSchema.safeParse({ ...claim, name: "a".repeat(81) }).success).toBe(false);
  });
});
