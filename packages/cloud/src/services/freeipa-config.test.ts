import { describe, expect, test } from "bun:test";
import { TEST_CA_CERT } from "../server/services/freeipa/test-certificates.test-fixture";
import { resolveFreeIpaTlsOptions, validateFreeIpaCaCert } from "./freeipa-config";

describe("validateFreeIpaCaCert", () => {
  test("allows an empty certificate to select system trust", () => {
    expect(validateFreeIpaCaCert("  ")).toEqual({ ok: true, value: "" });
  });

  test("accepts one or more parseable PEM certificates", () => {
    const single = validateFreeIpaCaCert(TEST_CA_CERT);
    const bundle = validateFreeIpaCaCert(`${TEST_CA_CERT}\n${TEST_CA_CERT}`);

    expect(single.ok).toBe(true);
    expect(bundle.ok).toBe(true);
  });

  test("rejects malformed PEM and non-certificate content", () => {
    expect(validateFreeIpaCaCert("not a certificate").ok).toBe(false);
    expect(validateFreeIpaCaCert("-----BEGIN CERTIFICATE-----\nbroken\n-----END CERTIFICATE-----").ok).toBe(false);
    expect(validateFreeIpaCaCert(`${TEST_CA_CERT}\nprivate material`).ok).toBe(false);
  });

  test("rejects oversized certificate bundles before parsing", () => {
    expect(validateFreeIpaCaCert("x".repeat(256 * 1024 + 1))).toEqual({
      ok: false,
      error: "CA certificate bundle must not exceed 256 KiB",
    });
  });
});

describe("resolveFreeIpaTlsOptions", () => {
  test("keeps verification explicit for system and custom trust", () => {
    expect(resolveFreeIpaTlsOptions("", false)).toEqual({ rejectUnauthorized: true });
    expect(resolveFreeIpaTlsOptions(TEST_CA_CERT, true)).toEqual({
      ca: TEST_CA_CERT,
      rejectUnauthorized: true,
    });
  });

  test("allows insecure TLS only when no CA certificate is configured", () => {
    expect(resolveFreeIpaTlsOptions("", true)).toEqual({ rejectUnauthorized: false });
  });
});
