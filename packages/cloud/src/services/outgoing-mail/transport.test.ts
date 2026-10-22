import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Socket } from "node:net";
import * as nodemailer from "nodemailer";
import { smtpSink } from "../../../../../scripts/fixtures/smtp-sink";
import { DownstreamBusyError, downstreamBudget } from "../downstream-budget";
import * as settings from "../settings";
import * as endpoint from "./resolve-host";
import * as store from "./store";
import { smtpFailureMessage } from "./test-send";
import * as transport from "./transport";

let admission: ReturnType<typeof spyOn<typeof downstreamBudget, "acquire">>;
let target: ReturnType<typeof spyOn<typeof endpoint, "resolveMailHost">>;
beforeEach(() => {
  admission = spyOn(downstreamBudget, "acquire").mockResolvedValue(() => {});
  target = spyOn(endpoint, "resolveMailHost").mockResolvedValue({
    host: "smtp.example.org",
    addresses: [
      { address: "203.0.113.8", family: 4 },
      { address: "2001:db8::8", family: 6 },
    ],
    servername: "smtp.example.org",
  });
});
afterEach(() => {
  target.mockRestore();
  admission.mockRestore();
});

const credentials = {
  smtpHost: "smtp.example.org",
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: null,
  smtpPassword: null,
  fromAddress: "sender@example.org",
  fromName: null,
};
test("one lookup builds rotating IP literals while keeping the hostname only for TLS", async () => {
  const resolved = await transport.resolveMailTransport(credentials);
  expect(resolved.count).toBe(2);
  for (const [index, host] of [
    [-1, "203.0.113.8"],
    [0, "203.0.113.8"],
    [1, "2001:db8::8"],
    [2, "203.0.113.8"],
  ] as const) {
    const smtp = resolved.build(index);
    try {
      expect(smtp.options).toMatchObject({ host, servername: credentials.smtpHost, tls: { servername: credentials.smtpHost } });
      expect(smtp.options).not.toHaveProperty("host", credentials.smtpHost);
    } finally {
      smtp.close();
    }
  }
  expect(target).toHaveBeenCalledTimes(1);
});
test("transport honors explicit TLS mode, omits empty auth, and bounds SMTP timeouts", async () => {
  const anonymous = (await transport.resolveMailTransport(credentials)).build(0);
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
  const authenticated = (
    await transport.resolveMailTransport({
      ...credentials,
      smtpPort: 465,
      smtpSecure: false,
      smtpUser: "user",
      smtpPassword: "secret",
    })
  ).build(0);
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
  const smtp = (await transport.resolveMailTransport(profile)).build(0);
  const verify = spyOn(smtp, "verify").mockResolvedValue(true);
  const send = spyOn(smtp, "sendMail").mockImplementation(async () => {
    throw Object.assign(new Error("535 Authentication rejected fixture-secret"), { command: "AUTH PLAIN" });
  });
  const builder = spyOn(transport, "resolveMailTransport").mockResolvedValue({ count: 2, build: () => smtp });
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
    for (const mock of [resolve, verify, send, builder, record, failed, read]) mock.mockRestore();
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
  const smtp = (await transport.resolveMailTransport(profile)).build(0, socket);
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
  const smtp = (await transport.resolveMailTransport(profile)).build(0);
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

for (const scenario of ["connection", "all connections", "authentication", "recipient", "socket after preflight"] as const) {
  test(`test send handles ${scenario} failure without retrying possible delivery`, async () => {
    const { outgoingMailTest } = await import("./test-send");
    const { audit } = await import("../audit");
    const resolved = await transport.resolveMailTransport(credentials);
    const first = resolved.build(0);
    const second = resolved.build(1);
    const build = spyOn(resolved, "build").mockImplementation((index) => (index === 0 ? first : second));
    const builder = spyOn(transport, "resolveMailTransport").mockResolvedValue(resolved);
    const resolve = spyOn(store, "resolveMailCredentials").mockResolvedValue(credentials);
    const record = spyOn(audit, "record").mockResolvedValue();
    const failed = spyOn(audit, "recordResultAfterSideEffect").mockImplementation(async (value) => value.result);
    const read = spyOn(settings, "get").mockResolvedValue("Cloud");
    const command = scenario === "authentication" ? "AUTH PLAIN" : scenario === "recipient" ? "RCPT TO" : "CONN";
    const error = Object.assign(new Error(`${scenario} failed`), { command });
    const firstClosed = spyOn(first, "close");
    const secondClosed = spyOn(second, "close");
    const firstVerified = spyOn(first, "verify").mockImplementation(async () => {
      if (scenario === "connection" || scenario === "all connections" || scenario === "authentication") throw error;
      return true as const;
    });
    const secondVerified = spyOn(second, "verify").mockImplementation(async () => {
      expect(firstClosed).toHaveBeenCalledTimes(1);
      if (scenario === "all connections") throw Object.assign(new Error("final connection failed"), { command: "CONN" });
      return true as const;
    });
    const firstSent = spyOn(first, "sendMail").mockImplementation(async () => {
      throw error;
    });
    const secondSent = spyOn(second, "sendMail").mockImplementation(async () => ({
      envelope: { from: credentials.fromAddress, to: ["recipient@example.org"] },
      messageId: "<test@example.org>",
      accepted: ["recipient@example.org"],
      rejected: [],
    }));
    try {
      const sending = outgoingMailTest.send("alerts", "recipient@example.org", { actor: { uid: "admin" } });
      if (scenario === "connection") {
        await sending;
        expect(build.mock.calls.map(([index]) => index)).toEqual([0, 1, 1]);
        expect(firstSent).not.toHaveBeenCalled();
        expect(secondVerified).toHaveBeenCalledTimes(1);
        expect(secondSent).toHaveBeenCalledTimes(1);
        expect(secondClosed).toHaveBeenCalledTimes(2);
        expect(failed).not.toHaveBeenCalled();
      } else {
        await expect(sending).rejects.toMatchObject({
          code: "smtp_failed",
          status: 502,
          message: scenario === "all connections" ? "final connection failed" : error.message,
        });
        expect(build.mock.calls.map(([index]) => index)).toEqual(
          scenario === "all connections" ? [0, 1] : scenario === "authentication" ? [0] : [0, 0],
        );
        expect(secondVerified).toHaveBeenCalledTimes(scenario === "all connections" ? 1 : 0);
        expect(secondSent).not.toHaveBeenCalled();
        expect(failed).toHaveBeenCalledTimes(1);
      }
      expect(firstVerified).toHaveBeenCalledTimes(1);
      expect(firstClosed).toHaveBeenCalledTimes(scenario === "recipient" || scenario === "socket after preflight" ? 2 : 1);
    } finally {
      for (const spy of [
        build,
        builder,
        resolve,
        record,
        failed,
        read,
        firstClosed,
        secondClosed,
        firstVerified,
        secondVerified,
        firstSent,
        secondSent,
      ])
        spy.mockRestore();
      first.close();
      second.close();
    }
  });
}

test("profile test refuses shared SMTP overload before connecting", async () => {
  const { outgoingMailTest } = await import("./test-send");
  const { audit } = await import("../audit");
  const resolve = spyOn(store, "resolveMailCredentials").mockResolvedValue(credentials);
  const record = spyOn(audit, "record").mockResolvedValue();
  const failed = spyOn(audit, "recordResultAfterSideEffect").mockImplementation(async (value) => value.result);
  admission.mockRejectedValueOnce(new DownstreamBusyError("smtp"));
  try {
    await expect(outgoingMailTest.send("alerts", "recipient@example.org", { actor: { uid: "admin" } })).rejects.toMatchObject({
      status: 503,
      message: "smtp is busy; retry later.",
    });
    expect(target).not.toHaveBeenCalled();
  } finally {
    for (const mock of [resolve, record, failed]) mock.mockRestore();
  }
});

test("profile preflight and delivery use fresh owned sockets within one SMTP slot", async () => {
  const { outgoingMailTest } = await import("./test-send");
  const { audit } = await import("../audit");
  const sink = smtpSink();
  target.mockResolvedValue({ host: "smtp.test", addresses: [{ address: "127.0.0.1", family: 4 }], servername: "smtp.test" });
  const resolve = spyOn(store, "resolveMailCredentials").mockResolvedValue({ ...credentials, smtpPort: sink.port });
  const record = spyOn(audit, "record").mockResolvedValue();
  const read = spyOn(settings, "get").mockResolvedValue("Cloud");
  let released = false;
  admission.mockResolvedValueOnce(() => {
    released = true;
  });
  try {
    await outgoingMailTest.send("alerts", "recipient@example.org", { actor: { uid: "admin" } });
    expect(sink.connections).toBe(2);
    expect(sink.messages).toHaveLength(1);
    expect(sink.messages[0]?.to).toEqual(["recipient@example.org"]);
    expect(admission).toHaveBeenCalledTimes(1);
    expect(released).toBe(true);
  } finally {
    sink.stop();
    for (const mock of [resolve, record, read]) mock.mockRestore();
  }
});
