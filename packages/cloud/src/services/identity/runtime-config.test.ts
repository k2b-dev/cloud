import { describe, expect, jest, spyOn, test } from "bun:test";
import { env } from "../../config/env";
import * as settings from "../settings";
import {
  CLOUD_INTERNAL_OAUTH_JWKS_PATH,
  CLOUD_INVOCATION_JWKS_PATH,
  CLOUD_OAUTH_JWKS_PATH,
  CLOUD_SESSION_JWKS_PATH,
  IDENTITY_REFRESH_TIMEOUT_MS,
} from "./constants";
import {
  getIdentityRuntimeConfig,
  invalidateIdentityRuntimeConfig,
  resolveInvocationJwksUrl,
  resolveOAuthJwksUrl,
  resolveSessionJwksUrl,
} from "./runtime-config";

test("a hung identity settings load gives up after its bound, and the next caller starts a new one", async () => {
  invalidateIdentityRuntimeConfig();
  const read = spyOn(settings, "get");
  try {
    jest.useFakeTimers();
    read.mockReturnValue(new Promise(() => undefined));
    const hung = getIdentityRuntimeConfig().catch((caught: unknown) => caught);
    jest.advanceTimersByTime(IDENTITY_REFRESH_TIMEOUT_MS);
    expect(await hung).toMatchObject({ name: "TimeoutError", message: "Cloud identity settings did not load within 30 s" });
    read.mockResolvedValue("https://cloud.example");
    expect((await getIdentityRuntimeConfig()).issuer).toBe("https://cloud.example");
  } finally {
    jest.useRealTimers();
    read.mockRestore();
    invalidateIdentityRuntimeConfig();
  }
});

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
    expect(() => resolveSessionJwksUrl("https://cloud.example", "file:///tmp/core")).toThrow("CLOUD_CORE_INTERNAL_ORIGIN");
    expect(() => resolveInvocationJwksUrl("https://cloud.example", "file:///tmp/core")).toThrow("CLOUD_CORE_INTERNAL_ORIGIN");
  });
});

describe("OAuth JWKS transport", () => {
  test("uses the public issuer when no private transport origin is configured", () => {
    expect(resolveOAuthJwksUrl("https://cloud.example", undefined).href).toBe(`https://cloud.example${CLOUD_OAUTH_JWKS_PATH}`);
  });

  test("keeps the public issuer independent from private OAuth transport", () => {
    expect(resolveOAuthJwksUrl("https://cloud.example", "http://app-oauth:3000").href).toBe(
      `http://app-oauth:3000${CLOUD_INTERNAL_OAUTH_JWKS_PATH}`,
    );
  });

  test("rejects non-HTTP transports", () => {
    expect(() => resolveOAuthJwksUrl("https://cloud.example", "file:///tmp/oauth")).toThrow(
      "CLOUD_CORE_INTERNAL_ORIGIN must use http or https",
    );
  });
});

test("all JWKS transports derive from Core origin while keeping the public issuer", () => {
  const core = Object.getOwnPropertyDescriptor(env, "CLOUD_CORE_INTERNAL_ORIGIN")!;
  Object.defineProperty(env, "CLOUD_CORE_INTERNAL_ORIGIN", { value: "http://core:3000", configurable: true });
  try {
    expect(resolveSessionJwksUrl("https://cloud.example").origin).toBe("http://core:3000");
    expect(resolveInvocationJwksUrl("https://cloud.example").origin).toBe("http://core:3000");
    expect(resolveOAuthJwksUrl("https://cloud.example").href).toBe(`http://core:3000${CLOUD_INTERNAL_OAUTH_JWKS_PATH}`);
  } finally {
    Object.defineProperty(env, "CLOUD_CORE_INTERNAL_ORIGIN", core);
  }
});
