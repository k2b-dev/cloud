import { expect, spyOn, test } from "bun:test";
import * as store from "@k2b/cloud/services/outgoing-mail/store";
import { ImapFlow } from "imapflow";
import { structure } from "./fixtures";
import { createImapBounceMailbox } from "./imap";
import { DSN_PART_BYTES } from "./parser";

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
    .mockResolvedValueOnce([900000])
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
    expect(await mailbox.listUids({ after: 210, limit: 200, since })).toEqual([211, 212, 900000]);
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
