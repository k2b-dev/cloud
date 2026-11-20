import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { EMPTY_MESSAGE_PROTOCOL_FACTS } from "../message-protocol";
import {
  JMAP_EMAIL_BODY_PROPERTIES,
  JMAP_EMAIL_PROPERTIES,
  jmapEmailSnapshotSchema,
  jmapKeywordsFromFlags,
  mapJmapEmailSnapshot,
  mapJmapKeywords,
  mapJmapMimeStructure,
} from "./jmap-email";
import { fixtureEmail } from "./jmap-fixture";

beforeEach(() => setSystemTime(new Date("2026-11-20T00:00:00Z")));
afterEach(() => setSystemTime());

test("projects content, provider metadata and only true memberships without inventing a remote ref", () => {
  const email = fixtureEmail("e1");
  email.mailboxIds = { inbox: true, archive: true, gone: false };
  email.sentAt = "2026-11-19T11:00:00+01:00";
  email.hasAttachment = true;
  email.subject = "A\u0000 subject";
  email.messageId = ["first@example.invalid", "second@example.invalid"];
  email.inReplyTo = ["parent@example.invalid", "other@example.invalid"];
  email.references = ["root@example.invalid", "parent@example.invalid"];
  const mapped = mapJmapEmailSnapshot(email);
  expect(mapped).toMatchObject({
    emailId: "e1",
    blobId: "blob-e1",
    mailboxIds: ["inbox", "archive"],
    hasAttachment: true,
    skippedKeywordCount: 0,
  });
  expect(mapped.envelope).toEqual({
    providerMessageId: null,
    providerThreadId: "thread-e1",
    messageId: "<first@example.invalid>",
    inReplyTo: "<parent@example.invalid>",
    references: ["<root@example.invalid>", "<parent@example.invalid>"],
    subject: "A subject",
    sentAt: new Date("2026-11-19T10:00:00Z"),
    internalDate: new Date("2026-11-19T10:00:00Z"),
    sizeBytes: 326,
    flags: [],
    labels: [],
    addresses: { from: [{ name: "Example", address: "sender@example.invalid" }], to: [], cc: [], bcc: [], replyTo: [] },
    protocolFacts: EMPTY_MESSAGE_PROTOCOL_FACTS,
    mimeStructure: {
      part: "1",
      type: "text/plain",
      parameters: { charset: "utf-8" },
      id: null,
      encoding: null,
      size: 10,
      disposition: null,
      dispositionParameters: {},
      childNodes: [],
    },
  });
});

test("normalizes every address role like IMAP, including Bcc and empty addresses", () => {
  const email = fixtureEmail("e1");
  for (const role of ["from", "to", "cc", "bcc", "replyTo"] as const) {
    email[role] = [
      { name: " A\u0000 Name ", email: " USER\u0000@EXAMPLE.INVALID " },
      { name: null, email: " \u0000 " },
      { email: "other@example.invalid" },
    ];
  }
  const { envelope } = mapJmapEmailSnapshot(email);
  for (const role of ["from", "to", "cc", "bcc", "replyTo"] as const) {
    expect(envelope.addresses[role]).toEqual([
      { name: "A Name", address: "user@example.invalid" },
      { name: null, address: "other@example.invalid" },
    ]);
  }
});

for (const empty of [null, undefined, []]) {
  test(`handles empty or missing address and message ID lists: ${String(empty)}`, () => {
    const email = fixtureEmail("e1");
    for (const key of ["from", "to", "cc", "bcc", "replyTo", "messageId", "inReplyTo", "references"] as const) email[key] = empty;
    email.subject = null;
    email.sentAt = null;
    const { envelope } = mapJmapEmailSnapshot(jmapEmailSnapshotSchema.parse(email));
    expect(envelope.addresses).toEqual({ from: [], to: [], cc: [], bcc: [], replyTo: [] });
    expect(envelope).toMatchObject({ subject: "", sentAt: null, messageId: null, inReplyTo: null, references: [] });
    expect(envelope.internalDate).toEqual(new Date("2026-11-19T10:00:00Z"));
  });
}

test("strips NUL from message IDs without joining multiple In-Reply-To values", () => {
  const email = fixtureEmail("e1");
  email.messageId = [" first\u0000@example.invalid ", "other@example.invalid"];
  email.inReplyTo = ["parent\u0000@example.invalid", "other@example.invalid"];
  email.references = ["root\u0000@example.invalid", "\u0000", "parent@example.invalid"];
  expect(mapJmapEmailSnapshot(email).envelope).toMatchObject({
    messageId: "<first@example.invalid>",
    inReplyTo: "<parent@example.invalid>",
    references: ["<root@example.invalid>", "<parent@example.invalid>"],
  });
  email.messageId = ["\u0000", "second@example.invalid"];
  expect(mapJmapEmailSnapshot(email).envelope.messageId).toBeNull();
});

test("delegates every protocol header to the existing parser, including Stalwart leading spaces", () => {
  const email = jmapEmailSnapshotSchema.parse({
    ...fixtureEmail("e1"),
    "header:Return-Path:asRaw": " <sender@example.invalid>",
    "header:Auto-Submitted:asRaw": " auto-\u0000generated",
    "header:Precedence:asRaw": " bulk",
    "header:List-Id:asRaw": " Example <list.example.invalid>",
    "header:List-Unsubscribe:asRaw": " <https://example.invalid/unsubscribe>, <mailto:unsubscribe@example.invalid>",
    "header:List-Unsubscribe-Post:asRaw": " List-Unsubscribe=One-Click",
    "header:List-Post:asRaw": " <mailto:list@example.invalid>",
    "header:List-Help:asRaw": " <https://example.invalid/help>",
    "header:List-Archive:asRaw": " <https://example.invalid/archive>",
    "header:X-Auto-Response-Suppress:asRaw": " All",
    "header:Content-Type:asRaw": " multipart/report; report-type=delivery-status",
    "header:Importance:asRaw": " high",
    "header:Priority:asRaw": " urgent",
    "header:X-Priority:asRaw": " 1",
    "header:Disposition-Notification-To:asRaw": " receipt@example.invalid",
    "header:X-Spam-Flag:asRaw": " YES",
    "header:X-Spam-Status:asRaw": " Yes",
    "header:X-Spam-Score:asRaw": " 8.0",
  });
  expect(mapJmapEmailSnapshot(email).envelope.protocolFacts).toEqual({
    version: 1,
    returnPath: "<sender@example.invalid>",
    autoSubmitted: "auto-generated",
    precedence: "bulk",
    autoResponseSuppress: "All",
    contentType: "multipart/report; report-type=delivery-status",
    deliveryStatus: true,
    list: {
      id: "Example <list.example.invalid>",
      unsubscribe: ["https://example.invalid/unsubscribe", "mailto:unsubscribe@example.invalid"],
      unsubscribePost: "List-Unsubscribe=One-Click",
      post: ["mailto:list@example.invalid"],
      help: ["https://example.invalid/help"],
      archive: ["https://example.invalid/archive"],
    },
    priority: { importance: "high", priority: "urgent", xPriority: "1" },
    receipts: { dispositionNotificationTo: "receipt@example.invalid" },
    spam: { flag: "YES", status: "Yes", score: "8.0" },
  });
});

test("maps nested MIME parts and leaves HTML size unknown for conservative hydration", () => {
  const leaf = fixtureEmail("e1").bodyStructure;
  const structure = {
    ...leaf,
    partId: null,
    type: "multipart/mixed",
    charset: null,
    subParts: [
      {
        ...leaf,
        type: "multipart/alternative",
        partId: "1",
        charset: null,
        subParts: [
          { ...leaf, partId: "1.1" },
          { ...leaf, partId: "1.2", type: "text/ht\u0000ml", size: 1234, charset: "utf-\u00008" },
        ],
      },
      {
        ...leaf,
        partId: "2",
        type: "image/png",
        charset: null,
        name: "photo\u0000.png",
        cid: "cid\u0000@example.invalid",
        disposition: "in\u0000line",
      },
    ],
  };
  const mapped = mapJmapMimeStructure(structure);
  expect(mapped).toMatchObject({
    part: null,
    type: "multipart/mixed",
    parameters: {},
    childNodes: [
      expect.objectContaining({
        part: "1",
        childNodes: [
          expect.objectContaining({ part: "1.1", size: 10 }),
          expect.objectContaining({ part: "1.2", type: "text/html", size: null, encoding: null, parameters: { charset: "utf-8" } }),
        ],
      }),
      expect.objectContaining({
        part: "2",
        parameters: { name: "photo.png" },
        id: "cid@example.invalid",
        disposition: "inline",
        childNodes: [],
      }),
    ],
  });
  expect(JSON.stringify(mapped)).not.toContain("\\u0000");
});

test("maps four system flags and retains valid unknown keywords without silently renaming them", () => {
  const invalid = ["x".repeat(101), "\\Seen", "bad word", "(bad)", "{bad", "bad\u0000", "bad\u007f", " trim", "trim ", ""];
  const keywords = {
    $seen: true,
    $flagged: true,
    $answered: true,
    $draft: true,
    $hasnoattachment: true,
    $future: true,
    label: true,
    disabled: false,
    ["x".repeat(100)]: true,
    ...Object.fromEntries(invalid.map((key) => [key, true])),
  };
  const mapped = mapJmapKeywords(keywords);
  expect(mapped.flags).toEqual(["\\Answered", "\\Draft", "\\Flagged", "\\Seen"]);
  expect(mapped.labels).toEqual(["$future", "$hasnoattachment", "label", "x".repeat(100)]);
  expect(mapped.skippedKeywordCount).toBe(invalid.length);
  expect(jmapKeywordsFromFlags([...mapped.flags, "\\seen", "\\Deleted", "\\Recent", "label"])).toEqual({
    $seen: true,
    $flagged: true,
    $answered: true,
    $draft: true,
  });
  expect(jmapKeywordsFromFlags([])).toEqual({});
  const email = fixtureEmail("e1");
  email.keywords = keywords;
  expect(mapJmapEmailSnapshot(email)).toMatchObject({
    envelope: { flags: mapped.flags, labels: mapped.labels },
    skippedKeywordCount: invalid.length,
  });
});

test("requests exactly envelope properties and strips unrequested bodies from validated snapshots", () => {
  expect(JMAP_EMAIL_PROPERTIES).toEqual([
    "id",
    "blobId",
    "threadId",
    "mailboxIds",
    "keywords",
    "size",
    "receivedAt",
    "sentAt",
    "subject",
    "from",
    "to",
    "cc",
    "bcc",
    "replyTo",
    "messageId",
    "inReplyTo",
    "references",
    "hasAttachment",
    "bodyStructure",
    ...[
      "Return-Path",
      "Auto-Submitted",
      "Precedence",
      "List-Id",
      "List-Unsubscribe",
      "List-Unsubscribe-Post",
      "List-Post",
      "List-Help",
      "List-Archive",
      "X-Auto-Response-Suppress",
      "Content-Type",
      "Importance",
      "Priority",
      "X-Priority",
      "Disposition-Notification-To",
      "X-Spam-Flag",
      "X-Spam-Status",
      "X-Spam-Score",
    ].map((name) => `header:${name}:asRaw`),
  ]);
  expect(JMAP_EMAIL_BODY_PROPERTIES).toEqual(["partId", "type", "charset", "name", "cid", "disposition", "size", "subParts"]);
  const email = fixtureEmail("e1");
  expect(
    jmapEmailSnapshotSchema.parse({
      ...email,
      bodyValues: { secret: "body" },
      textBody: [],
      htmlBody: [],
      bodyStructure: { ...email.bodyStructure, headers: [] },
    }),
  ).toEqual(email);
});

for (const patch of [
  { id: "bad/id" },
  { blobId: "bad/id" },
  { threadId: "bad/id" },
  { mailboxIds: { "bad/id": true } },
  { receivedAt: null },
  { receivedAt: "not a date" },
  { receivedAt: "2026-02-30T00:00:00Z" },
  { sentAt: "invalid" },
  { size: -1 },
  { size: 1.5 },
  { hasAttachment: "true" },
]) {
  test(`rejects malformed email metadata ${JSON.stringify(patch)}`, () => {
    expect(jmapEmailSnapshotSchema.safeParse({ ...fixtureEmail("e1"), ...patch }).success).toBe(false);
  });
}
