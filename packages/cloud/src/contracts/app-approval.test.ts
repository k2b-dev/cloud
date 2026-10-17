import { describe, expect, test } from "bun:test";
import {
  APP_APPROVAL_LIMITS,
  APP_APPROVAL_PROTOCOL,
  type AppActionView,
  AppActionViewSchema,
  AppDeviceCommandSchema,
  AppDeviceInboxSchema,
  type AppDeviceProof,
  AppDevicePublicKeySchema,
  AppDeviceRequestSchema,
  AppPairingClaimSchema,
  AppPendingLoginSchema,
  appActionDigest,
  appActionDigestMessage,
  appDeviceProofMessage,
  appPairingLink,
  appPairingProofMessage,
  parseAppPairingLink,
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
    expect(appDeviceProofMessage({ ...proof, command: { operation: "account" } })).toBe(
      `["cloud-app-approval-v1","device","https://cloud.example","${id}","${id}",100,160,"account"]`,
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

const actionView: AppActionView = {
  actionId: id,
  app: { id: "mail", name: "Mail" },
  requester: { app: { id: "assistant", name: "Assistant" }, title: "A letter" },
  assurance: "confirm",
  sentence: "Send draft",
  message: "Send this letter?",
  details: [{ label: "When", value: "2026-10-11", format: "date" }],
  truncated: false,
  createdAt: "2026-10-11T10:00:00.000Z",
  expiresAt: "2026-10-12T10:00:00.000Z",
  argsDigest: "stored-args-digest",
  digest: coordinate,
};

test("Action proof appendices bind the id, view digest and decision", () => {
  const base = [APP_APPROVAL_PROTOCOL, "device", proof.issuer, id, id, 100, 160];
  expect(JSON.parse(appDeviceProofMessage({ ...proof, command: { operation: "action", actionId: id } }))).toEqual([...base, "action", id]);
  expect(
    JSON.parse(appDeviceProofMessage({ ...proof, command: { operation: "act", actionId: id, digest: coordinate, decision: "deny" } })),
  ).toEqual([...base, "act", id, coordinate, "deny"]);
});

test("the Action digest binds every shown field and the stored input", async () => {
  expect(JSON.parse(appActionDigestMessage(proof.issuer, actionView))).toEqual([
    "cloud-action-v1",
    proof.issuer,
    id,
    "mail",
    "Mail",
    "assistant",
    "Assistant",
    "A letter",
    "confirm",
    "Send draft",
    "Send this letter?",
    [["When", "2026-10-11", "date"]],
    false,
    actionView.createdAt,
    actionView.expiresAt,
    "stored-args-digest",
  ]);
  const digest = await appActionDigest(proof.issuer, actionView);
  const changes: Partial<AppActionView>[] = [
    { sentence: "Delete draft" },
    { message: "Changed" },
    { app: { ...actionView.app, name: "Post" } },
    { requester: { ...actionView.requester, title: "Other chat" } },
    { details: [{ label: "When", value: "2026-10-12", format: "date" }] },
    { details: [{ label: "When", value: "2026-10-11" }] },
    { truncated: true },
    { expiresAt: "2026-10-13T10:00:00.000Z" },
    { argsDigest: "changed-input" },
  ];
  for (const change of changes) expect(await appActionDigest(proof.issuer, { ...actionView, ...change })).not.toBe(digest);
  expect(await appActionDigest("https://other.example", actionView)).not.toBe(digest);
});

test("Action views reject bidi overrides and newlines in every shown text field", () => {
  for (const unsafe of ["unsafe\u202e", "unsafe\ntext"]) {
    for (const change of [
      { sentence: unsafe },
      { message: unsafe },
      { app: { ...actionView.app, name: unsafe } },
      { requester: { ...actionView.requester, title: unsafe } },
      { details: [{ label: "Text", value: unsafe }] },
    ])
      expect(AppActionViewSchema.safeParse({ ...actionView, ...change }).success).toBe(false);
  }
});

test("inbox opt-in has a single nested signing appendix and strict unique capabilities", () => {
  const base = `["cloud-app-approval-v1","device","https://cloud.example","${id}","${id}",100,160,"inbox"`;
  expect(appDeviceProofMessage({ ...proof, command: { operation: "inbox" } })).toBe(`${base}]`);
  expect(appDeviceProofMessage({ ...proof, command: { operation: "inbox", accept: ["terminal-logins"] } })).toBe(
    `${base},["terminal-logins"]]`,
  );
  for (const accept of [[], ["unknown"], ["terminal-logins", "terminal-logins"]])
    expect(AppDeviceCommandSchema.safeParse({ operation: "inbox", accept }).success).toBe(false);
});

test("terminal consent is strict, plain and bounded within a five-login inbox", () => {
  const terminal = {
    client: { id: "c".repeat(256), name: "😀".repeat(60) },
    scopes: Array.from({ length: 16 }, (_, i) => `s${i}`.padEnd(40, "x")),
    lifetimeSeconds: 7_776_000,
  };
  const login = {
    requestId: id,
    challenge: coordinate,
    comparison: "000123",
    createdAt: "2026-10-11T10:00:00.000Z",
    expiresAt: "2026-10-11T10:05:00.000Z",
    terminal,
  };
  expect(AppPendingLoginSchema.parse(login)).toEqual(login);
  for (const change of [
    { ...terminal, extra: true },
    { ...terminal, client: { ...terminal.client, extra: true } },
    { ...terminal, client: { id: "cli", name: "client\u202e" } },
    { ...terminal, scopes: ["admin scope"] },
    { ...terminal, lifetimeSeconds: 0 },
  ])
    expect(AppPendingLoginSchema.safeParse({ ...login, terminal: change }).success).toBe(false);
  const inbox = AppDeviceInboxSchema.parse({ logins: Array(5).fill(login), actions: [], moreActions: 0, pollAfterSeconds: 5 });
  expect(new TextEncoder().encode(JSON.stringify(inbox)).length).toBeLessThanOrEqual(APP_APPROVAL_LIMITS.bodyBytes);
});
