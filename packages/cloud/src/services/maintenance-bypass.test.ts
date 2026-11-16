import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  issueMaintenanceBypassToken,
  MAINTENANCE_BYPASS_MAX_TOKEN_LENGTH,
  MAINTENANCE_BYPASS_TTL_MS,
  verifyMaintenanceBypassToken,
} from "./maintenance-bypass";

const NOW = Date.UTC(2026, 10, 16, 13, 2);
const scope = { id: "8b0f5c1e-3b9a-4c55-9d0e-2f7a1c6b4e90", bypassKey: "A".repeat(43) };
const subject = "0b6f2e3c-6f0e-4d8e-9a77-3f1c2b9d4e51";
const expiresAt = NOW + MAINTENANCE_BYPASS_TTL_MS;

/** A token signed with `key` over an arbitrary payload, to probe the parser behind a valid signature. */
const forge = (claims: unknown, key = scope.bypassKey): string => {
  const payload = Buffer.from(typeof claims === "string" ? claims : JSON.stringify(claims)).toString("base64url");
  return `${payload}.${createHmac("sha256", Buffer.from(key, "base64url")).update(payload).digest("base64url")}`;
};

test("a token issued for this maintenance verifies until it expires", () => {
  const token = issueMaintenanceBypassToken(scope, subject, expiresAt);
  expect(token.length).toBeLessThan(MAINTENANCE_BYPASS_MAX_TOKEN_LENGTH);
  expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  expect(token).not.toContain(scope.bypassKey);
  expect(verifyMaintenanceBypassToken(token, scope, NOW)).toEqual({ subject, expiresAt });
  expect(verifyMaintenanceBypassToken(token, scope, expiresAt - 1000)).toEqual({ subject, expiresAt });
  expect(verifyMaintenanceBypassToken(token, scope, expiresAt)).toBeNull();
});

test("another key, another maintenance or no maintenance never verify", () => {
  const token = issueMaintenanceBypassToken(scope, subject, expiresAt);
  expect(verifyMaintenanceBypassToken(token, { ...scope, bypassKey: "B".repeat(43) }, NOW)).toBeNull();
  expect(verifyMaintenanceBypassToken(token, { ...scope, id: "1c2d3e4f-0000-4000-8000-000000000000" }, NOW)).toBeNull();
  // Same key, other maintenance id inside a correctly signed token.
  expect(verifyMaintenanceBypassToken(forge({ v: 1, m: "other", s: subject, exp: expiresAt / 1000 }), scope, NOW)).toBeNull();
  expect(verifyMaintenanceBypassToken(token, null, NOW)).toBeNull();
});

test("a tampered payload or signature fails before anything is parsed", () => {
  const token = issueMaintenanceBypassToken(scope, subject, expiresAt);
  const [payload, signature] = token.split(".") as [string, string];
  const later = Buffer.from(JSON.stringify({ v: 1, m: scope.id, s: subject, exp: expiresAt / 1000 + 3600 })).toString("base64url");
  expect(verifyMaintenanceBypassToken(`${later}.${signature}`, scope, NOW)).toBeNull();
  const flipped = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
  expect(verifyMaintenanceBypassToken(`${payload}.${flipped}`, scope, NOW)).toBeNull();
  expect(verifyMaintenanceBypassToken(`${payload}.${signature}x`, scope, NOW)).toBeNull();
});

test("oversized, garbage and malformed claims are refused, even with a valid signature", () => {
  const exp = expiresAt / 1000;
  for (const value of [
    undefined,
    null,
    42,
    "",
    ".",
    "abc",
    "a.b.c",
    `${"a".repeat(MAINTENANCE_BYPASS_MAX_TOKEN_LENGTH)}.${"b".repeat(43)}`,
    "äöü.xyz",
    forge("not json"),
    forge([1, scope.id]),
    forge({ v: 2, m: scope.id, s: subject, exp }),
    forge({ v: 1, m: scope.id, s: "", exp }),
    forge({ v: 1, m: scope.id, s: "x".repeat(201), exp }),
    forge({ v: 1, m: scope.id, s: subject, exp: String(exp) }),
    forge({ v: 1, m: scope.id, s: subject, exp: exp + 0.5 }),
    forge({ v: 1, m: scope.id, s: subject, exp, admin: true }),
    // Signed, but valid for far longer than any issued link.
    forge({ v: 1, m: scope.id, s: subject, exp: exp + 24 * 3600 }),
  ])
    expect(verifyMaintenanceBypassToken(value, scope, NOW)).toBeNull();
  expect(verifyMaintenanceBypassToken(forge({ v: 1, m: scope.id, s: subject, exp }), scope, NOW)).toEqual({ subject, expiresAt });
});
