import { describe, expect, test } from "bun:test";
import { afterSignInHref, isReauthenticationRequest, resolveAuthenticatedLoginRedirect } from "./login-redirect";

test("all sign-in completions preserve only local destinations through consent", () => {
  expect(afterSignInHref("/app/contacts?view=mine#entry")).toBe("/auth/continue?redirectTo=%2Fapp%2Fcontacts%3Fview%3Dmine%23entry");
  expect(afterSignInHref("https://other.example")).toBe("/auth/continue?redirectTo=%2F");
});

test("reauthentication and email completion can show credentials without a logout or external redirect", () => {
  const target = encodeURIComponent("/me/security?reauthenticate=1&pairDevice=user-id");
  expect(isReauthenticationRequest(`https://cloud.example/auth/login?redirectTo=${target}`)).toBe(true);
  expect(isReauthenticationRequest(`https://cloud.example/auth/login?token=proof&redirectTo=${target}`)).toBe(true);
  expect(isReauthenticationRequest("https://cloud.example/auth/login?redirectTo=%2Fme%2Fsecurity")).toBe(false);
  expect(isReauthenticationRequest("https://cloud.example/auth/login?redirectTo=https://evil.example/?reauthenticate=1")).toBe(false);
});

const loginUrl = (params = "") => `https://cloud.example/auth/login${params ? `?${params}` : ""}`;

describe("resolveAuthenticatedLoginRedirect", () => {
  test("preserves an OAuth authorization request including PKCE state", () => {
    const target =
      "/oauth/authorize?client_id=cloud-cli&response_type=code&state=opaque-state&code_challenge=opaque-challenge&code_challenge_method=S256&redirect_uri=http%3A%2F%2F127.0.0.1%3A49574%2Fcallback";

    expect(resolveAuthenticatedLoginRedirect(loginUrl(`redirectTo=${encodeURIComponent(target)}`))).toBe(target);
  });

  test("preserves local deep-link queries and fragments", () => {
    const target = "/app/mail?conversation=abc#message-42";

    expect(resolveAuthenticatedLoginRedirect(loginUrl(`redirectTo=${encodeURIComponent(target)}`))).toBe(target);
  });

  test.each([
    ["a missing target", ""],
    ["an external URL", `redirectTo=${encodeURIComponent("https://example.com/steal")}`],
    ["a protocol-relative URL", `redirectTo=${encodeURIComponent("//example.com/steal")}`],
    ["a backslash-based URL", `redirectTo=${encodeURIComponent("/\\example.com/steal")}`],
    ["a malformed encoded value", "redirectTo=%E0%A4%A"],
  ])("falls back to the home page for %s", (_case, params) => {
    expect(resolveAuthenticatedLoginRedirect(loginUrl(params))).toBe("/");
  });

  test("does not bypass a magic-link request", () => {
    const target = "/oauth/authorize?client_id=cloud-cli";

    expect(resolveAuthenticatedLoginRedirect(loginUrl(`token=magic-token&redirectTo=${encodeURIComponent(target)}`))).toBe("/");
  });

  test("does not redirect the login guard back into itself", () => {
    const target = "/auth/login?redirectTo=%2Fapp%2Fmail";

    expect(resolveAuthenticatedLoginRedirect(loginUrl(`redirectTo=${encodeURIComponent(target)}`))).toBe("/");
  });
});
