import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import tls from "node:tls";
import * as logging from "@k2b/cloud/services/logging";
import * as messages from "@k2b/cloud/services/outgoing-mail/messages";
import * as store from "@k2b/cloud/services/outgoing-mail/store";
import { ImapFlow } from "imapflow";
import { type ImapSinkMessage, imapSink } from "../../../../scripts/fixtures/imap-sink";
import { headers, status, structure, wireStructure } from "./fixtures";
import { createImapBounceMailbox, IMAP_RESPONSE_BYTES } from "./imap";
import { DSN_PART_BYTES } from "./parser";
import { pollProfileBounces } from "./poller";

const profile: store.ImapMailProfile = {
  id: crypto.randomUUID(),
  key: "sender",
  revision: 1,
  fromAddress: "sender@example.org",
  imap: { host: "imap.example.org", port: 993, secure: true, user: "sender", folder: "INBOX", hasPassword: true },
  uidValidity: "42",
  lastUid: 10,
};
test("adapter connects with timeouts, uses EXAMINE and bounded BODY.PEEK queries, never fetches source", async () => {
  const credentials = spyOn(store, "resolveImapMailCredentials").mockResolvedValue("fixture-secret");
  let options: ImapFlow["options"] | undefined;
  const connect = spyOn(ImapFlow.prototype, "connect").mockImplementation(async function (this: ImapFlow) {
    options = this.options;
    this.usable = true;
    this.capabilities.set("ESEARCH", true);
  });
  const open = spyOn(ImapFlow.prototype, "mailboxOpen").mockResolvedValue({
    path: "INBOX",
    delimiter: "/",
    flags: new Set(),
    permanentFlags: new Set(),
    exists: 1000,
    uidValidity: 42n,
    uidNext: 900001,
    readOnly: true,
  });
  const search = spyOn(ImapFlow.prototype, "search")
    .mockResolvedValueOnce({ min: 211 })
    .mockResolvedValueOnce([211, 212])
    .mockResolvedValueOnce({ min: 900000 })
    .mockResolvedValueOnce([900000]);
  const fetch = spyOn(ImapFlow.prototype, "fetchOne")
    .mockResolvedValueOnce({ seq: 1, uid: 211, bodyStructure: structure })
    .mockResolvedValueOnce({ seq: 1, uid: 211, bodyParts: new Map([["3.header", Buffer.from("Message-ID: test")]]) })
    .mockResolvedValueOnce({ seq: 1, uid: 211, bodyParts: new Map([["2", Buffer.alloc(DSN_PART_BYTES + 1)]]) });
  const close = spyOn(ImapFlow.prototype, "close").mockImplementation(() => {});
  const controller = new AbortController();
  try {
    const mailbox = createImapBounceMailbox(profile, controller.signal);
    expect(connect).not.toHaveBeenCalled();
    expect(await mailbox.open("INBOX", { readOnly: true })).toEqual({ uidValidity: "42" });
    expect(options).toMatchObject({ connectionTimeout: 30_000, socketTimeout: 30_000, logger: false, maxLiteralSize: DSN_PART_BYTES + 1 });
    expect(open.mock.calls).toEqual([["INBOX", { readOnly: true }]]);
    const since = new Date("2026-10-01");
    expect(await mailbox.listUids({ after: 210, limit: 200, since })).toEqual({ uids: [211, 212, 900000], through: 900000 });
    expect(search.mock.calls).toEqual([
      [
        { uid: "211:900000", since },
        { uid: true, returnOptions: ["MIN"] },
      ],
      [{ uid: "211:410", since }, { uid: true }],
      [
        { uid: "411:900000", since },
        { uid: true, returnOptions: ["MIN"] },
      ],
      [{ uid: "900000:900000", since }, { uid: true }],
    ]);
    expect(await mailbox.bodyStructure(211)).toEqual(structure);
    expect(await mailbox.fetchPart(211, "3.HEADER", DSN_PART_BYTES)).toEqual(Buffer.from("Message-ID: test"));
    expect(await mailbox.fetchPart(211, "2", DSN_PART_BYTES)).toBeNull();
    expect(fetch.mock.calls).toEqual([
      [211, { bodyStructure: true }, { uid: true }],
      [211, { bodyParts: [{ key: "3.HEADER", start: 0, maxLength: DSN_PART_BYTES + 1 }] }, { uid: true }],
      [211, { bodyParts: [{ key: "2", start: 0, maxLength: DSN_PART_BYTES + 1 }] }, { uid: true }],
    ]);
    controller.abort();
    expect(close).toHaveBeenCalledTimes(1);
    mailbox.close();
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    credentials.mockRestore();
    connect.mockRestore();
    open.mockRestore();
    search.mockRestore();
    fetch.mockRestore();
    close.mockRestore();
  }
});

const realConnect = tls.connect;
let trust: ReturnType<typeof spyOn<typeof tls, "connect">>;
let credentials: ReturnType<typeof spyOn<typeof store, "resolveImapMailCredentials">>;
let saved: ReturnType<typeof spyOn<typeof store, "saveImapMailCheck">>;
let applied: ReturnType<typeof spyOn<typeof messages, "applyOutgoingMailBounce">>;
let log: ReturnType<typeof spyOn<typeof logging, "logger">>;
const warnings = mock((_message: string, _metadata?: Record<string, unknown>) => {});
const errors = mock(() => {});
beforeEach(() => {
  // The reused FreeIPA fixture certificate names localhost, not the loopback IP.
  // Trust it only in this test; production keeps normal certificate verification.
  trust = spyOn(tls, "connect").mockImplementation(
    (input: number | tls.BunConnectionOptions, listener?: string | tls.ConnectionOptions | (() => void)) => {
      if (typeof input === "number") throw new Error("Expected ImapFlow's connection options.");
      return realConnect({ ...input, rejectUnauthorized: false }, typeof listener === "function" ? listener : undefined);
    },
  );
  credentials = spyOn(store, "resolveImapMailCredentials").mockResolvedValue("loopback-fixture-password");
  saved = spyOn(store, "saveImapMailCheck").mockResolvedValue();
  applied = spyOn(messages, "applyOutgoingMailBounce").mockResolvedValue();
  warnings.mockClear();
  errors.mockClear();
  log = spyOn(logging, "logger").mockReturnValue({ error: errors, warn: warnings, info: mock(() => {}), debug: mock(() => {}) });
});
afterEach(() => {
  for (const spy of [trust, credentials, saved, applied, log]) spy.mockRestore();
});
const dsn = (uid: number): ImapSinkMessage => ({ uid, bodyStructure: wireStructure, sections: { "2": status, "3.HEADER": headers } });
const atSink = (sink: ReturnType<typeof imapSink>, secure = true): store.ImapMailProfile => ({
  ...profile,
  lastUid: 0,
  imap: { ...profile.imap, host: sink.host, port: sink.port, secure },
});
const pollSink = async (sink: ReturnType<typeof imapSink>) => {
  const current = atSink(sink);
  const signal = AbortSignal.timeout(10_000);
  await pollProfileBounces(current, () => createImapBounceMailbox(current, signal), signal);
  return current;
};
test("real adapter skips an oversized BODYSTRUCTURE after reconnecting and collects both surrounding DSNs read-only", async () => {
  const oversized = `("TEXT" "PLAIN" ("NAME" "${"x".repeat(140 * 1024)}") NIL NIL "7BIT" 1 1)`;
  const sink = imapSink({ implicitTls: true, messages: [dsn(1), { uid: 2, bodyStructure: oversized, sections: {} }, dsn(3)] });
  try {
    const current = await pollSink(sink);
    expect(applied).toHaveBeenCalledTimes(2);
    expect(saved.mock.calls).toEqual([[current, { uidValidity: "42", lastUid: 3 }]]);
    expect(errors).not.toHaveBeenCalled();
    expect(warnings.mock.calls).toEqual([["Skipping unreadable delivery report after retry.", { profile: "sender", uid: 2 }]]);
    expect(sink.largestResponse).toBeGreaterThan(IMAP_RESPONSE_BYTES);
    const selected = sink.commands.filter((line) => / (EXAMINE|SELECT|UID|STORE|COPY|MOVE|EXPUNGE|APPEND)\b/i.test(line));
    expect(selected.some((line) => / EXAMINE /i.test(line))).toBe(true);
    expect(selected.some((line) => / UID SEARCH /i.test(line))).toBe(true);
    expect(selected.some((line) => / UID FETCH .*BODYSTRUCTURE/i.test(line))).toBe(true);
    expect(selected.some((line) => / UID FETCH .*BODY\.PEEK\[3\.HEADER\]<0\.65537>/i.test(line))).toBe(true);
    for (const line of selected) {
      expect(line).toMatch(/^\S+ (?:EXAMINE |UID SEARCH |UID FETCH .*?(?:BODYSTRUCTURE|BODY\.PEEK\[))/i);
      expect(line).not.toMatch(/\b(?:SELECT|STORE|COPY|MOVE|EXPUNGE|APPEND)\b|\bBODY\[/i);
    }
    expect(sink.commands.filter((line) => / UID FETCH 2 /i.test(line))).toHaveLength(2);
  } finally {
    sink.stop();
  }
}, 15_000);
test("real adapter does not use a delivery-status section larger than 64 KiB", async () => {
  const sink = imapSink({
    implicitTls: true,
    messages: [{ ...dsn(1), sections: { "2": status + "x".repeat(DSN_PART_BYTES), "3.HEADER": headers } }],
  });
  try {
    const current = await pollSink(sink);
    expect(applied).not.toHaveBeenCalled();
    expect(saved.mock.calls).toEqual([[current, { uidValidity: "42", lastUid: 1 }]]);
    expect(errors).not.toHaveBeenCalled();
    expect(sink.commands.find((line) => /BODY\.PEEK\[2\]/i.test(line))).toContain("<0.65537>");
    expect(sink.largestResponse).toBeLessThan(IMAP_RESPONSE_BYTES);
  } finally {
    sink.stop();
  }
});
test("legacy SEARCH windows bound responses for more than 20k UIDs and checkpoint a 200-message batch", async () => {
  const firstUid = 1_000_000_000;
  const sink = imapSink({
    implicitTls: true,
    esearch: false,
    messages: Array.from({ length: 21000 }, (_, i) => ({
      uid: firstUid + i,
      bodyStructure: '("TEXT" "PLAIN" NIL NIL NIL "7BIT" 1 1)',
      sections: {},
    })),
  });
  const current = { ...atSink(sink), lastUid: firstUid - 1 };
  const signal = AbortSignal.timeout(10_000);
  try {
    await pollProfileBounces(current, () => createImapBounceMailbox(current, signal), signal);
    expect(errors).not.toHaveBeenCalled();
    expect(saved.mock.calls).toEqual([[current, { uidValidity: "42", lastUid: firstUid + 199 }]]);
    expect(sink.largestResponse).toBeLessThan(IMAP_RESPONSE_BYTES);
    expect(sink.commands.filter((line) => / UID FETCH /i.test(line))).toHaveLength(200);
    expect(sink.commands.filter((line) => / UID SEARCH /i.test(line)).every((line) => !line.includes("RETURN"))).toBe(true);
  } finally {
    sink.stop();
  }
}, 15_000);
test("required STARTTLS fails before authentication or credential bytes on a server without STARTTLS", async () => {
  const sink = imapSink({ starttls: false });
  const mailbox = createImapBounceMailbox(atSink(sink, false), AbortSignal.timeout(3000));
  try {
    await expect(mailbox.open("INBOX", { readOnly: true })).rejects.toThrow();
    expect(sink.commands.some((line) => /LOGIN|AUTHENTICATE/i.test(line))).toBe(false);
    expect(sink.commands.join("\n")).not.toContain("loopback-fixture-password");
    expect(sink.commands.join("\n")).not.toContain(Buffer.from("\0sender\0loopback-fixture-password").toString("base64"));
  } finally {
    mailbox.close();
    sink.stop();
  }
});
test("a 127.0.0.1 host completes implicit TLS without a boolean servername", async () => {
  const sink = imapSink({ implicitTls: true });
  const mailbox = createImapBounceMailbox(atSink(sink), AbortSignal.timeout(3000));
  try {
    expect(await mailbox.open("INBOX", { readOnly: true })).toEqual({ uidValidity: "42" });
    expect(trust.mock.calls[0]?.[0]).toMatchObject({ host: "127.0.0.1", servername: undefined });
    expect(sink.commands.some((line) => / AUTHENTICATE /i.test(line))).toBe(true);
  } finally {
    mailbox.close();
    sink.stop();
  }
});
test("EXAMINE without UIDNEXT fails the open stage", async () => {
  const sink = imapSink({ implicitTls: true, uidNext: null });
  try {
    const current = await pollSink(sink);
    expect(saved.mock.calls).toEqual([[current, { error: "open_failed" }]]);
    expect(sink.commands.some((line) => / UID SEARCH /i.test(line))).toBe(false);
  } finally {
    sink.stop();
  }
});

test("mocked adapter requires STARTTLS for non-implicit TLS and overrides servername only for IP hosts", async () => {
  const captured: ImapFlow["options"][] = [];
  const connect = spyOn(ImapFlow.prototype, "connect").mockImplementation(async function (this: ImapFlow) {
    captured.push(this.options);
    this.usable = true;
  });
  const opened = spyOn(ImapFlow.prototype, "mailboxOpen").mockResolvedValue({
    path: "INBOX",
    delimiter: "/",
    flags: new Set(),
    permanentFlags: new Set(),
    exists: 0,
    uidValidity: 42n,
    uidNext: 1,
    readOnly: true,
  });
  const close = spyOn(ImapFlow.prototype, "close").mockImplementation(() => {});
  try {
    for (const [host, secure] of [
      ["imap.example.org", true],
      ["127.0.0.1", true],
      ["127.0.0.1", false],
    ] satisfies [string, boolean][]) {
      const mailbox = createImapBounceMailbox({ ...profile, imap: { ...profile.imap, host, secure } }, new AbortController().signal);
      await mailbox.open("INBOX", { readOnly: true });
      mailbox.close();
    }
    expect(captured[0]).not.toHaveProperty("doSTARTTLS");
    expect(captured[0]).not.toHaveProperty("tls");
    expect(captured[1]).toMatchObject({ secure: true, tls: { servername: undefined } });
    expect(captured[1]).not.toHaveProperty("doSTARTTLS");
    expect(captured[2]).toMatchObject({ secure: false, doSTARTTLS: true, tls: { servername: undefined } });
  } finally {
    connect.mockRestore();
    opened.mockRestore();
    close.mockRestore();
  }
});
test("mocked legacy scans checkpoint empty windows and stop after a bounded number of searches", async () => {
  const connect = spyOn(ImapFlow.prototype, "connect").mockImplementation(async function (this: ImapFlow) {
    this.usable = true;
  });
  const opened = spyOn(ImapFlow.prototype, "mailboxOpen").mockResolvedValue({
    path: "INBOX",
    delimiter: "/",
    flags: new Set(),
    permanentFlags: new Set(),
    exists: 0,
    uidValidity: 42n,
    uidNext: 0xffffffff,
    readOnly: true,
  });
  const search = spyOn(ImapFlow.prototype, "search").mockResolvedValue([]);
  const close = spyOn(ImapFlow.prototype, "close").mockImplementation(() => {});
  const mailbox = createImapBounceMailbox(profile, new AbortController().signal);
  try {
    await mailbox.open("INBOX", { readOnly: true });
    const scan = await mailbox.listUids({ after: 10, limit: 200 });
    expect(scan.uids).toEqual([]);
    expect(search).toHaveBeenCalledTimes(200);
    const lastRange = search.mock.calls.at(-1)?.[0].uid?.toString().split(":");
    expect(scan.through).toBe(Number(lastRange?.[1]));
    expect(scan.through).toBeGreaterThan(10);
    expect(scan.through).toBeLessThan(0xffffffff - 1);
    for (const [query, options] of search.mock.calls) {
      const [low, high] = query.uid!.toString().split(":").map(Number);
      expect((high! - low! + 1) * 11 + 1024).toBeLessThanOrEqual(IMAP_RESPONSE_BYTES);
      expect(options).toEqual({ uid: true });
    }
  } finally {
    mailbox.close();
    connect.mockRestore();
    opened.mockRestore();
    search.mockRestore();
    close.mockRestore();
  }
});

test("mocked EXAMINE with an invalid UIDNEXT fails before searching", async () => {
  const connect = spyOn(ImapFlow.prototype, "connect").mockImplementation(async function (this: ImapFlow) {
    this.usable = true;
  });
  const opened = spyOn(ImapFlow.prototype, "mailboxOpen").mockResolvedValue({
    path: "INBOX",
    delimiter: "/",
    flags: new Set(),
    permanentFlags: new Set(),
    exists: 0,
    uidValidity: 42n,
    uidNext: 0,
    readOnly: true,
  });
  const search = spyOn(ImapFlow.prototype, "search");
  const close = spyOn(ImapFlow.prototype, "close").mockImplementation(() => {});
  const mailbox = createImapBounceMailbox(profile, new AbortController().signal);
  try {
    await expect(mailbox.open("INBOX", { readOnly: true })).rejects.toThrow("UIDNEXT");
    expect(search).not.toHaveBeenCalled();
  } finally {
    mailbox.close();
    connect.mockRestore();
    opened.mockRestore();
    search.mockRestore();
    close.mockRestore();
  }
});
