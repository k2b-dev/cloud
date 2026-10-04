import { describe, expect, test } from "bun:test";
import { isProviderAuthenticationFailure, isProviderTimeout, isTransientProviderFailure } from "./provider-errors";

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
    // Gmail refuses a login over its connection limit with [ALERT].
    const connectionLimit = Object.assign(new Error("Command failed"), {
      authenticationFailed: true,
      serverResponseCode: "ALERT",
      responseText: "Too many simultaneous connections. (Failure)",
    });
    expect(isTransientProviderFailure(connectionLimit)).toBe(true);
    expect(isProviderAuthenticationFailure(connectionLimit)).toBe(false);
    for (const rejected of [
      Object.assign(new Error("Command failed"), { authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" }),
      // Any other alert, such as one that asks for an app password, needs the user.
      Object.assign(new Error("Command failed"), {
        authenticationFailed: true,
        serverResponseCode: "ALERT",
        responseText: "Application-specific password required",
      }),
      // Many servers reject a wrong password without a response code.
      Object.assign(new Error("Command failed"), { authenticationFailed: true }),
    ]) {
      expect(isTransientProviderFailure(rejected)).toBe(false);
      expect(isProviderAuthenticationFailure(rejected)).toBe(true);
    }
  });

  test("count a login whose connection broke, or that the SMTP server cannot check for now, as transient", () => {
    // ImapFlow marks every failed LOGIN as an authentication failure, also one whose connection closed before the reply.
    const dropped = Object.assign(new Error("Connection not available"), { code: "NoConnection", authenticationFailed: true });
    // RFC 4954: 454 4.7.0 Temporary authentication failure.
    const smtpTemporary = Object.assign(new Error("Invalid login: 454 4.7.0 Temporary authentication failure"), {
      code: "EAUTH",
      responseCode: 454,
    });
    for (const error of [dropped, smtpTemporary]) {
      expect(isTransientProviderFailure(error), error.message).toBe(true);
      expect(isProviderAuthenticationFailure(error), error.message).toBe(false);
    }
    const smtpRejected = Object.assign(new Error("Invalid login: 535 5.7.8 Authentication credentials invalid"), {
      code: "EAUTH",
      responseCode: 535,
    });
    expect(isTransientProviderFailure(smtpRejected)).toBe(false);
    expect(isProviderAuthenticationFailure(smtpRejected)).toBe(true);
  });

  test("count an SMTP server that closes the channel with 421 as transient", () => {
    // Nodemailer reports a 421 greeting, such as at the server's connection limit, as EPROTOCOL.
    const greeting = Object.assign(new Error("Invalid greeting. response=421 4.7.0 Error: too many connections"), {
      code: "EPROTOCOL",
      responseCode: 421,
    });
    expect(isTransientProviderFailure(greeting)).toBe(true);
    expect(isProviderAuthenticationFailure(greeting)).toBe(false);
    expect(
      isTransientProviderFailure(Object.assign(new Error("Invalid greeting. response=554"), { code: "EPROTOCOL", responseCode: 554 })),
    ).toBe(false);
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
    // A provider whose login service is down refuses IMAP and SMTP logins for now.
    const imapUnavailable = Object.assign(new Error("Command failed"), { authenticationFailed: true, serverResponseCode: "UNAVAILABLE" });
    const smtpTemporary = Object.assign(new Error("Invalid login: 454 4.7.0 Temporary authentication failure"), {
      code: "EAUTH",
      responseCode: 454,
    });
    expect(isTransientProviderFailure(verification(imapUnavailable, smtpTemporary))).toBe(true);
    expect(isProviderAuthenticationFailure(verification(imapUnavailable, smtpTemporary))).toBe(false);
    const smtpRejected = Object.assign(new Error("Invalid login: 535 5.7.8 rejected"), { code: "EAUTH", responseCode: 535 });
    expect(isTransientProviderFailure(verification(smtpRejected))).toBe(false);
    expect(isProviderAuthenticationFailure(verification(smtpRejected))).toBe(true);
    expect(isTransientProviderFailure(verification(failure("ETLS")))).toBe(false);
    expect(isTransientProviderFailure(verification())).toBe(false);
  });

  test("count only a provider that did not answer before a timeout as timed out, also behind a verification", () => {
    for (const code of ["ENDPOINT_DNS_TIMEOUT", "CONNECT_TIMEOUT", "GREETING_TIMEOUT", "UPGRADE_TIMEOUT", "ETIMEDOUT", "ETIMEOUT"]) {
      expect(isProviderTimeout(failure(code))).toBe(true);
    }
    // Refused, dropped, or limited connections fail fast.
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "NoConnection", "ECONNRESET", "EPIPE"]) {
      expect(isProviderTimeout(failure(code))).toBe(false);
    }
    expect(isProviderTimeout(Object.assign(new Error("Command failed"), { authenticationFailed: true, serverResponseCode: "LIMIT" }))).toBe(
      false,
    );
    const verification = (...failures: unknown[]) =>
      Object.assign(new Error("IMAP: ...; SMTP: ..."), { code: "PROVIDER_TRANSPORT_VERIFICATION_FAILED", failures });
    expect(isProviderTimeout(verification(failure("CONNECT_TIMEOUT"), failure("ECONNREFUSED")))).toBe(true);
    expect(isProviderTimeout(verification(failure("ECONNREFUSED")))).toBe(false);
  });
});
