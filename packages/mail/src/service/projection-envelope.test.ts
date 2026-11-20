import { describe, expect, test } from "bun:test";
import type { ProjectionEnvelope } from "./connectors";
import { decodeRemoteMessageAddress } from "./remote-message-ref";
import { hashEnvelopeAddress } from "./sync-runtime";

const message: ProjectionEnvelope = {
  remoteRef: { kind: "imap", folderStableKey: "inbox", uidValidity: "500", uid: "1", modseq: null },
  providerMessageId: null,
  providerThreadId: null,
  messageId: "<projection@example.test>",
  inReplyTo: null,
  references: [],
  subject: "Projection",
  sentAt: new Date("2026-11-19T12:00:00Z"),
  internalDate: new Date("2026-11-19T12:00:00Z"),
  sizeBytes: 42,
  flags: [],
  labels: [],
  addresses: { from: [], to: [], cc: [], bcc: [], replyTo: [] },
  mimeStructure: {},
};
const address = { remoteResourceId: "resource-a", folderId: "folder-a", message };

describe("projection envelope locators", () => {
  test("H1: preserves the fixed IMAP hash and ignores MODSEQ", () => {
    expect(hashEnvelopeAddress(address), "H1: unchanged IMAP hash").toBe(
      "9f03601e9da1b0690b35f63ffd228adfb998d6db9b7d743ef12fd1d4af2ca388",
    );
    expect(
      hashEnvelopeAddress({
        ...address,
        message: { ...message, remoteRef: { kind: "imap", folderStableKey: "renamed", uidValidity: "500", uid: "1", modseq: "99" } },
      }),
      "H1: only the existing IMAP address fields participate",
    ).toBe(hashEnvelopeAddress(address));
  });

  test("H2: JMAP hashes the resource and opaque Email ID, independently of membership", () => {
    const remoteRef = {
      ...decodeRemoteMessageAddress({ uid: null, uid_validity: null, modseq: null, remote_id: "email_alpha" }),
      folderStableKey: "inbox",
    };
    const jmap = { ...address, message: { ...message, remoteRef } };
    expect(remoteRef, "H2: decoded JMAP locator").toEqual({ kind: "jmap", emailId: "email_alpha", folderStableKey: "inbox" });
    expect(hashEnvelopeAddress(jmap), "H2: fixed JMAP hash").toBe("ac6287a2d8d4014586277ba86290eb197b1134691d8d7a12a9417b31259940d4");
    expect(
      hashEnvelopeAddress({
        ...jmap,
        folderId: "folder-b",
        message: { ...jmap.message, remoteRef: { ...remoteRef, folderStableKey: "archive" } },
      }),
      "H2: folder-independent",
    ).toBe(hashEnvelopeAddress(jmap));
    expect(hashEnvelopeAddress({ ...jmap, remoteResourceId: "resource-b" }), "H2: resource boundary").not.toBe(hashEnvelopeAddress(jmap));
    expect(
      hashEnvelopeAddress({
        ...jmap,
        message: { ...message, remoteRef: { kind: "jmap", folderStableKey: "inbox", emailId: "email_beta" } },
      }),
      "H2: Email ID boundary",
    ).not.toBe(hashEnvelopeAddress(jmap));
  });
});
