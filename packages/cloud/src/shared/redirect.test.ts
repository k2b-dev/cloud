import { describe, expect, test } from "bun:test";
import {
  createAuthLoginUrl,
  createAuthPasswordResetUrl,
  createLoginRedirectUrl,
  DEFAULT_HOME_PATH,
  normalizeRedirectTo,
  redirectPathFromRequestUrl,
  resolveHomePath,
} from "./redirect";

describe("redirect helpers", () => {
  test("normalizes local redirect paths", () => {
    expect(normalizeRedirectTo("/app/dashboard")).toBe("/app/dashboard");
    expect(normalizeRedirectTo("/oauth/authorize?client_id=cli&state=abc")).toBe("/oauth/authorize?client_id=cli&state=abc");
  });

  test("rejects external or ambiguous redirect targets", () => {
    expect(normalizeRedirectTo("https://example.com/app")).toBeUndefined();
    expect(normalizeRedirectTo("//example.com/app")).toBeUndefined();
    expect(normalizeRedirectTo("app/dashboard")).toBeUndefined();
    expect(normalizeRedirectTo("/\\example.com")).toBeUndefined();
    for (const target of ["/.//example.com/app", "/%2e//example.com", "/app/..//example.com", "/\t/example.com"]) {
      expect(normalizeRedirectTo(target)).toBeUndefined();
    }
    expect(normalizeRedirectTo("/app/files/a//b")).toBe("/app/files/a//b");
  });

  test("preserves request query parameters for login redirects", () => {
    expect(redirectPathFromRequestUrl("https://cloud.local/oauth/authorize?client_id=cli&state=abc")).toBe(
      "/oauth/authorize?client_id=cli&state=abc",
    );
    expect(createLoginRedirectUrl("https://cloud.local/oauth/authorize?client_id=cli&state=abc")).toBe(
      "/auth/login?redirectTo=%2Foauth%2Fauthorize%3Fclient_id%3Dcli%26state%3Dabc",
    );
  });

  test("builds magic login links with safe redirects only", () => {
    const safeUrl = createAuthLoginUrl("https://cloud.example", {
      token: "token-id",
      redirectTo: "/oauth/authorize?client_id=cli",
    });
    expect(safeUrl).toBe("https://cloud.example/auth/login?token=token-id&redirectTo=%2Foauth%2Fauthorize%3Fclient_id%3Dcli");

    const externalUrl = createAuthLoginUrl("https://cloud.example", {
      token: "token-id",
      redirectTo: "https://evil.example",
    });
    expect(externalUrl).toBe("https://cloud.example/auth/login?token=token-id");
  });

  test("builds method-specific login links with safe redirects only", () => {
    const url = createAuthLoginUrl("https://cloud.example", {
      method: "ipa",
      redirectTo: "/app/dashboard",
    });

    expect(url).toBe("https://cloud.example/auth/login?method=ipa&redirectTo=%2Fapp%2Fdashboard");
  });

  test("builds password reset links with safe redirects only", () => {
    const safeUrl = createAuthPasswordResetUrl("https://cloud.example", {
      token: "token-id",
      redirectTo: "/app/dashboard",
    });
    expect(safeUrl).toBe("https://cloud.example/auth/password-reset?token=token-id&redirectTo=%2Fapp%2Fdashboard");

    const externalUrl = createAuthPasswordResetUrl("https://cloud.example", {
      token: "token-id",
      redirectTo: "https://evil.example",
    });
    expect(externalUrl).toBe("https://cloud.example/auth/password-reset?token=token-id");
  });
});

describe("resolveHomePath", () => {
  test("preserves the current dashboard default", () => {
    expect(resolveHomePath(undefined)).toBe(DEFAULT_HOME_PATH);
    expect(resolveHomePath("")).toBe(DEFAULT_HOME_PATH);
    expect(resolveHomePath("/app/dashboard")).toBe("/app/dashboard");
  });

  test("accepts local user-facing paths", () => {
    expect(resolveHomePath(" /app/custom-home?view=welcome#today ")).toBe("/app/custom-home?view=welcome#today");
    expect(resolveHomePath("/me")).toBe("/me");
  });

  test("rejects external, recursive, auth, and admin targets", () => {
    for (const value of ["https://example.com", "//example.com", "/\\example.com", "/", "/auth/login", "/admin/settings"]) {
      expect(resolveHomePath(value)).toBe(DEFAULT_HOME_PATH);
    }
  });
});
