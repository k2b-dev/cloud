import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Socket } from "node:net";
import * as nodemailer from "nodemailer";
import * as settings from "../settings";
import * as endpoint from "./resolve-host";
import * as store from "./store";
import { smtpFailureMessage } from "./test-send";
import * as transport from "./transport";

let target: ReturnType<typeof spyOn<typeof endpoint, "resolveMailHost">>;
beforeEach(() => {
  target = spyOn(endpoint, "resolveMailHost").mockResolvedValue({ address: "203.0.113.8", servername: "smtp.example.org" });
});
afterEach(() => target.mockRestore());

const credentials = {
  smtpHost: "smtp.example.org",
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: null,
  smtpPassword: null,
  fromAddress: "sender@example.org",
  fromName: null,
};
test("transport honors explicit TLS mode, omits empty auth, and bounds SMTP timeouts", async () => {
  const anonymous = await transport.buildMailTransport(credentials);
  expect(anonymous.options).toMatchObject({
    host: "203.0.113.8",
    servername: credentials.smtpHost,
    tls: { servername: credentials.smtpHost },
    port: 587,
    secure: false,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 60000,
  });
  expect(anonymous.options).not.toHaveProperty("auth");
  const authenticated = await transport.buildMailTransport({
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
test("SMTP failures redact plaintext and authentication encodings", async () => {
  const plain = "\0user\0password";
  const message = smtpFailureMessage(
    new Error(`535 password ${Buffer.from("password").toString("base64")} ${Buffer.from(plain).toString("base64")}`),
    ["password", plain],
  );
  expect(message).toStartWith("535");
  expect(message).not.toContain("password");
  expect(message).not.toContain(Buffer.from(plain).toString("base64"));
});
test("profile test failures expose the SMTP answer and audit no credentials", async () => {
  const { outgoingMailTest } = await import("./test-send");
  const { audit } = await import("../audit");
  const profile = { ...credentials, smtpUser: "user", smtpPassword: "fixture-secret" };
  const resolve = spyOn(store, "resolveMailCredentials").mockResolvedValue(profile);
  const smtp = await transport.buildMailTransport(profile);
  const send = spyOn(smtp, "sendMail").mockImplementation(async () => {
    throw new Error("535 Authentication rejected fixture-secret");
  });
  const builder = spyOn(transport, "buildMailTransport").mockResolvedValue(smtp);
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

const profile = {
  smtpHost: "smtp.example.org",
  smtpPort: 465,
  smtpSecure: true,
  smtpUser: null,
  smtpPassword: null,
  fromAddress: "sender@example.org",
  fromName: null,
};
test("worker transport accepts an owned socket while keeping implicit TLS and SMTP timeout configuration", async () => {
  const create = spyOn(nodemailer, "createTransport");
  const socket = new Socket();
  const smtp = await transport.buildMailTransport(profile, socket);
  try {
    expect(create).toHaveBeenCalledWith({
      socket,
      host: "203.0.113.8",
      servername: profile.smtpHost,
      tls: { servername: profile.smtpHost },
      port: 465,
      secure: true,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 60000,
    });
    expect(socket.connecting).toBe(false);
  } finally {
    smtp.close();
    socket.destroy();
    create.mockRestore();
  }
});
test("existing transport callers retain the original socket configuration", async () => {
  const create = spyOn(nodemailer, "createTransport");
  const smtp = await transport.buildMailTransport(profile);
  try {
    expect(create).toHaveBeenCalledWith({
      host: "203.0.113.8",
      servername: profile.smtpHost,
      tls: { servername: profile.smtpHost },
      port: 465,
      secure: true,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 60000,
    });
  } finally {
    smtp.close();
    create.mockRestore();
  }
});

test("test send maps a blocked target to smtp_failed 502", async () => {
  const { outgoingMailTest } = await import("./test-send");
  const { audit } = await import("../audit");
  const resolve = spyOn(store, "resolveMailCredentials").mockResolvedValue(credentials);
  const record = spyOn(audit, "record").mockResolvedValue();
  const failed = spyOn(audit, "recordResultAfterSideEffect").mockImplementation(async (value) => value.result);
  target.mockRejectedValue(
    new Error("Outgoing mail target is on an internal network. An operator can allow it with OUTGOING_MAIL_ALLOWED_TARGETS."),
  );
  try {
    await expect(outgoingMailTest.send("alerts", "recipient@example.org", { actor: { uid: "admin" } })).rejects.toMatchObject({
      code: "smtp_failed",
      status: 502,
      message: expect.stringContaining("OUTGOING_MAIL_ALLOWED_TARGETS"),
    });
    expect(failed).toHaveBeenCalledTimes(1);
  } finally {
    for (const spy of [resolve, record, failed]) spy.mockRestore();
  }
});
