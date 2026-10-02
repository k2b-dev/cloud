import { describe, expect, test } from "bun:test";
import { isBrokenProviderConnection, isTransientProviderFailure } from "./provider-errors";

const failure = (code: string) => Object.assign(new Error(code), { code });

describe("provider connection failures", () => {
  test("count a server that could not be reached as transient, but not as a broken connection", () => {
    for (const code of [
      "ECONNREFUSED",
      "EAI_AGAIN",
      "ENOTFOUND",
      "EDNS",
      "ENDPOINT_DNS_TIMEOUT",
      "CONNECT_TIMEOUT",
      "GREETING_TIMEOUT",
      "UPGRADE_TIMEOUT",
    ]) {
      expect(isTransientProviderFailure(failure(code)), code).toBe(true);
      expect(isBrokenProviderConnection(failure(code)), code).toBe(false);
    }
  });

  test("count a connection that broke mid-command as transient and broken", () => {
    for (const code of ["ETIMEOUT", "NoConnection", "EConnectionClosed", "ECONNRESET", "ESOCKET", "ECONNECTION", "ETIMEDOUT"]) {
      expect(isTransientProviderFailure(failure(code)), code).toBe(true);
      expect(isBrokenProviderConnection(failure(code)), code).toBe(true);
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
});
