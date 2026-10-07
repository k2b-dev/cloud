import { expect, spyOn, test } from "bun:test";
import { sendEmail } from "../notifications/email";
import * as settings from "../settings";
import { coreSettings } from "../settings/api";
import * as store from "./store";
import { smtpFailureMessage } from "./test-send";
import * as transport from "./transport";

const credentials = {
  smtpHost: "smtp.example.org",
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: null,
  smtpPassword: null,
  fromAddress: "sender@example.org",
  fromName: null,
};
test("transport honors explicit TLS mode, omits empty auth, and bounds SMTP timeouts", () => {
  const anonymous = transport.buildMailTransport(credentials);
  expect(anonymous.options).toMatchObject({
    host: credentials.smtpHost,
    port: 587,
    secure: false,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 60000,
  });
  expect(anonymous.options).not.toHaveProperty("auth");
  const authenticated = transport.buildMailTransport({
    ...credentials,
    smtpPort: 465,
    smtpSecure: false,
    smtpUser: "user",
    smtpPassword: "secret",
  });
  expect(authenticated.options).toMatchObject({ secure: false, auth: { user: "user", pass: "secret" } });
  anonymous.close();
  authenticated.close();
});
test("SMTP failures redact plaintext and authentication encodings", () => {
  const plain = "\0user\0password";
  const message = smtpFailureMessage(
    new Error(`535 password ${Buffer.from("password").toString("base64")} ${Buffer.from(plain).toString("base64")}`),
    ["password", plain],
  );
  expect(message).toStartWith("535");
  expect(message).not.toContain("password");
  expect(message).not.toContain(Buffer.from(plain).toString("base64"));
});
test("notification email uses the default profile sender and preserves its HTML frame and message id", async () => {
  const resolve = spyOn(store, "resolveMailCredentials").mockResolvedValue(credentials);
  const smtp = transport.buildMailTransport(credentials);
  const send = spyOn(smtp, "sendMail").mockImplementation(async () => ({
    messageId: "sent",
    envelope: { from: "sender@example.org", to: ["recipient@example.org"] },
    accepted: ["recipient@example.org"],
    rejected: [],
  }));
  const builder = spyOn(transport, "buildMailTransport").mockReturnValue(smtp);
  const read = spyOn(settings, "get").mockResolvedValue("Cloud");
  const logo = spyOn(coreSettings, "get").mockResolvedValue("");
  try {
    await sendEmail("recipient@example.org", "Subject", { content: "Hello", messageId: "<test@example.org>" });
    expect(resolve).toHaveBeenCalledWith();
    expect(builder).toHaveBeenCalledWith(credentials);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      from: { address: "sender@example.org", name: "Cloud" },
      to: "recipient@example.org",
      subject: "Subject",
      text: "Hello",
      messageId: "<test@example.org>",
    });
    expect(send.mock.calls[0]?.[0]?.html).toContain("<!DOCTYPE html>");
    resolve.mockResolvedValue({ ...credentials, fromName: "Configured sender" });
    await sendEmail("recipient@example.org", "Subject", { content: "Hello" });
    expect(send.mock.calls[1]?.[0]).toMatchObject({ from: { name: "Configured sender" } });
    resolve.mockRejectedValue(new store.OutgoingMailError("profile_unknown", "Configure a default outgoing mail profile."));
    await expect(sendEmail("recipient@example.org", "Subject", {})).rejects.toThrow("default outgoing mail profile");
    expect(send).toHaveBeenCalledTimes(2);
  } finally {
    for (const mock of [resolve, send, builder, read, logo]) mock.mockRestore();
    smtp.close();
  }
});

test("profile test failures expose the SMTP answer and audit no credentials", async () => {
  const { outgoingMailTest } = await import("./test-send");
  const { audit } = await import("../audit");
  const profile = { ...credentials, smtpUser: "user", smtpPassword: "fixture-secret" };
  const resolve = spyOn(store, "resolveMailCredentials").mockResolvedValue(profile);
  const smtp = transport.buildMailTransport(profile);
  const send = spyOn(smtp, "sendMail").mockImplementation(async () => {
    throw new Error("535 Authentication rejected fixture-secret");
  });
  const builder = spyOn(transport, "buildMailTransport").mockReturnValue(smtp);
  const record = spyOn(audit, "record").mockResolvedValue();
  const failed = spyOn(audit, "recordResultAfterSideEffect").mockImplementation(async (value) => value.result);
  const read = spyOn(settings, "get").mockResolvedValue("Cloud");
  try {
    await expect(outgoingMailTest.send("alerts", "recipient@example.org", { actor: { uid: "admin" } })).rejects.toMatchObject({
      code: "smtp_failed",
      status: 502,
      message: "535 Authentication rejected [REDACTED]",
    });
    expect(record.mock.calls[0]?.[0]).toMatchObject({ action: "outgoing_mail.profile.test", outcome: "allowed" });
    expect(JSON.stringify(record.mock.calls)).not.toContain("fixture-secret");
    expect(JSON.stringify(failed.mock.calls)).not.toContain("fixture-secret");
    expect(failed.mock.calls[0]?.[0]).toMatchObject({ result: { ok: false, error: { code: "smtp_failed" } } });
    record.mockRejectedValue(new Error("Audit unavailable"));
    await expect(outgoingMailTest.send("alerts", "recipient@example.org", { actor: { uid: "admin" } })).rejects.toThrow(
      "Audit unavailable",
    );
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    for (const mock of [resolve, send, builder, record, failed, read]) mock.mockRestore();
    smtp.close();
  }
});
