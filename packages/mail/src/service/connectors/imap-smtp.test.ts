import { describe, expect, test } from "bun:test";
import type { ListResponse } from "imapflow";
import {
  assertProviderKeywordsSupported,
  assertSelectedMailbox,
  assertUidValidity,
  disposeImapClient,
  normalizeImapQuotaEvidence,
  parseEnvelopeHeaders,
  parseReferences,
  renameImapFolder,
  selectUidBatch,
  transportDiagnostic,
} from "./imap-smtp";

describe("Provider transport diagnostics", () => {
  test("keep the provider's TLS explanation next to the category", () => {
    const reason = Object.assign(new Error("Hostname/IP does not match certificate's altnames: Host: mail.example.org"), {
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
    });
    expect(transportDiagnostic({ status: "rejected", reason })).toEqual({
      status: "failed",
      category: "tls",
      message: "TLS verification failed: Hostname/IP does not match certificate's altnames: Host: mail.example.org",
    });
  });

  test("redact the submitted password from an SMTP login failure", () => {
    const reason = Object.assign(new Error("Invalid login: 535 5.7.8 rejected s3cret-value"), { code: "EAUTH" });
    expect(transportDiagnostic({ status: "rejected", reason }, ["s3cret-value"]).message).toBe(
      "Authentication failed: Invalid login: 535 5.7.8 rejected [redacted]",
    );
  });
});

describe("IMAP client disposal", () => {
  test("does not close a connection ImapFlow already marked unusable", async () => {
    let closed = 0;
    await disposeImapClient({
      usable: false,
      logout: async () => {
        throw new Error("logout must not run");
      },
      close: () => {
        closed += 1;
      },
    });
    expect(closed).toBe(0);
  });

  test("closes a still-usable connection when logout fails", async () => {
    let closed = 0;
    await disposeImapClient({
      usable: true,
      logout: async () => {
        throw new Error("logout failed");
      },
      close: () => {
        closed += 1;
      },
    });
    expect(closed).toBe(1);
  });
});

describe("IMAP provider keywords", () => {
  test("accepts arbitrary keywords when the provider advertises wildcard support", () => {
    expect(() => assertProviderKeywordsSupported(new Set(["\\Seen", "\\*"]), ["Cloud/Follow-up"])).not.toThrow();
  });

  test("accepts an explicitly advertised keyword", () => {
    expect(() => assertProviderKeywordsSupported(new Set(["\\Seen", "Approved"]), ["approved"])).not.toThrow();
  });

  test("fails clearly when a folder rejects custom keywords", () => {
    expect(() => assertProviderKeywordsSupported(new Set(["\\Seen", "\\Answered"]), ["Cloud/Follow-up"])).toThrow(
      "The provider does not allow custom keywords in this folder",
    );
  });
});

const sparseSearch = (uids: number[], probes: Array<[number, number]>) => async (lowUid: number, highUid: number) => {
  probes.push([lowUid, highUid]);
  return uids.filter((uid) => uid >= lowUid && uid <= highUid);
};

const listedFolder = (path: string, subscribed: boolean): ListResponse => ({
  path,
  pathAsListed: path,
  name: path,
  delimiter: "/",
  flags: new Set(),
  listed: true,
  subscribed,
  parent: [],
  parentPath: "",
});

describe("IMAP envelope UID batching", () => {
  test("finds existing messages without scanning every sparse UID window", async () => {
    const probes: Array<[number, number]> = [];
    const first = await selectUidBatch({
      lowUid: 1,
      highUid: 10_000_000,
      limit: 2,
      search: sparseSearch([3, 100, 9_999_999], probes),
    });
    expect(first).toEqual({ uids: [100, 9_999_999], nextHighUid: 99 });
    expect(probes.length).toBeLessThanOrEqual(12);

    const second = await selectUidBatch({
      lowUid: 1,
      highUid: first.nextHighUid!,
      limit: 2,
      search: sparseSearch([3, 100, 9_999_999], []),
    });
    expect(second).toEqual({ uids: [3], nextHighUid: null });
  });

  test("returns the newest dense batch and a stable continuation", async () => {
    const all = Array.from({ length: 1_000 }, (_, index) => index + 1);
    const result = await selectUidBatch({
      lowUid: 1,
      highUid: 1_000,
      limit: 200,
      search: sparseSearch(all, []),
    });
    expect(result.uids).toEqual(Array.from({ length: 200 }, (_, index) => index + 801));
    expect(result.nextHighUid).toBe(800);
  });
});

describe("IMAP References parsing", () => {
  test("completes for an empty header block", async () => {
    expect(await parseReferences(Buffer.from("\r\n"))).toEqual([]);
  });

  test("returns every referenced Message-ID", async () => {
    expect(await parseReferences(Buffer.from("References: <first@example.com> <second@example.com>\r\n\r\n"))).toEqual([
      "<first@example.com>",
      "<second@example.com>",
    ]);
  });

  test("freezes protocol facts used by automatic reply guards", async () => {
    const parsed = await parseEnvelopeHeaders(
      Buffer.from(
        [
          "References: <first@example.com>",
          "Return-Path: <sender@example.com>",
          "Auto-Submitted: no",
          "Precedence: bulk",
          "List-ID: Example list <list.example.com>",
          "List-Unsubscribe: <mailto:leave@example.com>, <https://example.com/unsubscribe>",
          "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
          "X-Auto-Response-Suppress: OOF, AutoReply",
          "Importance: high",
          "Disposition-Notification-To: sender@example.com",
          "X-Spam-Flag: NO",
          "Content-Type: multipart/report; report-type=delivery-status",
          "",
          "",
        ].join("\r\n"),
      ),
    );
    expect(parsed.references).toEqual(["<first@example.com>"]);
    expect(parsed.protocolFacts).toMatchObject({
      version: 1,
      returnPath: "<sender@example.com>",
      autoSubmitted: "no",
      precedence: "bulk",
      autoResponseSuppress: "OOF, AutoReply",
      contentType: "multipart/report; report-type=delivery-status",
      deliveryStatus: true,
      list: {
        id: "Example list <list.example.com>",
        unsubscribe: ["mailto:leave@example.com", "https://example.com/unsubscribe"],
        unsubscribePost: "List-Unsubscribe=One-Click",
      },
      priority: { importance: "high" },
      receipts: { dispositionNotificationTo: "sender@example.com" },
      spam: { flag: "NO" },
    });
  });
});

describe("IMAP quota normalization", () => {
  test("accepts the documented ImapFlow response shape", () => {
    expect(
      normalizeImapQuotaEvidence({
        storage: { used: 1_024, limit: 4_096 },
        messages: { used: 2, limit: 10 },
      }),
    ).toEqual({
      status: "supported",
      storage: { used: 1_024, limit: 4_096 },
      messages: { used: 2, limit: 10 },
    });
  });

  test("accepts the current runtime response shape and zero limits", () => {
    expect(
      normalizeImapQuotaEvidence({
        path: "INBOX",
        storage: { usage: 0, limit: 0 },
        message: { usage: 3, limit: 20 },
      }),
    ).toEqual({
      status: "supported",
      storage: { used: 0, limit: 0 },
      messages: { used: 3, limit: 20 },
    });
  });

  test("rejects malformed provider evidence", () => {
    expect(
      normalizeImapQuotaEvidence({
        storage: { limit: 4_096 },
      }),
    ).toBeNull();
  });
});

describe("IMAP folder rename", () => {
  test("restores a subscription that the provider drops during rename", async () => {
    const calls: string[] = [];
    await renameImapFolder(
      {
        list: async () => [listedFolder("Cloud Source", true)],
        mailboxRename: async (path, newPath) => {
          calls.push(`rename:${String(path)}:${String(newPath)}`);
          return { path: String(newPath), newPath: String(newPath) };
        },
        mailboxSubscribe: async (path) => {
          calls.push(`subscribe:${String(path)}`);
          return true;
        },
      },
      "Cloud Source",
      "Cloud Renamed",
    );

    expect(calls).toEqual(["rename:Cloud Source:Cloud Renamed", "subscribe:Cloud Renamed"]);
  });

  test("does not add a subscription to an unsubscribed folder", async () => {
    let subscribed = false;
    await renameImapFolder(
      {
        list: async () => [listedFolder("Cloud Source", false)],
        mailboxRename: async () => ({ path: "Cloud Renamed", newPath: "Cloud Renamed" }),
        mailboxSubscribe: async () => {
          subscribed = true;
          return true;
        },
      },
      "Cloud Source",
      "Cloud Renamed",
    );

    expect(subscribed).toBe(false);
  });

  test("reports a partial failure when the rename succeeded but resubscribe did not", async () => {
    await expect(
      renameImapFolder(
        {
          list: async () => [listedFolder("Cloud Source", true)],
          mailboxRename: async () => ({ path: "Cloud Renamed", newPath: "Cloud Renamed" }),
          mailboxSubscribe: async () => false,
        },
        "Cloud Source",
        "Cloud Renamed",
      ),
    ).rejects.toMatchObject({ code: "REMOTE_RENAME_SUBSCRIBE_PARTIAL" });
  });
});

describe("IMAP UIDVALIDITY fencing", () => {
  test("rejects stale or unavailable selected mailbox identities", () => {
    expect(() => assertUidValidity("42", "42")).not.toThrow();
    expect(() => assertUidValidity("43", "42")).toThrow(expect.objectContaining({ code: "UIDVALIDITY_CHANGED" }));
    expect(() => assertUidValidity(null, "42")).toThrow(expect.objectContaining({ code: "UIDVALIDITY_CHANGED" }));
  });

  test("treats a dropped connection as a transport failure instead of an empty result", () => {
    const selected = { uidValidity: 42n } as never;
    expect(() => assertSelectedMailbox({ usable: true, mailbox: selected }, "42")).not.toThrow();
    expect(() => assertSelectedMailbox({ usable: true, mailbox: false }, "42")).toThrow(
      expect.objectContaining({ code: "IMAP_CONNECTION_LOST" }),
    );
    expect(() => assertSelectedMailbox({ usable: false, mailbox: selected }, "42")).toThrow(
      expect.objectContaining({ code: "IMAP_CONNECTION_LOST" }),
    );
    expect(() => assertSelectedMailbox({ usable: true, mailbox: { uidValidity: 43n } as never }, "42")).toThrow(
      expect.objectContaining({ code: "UIDVALIDITY_CHANGED" }),
    );
  });
});
