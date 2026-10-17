import { afterEach, expect, mock, test } from "bun:test";
import { resolveAllowedNetworkAddresses } from "../network-security";
import { smtpRetryable } from "./dispatcher";
import { outgoingMailAllowlist, resolveMailHost } from "./resolve-host";

const original = process.env.OUTGOING_MAIL_ALLOWED_TARGETS;
afterEach(() => {
  if (original === undefined) delete process.env.OUTGOING_MAIL_ALLOWED_TARGETS;
  else process.env.OUTGOING_MAIL_ALLOWED_TARGETS = original;
});
test("blocks SMTP/IMAP by default with a retryable operator-facing reason", async () => {
  delete process.env.OUTGOING_MAIL_ALLOWED_TARGETS;
  try {
    await resolveMailHost("127.0.0.1");
    throw new Error("Expected refusal");
  } catch (error) {
    expect(error).toHaveProperty("name", "NetworkTargetBlockedError");
    expect(String(error)).toContain("OUTGOING_MAIL_ALLOWED_TARGETS");
    expect(smtpRetryable(error)).toBe(true);
  }
});
test("allows explicit IP and CIDR entries and omits IP TLS servername", async () => {
  for (const entry of ["127.0.0.1", "127.0.0.0/8"]) {
    process.env.OUTGOING_MAIL_ALLOWED_TARGETS = entry;
    expect(await resolveMailHost("127.0.0.1")).toEqual({
      host: "127.0.0.1",
      addresses: [{ address: "127.0.0.1", family: 4 }],
      servername: undefined,
    });
  }
});
test("returns every checked answer, IPv4 first with stable family order, and preserves TLS identity", async () => {
  process.env.OUTGOING_MAIL_ALLOWED_TARGETS = "smtp.example.org";
  const lookup = mock(async () => [
    { address: "::1", family: 6 },
    { address: "127.0.0.1", family: 4 },
    { address: "127.0.0.2", family: 4 },
    { address: "::2", family: 6 },
  ]);
  const resolve = (host: string, allowlist: ReturnType<typeof outgoingMailAllowlist>) =>
    resolveAllowedNetworkAddresses(host, allowlist, lookup);
  expect(await resolveMailHost("SMTP.example.org", undefined, resolve)).toEqual({
    host: "smtp.example.org",
    addresses: [
      { address: "127.0.0.1", family: 4 },
      { address: "127.0.0.2", family: 4 },
      { address: "::1", family: 6 },
      { address: "::2", family: 6 },
    ],
    servername: "smtp.example.org",
  });
  expect(lookup).toHaveBeenCalledTimes(1);
});
test("keeps IPv6 answers when no IPv4 answer exists", async () => {
  process.env.OUTGOING_MAIL_ALLOWED_TARGETS = "smtp.example.org";
  const resolve = (host: string, allowlist: ReturnType<typeof outgoingMailAllowlist>) =>
    resolveAllowedNetworkAddresses(host, allowlist, async () => [{ address: "::1", family: 6 }]);
  expect(await resolveMailHost("smtp.example.org", undefined, resolve)).toEqual({
    host: "smtp.example.org",
    addresses: [{ address: "::1", family: 6 }],
    servername: "smtp.example.org",
  });
});
test("cancellation stops a pending resolver", async () => {
  const controller = new AbortController();
  const pending = resolveMailHost("smtp.example.org", controller.signal, () => new Promise(() => {}));
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});
test("invalid and /0 entries fail startup validation", () => {
  for (const entry of ["0.0.0.0/0", "::/0", "http://host"]) {
    process.env.OUTGOING_MAIL_ALLOWED_TARGETS = entry;
    expect(outgoingMailAllowlist).toThrow("OUTGOING_MAIL_ALLOWED_TARGETS");
  }
});
