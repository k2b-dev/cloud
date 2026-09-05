import { describe, expect, test } from "bun:test";
import { CLOUD_INVOCATION_JWKS_PATH, CLOUD_OAUTH_JWKS_PATH, CLOUD_SESSION_JWKS_PATH } from "./constants";
import { resolveInvocationJwksUrl, resolveOAuthJwksUrl, resolveSessionJwksUrl } from "./runtime-config";

describe("identity JWKS transport", () => {
  test("uses the public issuer when no private transport origin is configured", () => {
    expect(resolveSessionJwksUrl("https://cloud.example", undefined).href).toBe(`https://cloud.example${CLOUD_SESSION_JWKS_PATH}`);
    expect(resolveInvocationJwksUrl("https://cloud.example", undefined).href).toBe(`https://cloud.example${CLOUD_INVOCATION_JWKS_PATH}`);
  });

  test("keeps the public issuer independent from a private HTTP transport", () => {
    expect(resolveSessionJwksUrl("https://cloud.example", "http://app-core:3000").href).toBe(
      `http://app-core:3000${CLOUD_SESSION_JWKS_PATH}`,
    );
    expect(resolveInvocationJwksUrl("https://cloud.example", "http://app-core:3000").href).toBe(
      `http://app-core:3000${CLOUD_INVOCATION_JWKS_PATH}`,
    );
  });

  test("rejects non-HTTP transports", () => {
    expect(() => resolveSessionJwksUrl("https://cloud.example", "file:///tmp/core")).toThrow(
      "CLOUD_IDENTITY_JWKS_ORIGIN must use http or https",
    );
    expect(() => resolveInvocationJwksUrl("https://cloud.example", "file:///tmp/core")).toThrow(
      "CLOUD_IDENTITY_JWKS_ORIGIN must use http or https",
    );
  });
});

describe("OAuth JWKS transport", () => {
  test("uses the public issuer when no private transport origin is configured", () => {
    expect(resolveOAuthJwksUrl("https://cloud.example", undefined).href).toBe(`https://cloud.example${CLOUD_OAUTH_JWKS_PATH}`);
  });

  test("keeps the public issuer independent from private OAuth transport", () => {
    expect(resolveOAuthJwksUrl("https://cloud.example", "http://app-oauth:3000").href).toBe(
      `http://app-oauth:3000${CLOUD_OAUTH_JWKS_PATH}`,
    );
  });

  test("rejects non-HTTP transports", () => {
    expect(() => resolveOAuthJwksUrl("https://cloud.example", "file:///tmp/oauth")).toThrow(
      "CLOUD_OAUTH_JWKS_ORIGIN must use http or https",
    );
  });
});
