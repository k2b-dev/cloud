import { describe, expect, test } from "bun:test";
import { isProviderAuthenticationFailure, isTransientProviderFailure } from "./provider-errors";

const failure = (code: string) => Object.assign(new Error(code), { code });

describe("provider connection failures", () => {
  test("count a server that could not be reached or a connection that broke mid-command as transient", () => {
    for (const code of [
      "ECONNREFUSED",
      "EAI_AGAIN",
      "ENOTFOUND",
      "EDNS",
      "ENDPOINT_DNS_TIMEOUT",
      "CONNECT_TIMEOUT",
      "GREETING_TIMEOUT",
      "UPGRADE_TIMEOUT",
      "ETIMEOUT",
      "NoConnection",
      "EConnectionClosed",
      "ECONNRESET",
      "ESOCKET",
      "ECONNECTION",
      "ETIMEDOUT",
    ]) {
      expect(isTransientProviderFailure(failure(code)), code).toBe(true);
    }
  });

  test("leave failures about the request or the account to their own handling", () => {
    for (const error of [
      failure("ENDPOINT_BLOCKED"),
      failure("EAUTH"),
      failure("ETLS"),
      failure("REMOTE_MESSAGE_MISSING"),
      new Error("plain failure"),
      null,
    ]) {
      expect(isTransientProviderFailure(error)).toBe(false);
    }
  });

  test("count a login the server refuses for now as transient, not as rejected credentials", () => {
    for (const serverResponseCode of ["UNAVAILABLE", "INUSE", "LIMIT"]) {
      const refusal = Object.assign(new Error("Command failed"), { authenticationFailed: true, serverResponseCode });
      expect(isTransientProviderFailure(refusal), serverResponseCode).toBe(true);
      expect(isProviderAuthenticationFailure(refusal), serverResponseCode).toBe(false);
    }
    for (const rejected of [
      Object.assign(new Error("Command failed"), { authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" }),
      // Many servers reject a wrong password without a response code.
      Object.assign(new Error("Command failed"), { authenticationFailed: true }),
    ]) {
      expect(isTransientProviderFailure(rejected)).toBe(false);
      expect(isProviderAuthenticationFailure(rejected)).toBe(true);
    }
  });

  test("classify a failed IMAP and SMTP verification by the failures behind it", () => {
    const verification = (...failures: unknown[]) =>
      Object.assign(new Error("IMAP: ...; SMTP: ..."), { code: "PROVIDER_TRANSPORT_VERIFICATION_FAILED", failures });
    const unreachable = failure("ECONNREFUSED");
    const rejected = Object.assign(new Error("Command failed"), { authenticationFailed: true });
    expect(isTransientProviderFailure(verification(unreachable, failure("ETIMEDOUT")))).toBe(true);
    expect(isProviderAuthenticationFailure(verification(unreachable))).toBe(false);
    expect(isTransientProviderFailure(verification(unreachable, rejected))).toBe(false);
    expect(isProviderAuthenticationFailure(verification(unreachable, rejected))).toBe(true);
    expect(isTransientProviderFailure(verification(failure("ETLS")))).toBe(false);
    expect(isTransientProviderFailure(verification())).toBe(false);
  });
});
