import { describe, expect, test } from "bun:test";
import { APP_APPROVAL_LIMITS } from "./app-approval";
import {
  isPwaPartId,
  isPwaShellAvailable,
  PWA_LIMITS,
  PwaCompleteResultSchema,
  PwaPairingStatusSchema,
  pairingLink,
  parsePairingLink,
} from "./pwa";

const origin = "https://cloud.example.test";
const secret = "A".repeat(42) + "w";

describe("mobile app contract", () => {
  test("the shell is available only while the app pwa owns /pwa", () => {
    expect(isPwaShellAvailable([])).toBeFalse();
    expect(isPwaShellAvailable([{ id: "core", routes: ["/", "/pwa/_auth"] }])).toBeFalse();
    expect(isPwaShellAvailable([{ id: "pwa", routes: ["/public/pwa"] }])).toBeFalse();
    expect(isPwaShellAvailable([{ id: "spaces", routes: ["/pwa"] }])).toBeFalse();
    expect(isPwaShellAvailable([{ id: "pwa", routes: ["/pwa", "/public/pwa"] }])).toBeTrue();
  });

  test("a part needs a plain app id that the shell does not use", () => {
    expect(["spaces", "time-tracking", "a1"].map(isPwaPartId)).toEqual([true, true, true]);
    expect(["pwa", "settings", "offline", "_auth", "spaces/tasks", "Spaces", "", "1x"].map(isPwaPartId)).toEqual(Array(8).fill(false));
  });

  test("shared limits match Cloud Login", () => {
    expect(PWA_LIMITS.bodyBytes).toBe(APP_APPROVAL_LIMITS.bodyBytes);
    expect(PWA_LIMITS.recentSessionSeconds).toBe(APP_APPROVAL_LIMITS.recentSessionSeconds);
    expect(PWA_LIMITS.devicesPerAccount).toBe(APP_APPROVAL_LIMITS.devicesPerAccount);
    expect(PWA_LIMITS.pendingPerAccount).toBe(APP_APPROVAL_LIMITS.pendingPerAccount);
    expect(PWA_LIMITS.pollSeconds).toBe(APP_APPROVAL_LIMITS.pollSeconds);
  });

  test("the pairing link carries the secret only in the fragment", () => {
    const link = pairingLink(`${origin}/`, secret);
    expect(link).toBe(`${origin}/pwa/#pair=${secret}`);
    expect(new URL(link).search).toBe("");
    expect(() => pairingLink(origin, "short")).toThrow();
  });

  test("the parser accepts only this Cloud's pairing link", () => {
    expect(parsePairingLink(`  ${origin}/pwa/#pair=${secret}\n`, origin)).toEqual({ ok: true, secret });
    expect(parsePairingLink(`https://other.example.test/pwa/#pair=${secret}`, origin)).toEqual({ ok: false, reason: "other-cloud" });
    expect(parsePairingLink(`https://login.example.test/#pairing=%7B%7D`, origin)).toEqual({ ok: false, reason: "cloud-login" });
    for (const text of [
      "not a link",
      `${origin}/pwa/?x=1#pair=${secret}`,
      `${origin}/pwa#pair=${secret}`,
      `${origin}/pwa/spaces#pair=${secret}`,
      `${origin}/pwa/#pair=${secret}x`,
      `${origin}/pwa/#pair=`,
      `https://user:pass@cloud.example.test/pwa/#pair=${secret}`,
      `${origin}/pwa/#pair=${secret}${" ".repeat(PWA_LIMITS.bodyBytes)}`,
    ])
      expect(parsePairingLink(text, origin)).toEqual({ ok: false, reason: "invalid" });
  });

  test("status never carries a code and completion distinguishes waiting from paired", () => {
    const status = {
      state: "claimed" as const,
      claimUntil: "2026-10-03T10:05:00.000Z",
      expiresAt: "2026-10-03T10:10:00.000Z",
      device: { name: "iPhone", platform: "ios" as const },
      attemptsLeft: 3,
    };
    expect(PwaPairingStatusSchema.parse(status)).toEqual(status);
    expect(PwaPairingStatusSchema.safeParse({ ...status, code: "123456" }).success).toBeFalse();
    expect(PwaCompleteResultSchema.parse({ state: "paired" })).toEqual({ state: "paired" });
    expect(PwaCompleteResultSchema.safeParse({ state: "waiting" }).success).toBeFalse();
  });
});
