import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

process.env.APP_SECRET ||= "pulse-public-dashboard-token-test-secret";

const { decryptPublicDashboardToken, encryptPublicDashboardToken, publicDashboardTokenHash, resolvePublicDashboardToken } = await import(
  "./public-dashboard-tokens"
);

describe("Pulse public dashboard tokens", () => {
  test("hashes tokens for lookup without storing the raw token", () => {
    const token = "public-token";

    expect(publicDashboardTokenHash(token)).toBe(createHash("sha256").update(token).digest("hex"));
  });

  test("encrypts copyable tokens at rest", async () => {
    const token = "public-token";

    const encrypted = await encryptPublicDashboardToken(token);

    expect(encrypted).not.toBe(token);
    expect(await decryptPublicDashboardToken(encrypted)).toBe(token);
  });

  test("resolves a new encrypted token when a dashboard is not public yet", async () => {
    const resolved = await resolvePublicDashboardToken({ publicEnabled: false, encryptedToken: null });

    expect(resolved.encryptedToken).not.toBe(resolved.token);
    expect(resolved.tokenHash).toBe(publicDashboardTokenHash(resolved.token));
    expect(await decryptPublicDashboardToken(resolved.encryptedToken)).toBe(resolved.token);
  });

  test("reuses the existing encrypted token for copy-link requests", async () => {
    const encrypted = await encryptPublicDashboardToken("stable-token");

    const resolved = await resolvePublicDashboardToken({ publicEnabled: true, encryptedToken: encrypted });

    expect(resolved.token).toBe("stable-token");
    expect(resolved.encryptedToken).toBe(encrypted);
    expect(resolved.tokenHash).toBe(publicDashboardTokenHash("stable-token"));
  });
});
