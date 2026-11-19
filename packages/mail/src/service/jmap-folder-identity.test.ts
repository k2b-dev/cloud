import { expect, test } from "bun:test";
import { connectorKindSchema } from "../contracts";
import { sha256Json } from "./canonical";
import { jmapFolderStableKey, jmapScopeEvidenceSchema, jmapScopeFingerprint, type JmapScopeEvidence } from "./provider-identity";

const evidence: JmapScopeEvidence = { version: 1, kind: "jmap", origin: "https://mail.example.invalid", accountId: "account_1" };

test("JMAP identity: normalizes origin and hashes only account and mailbox identity", () => {
  const equivalent = { ...evidence, origin: "https://MAIL.example.invalid:443/" };
  expect(jmapScopeEvidenceSchema.parse(equivalent)).toEqual(evidence);
  expect(jmapScopeFingerprint(equivalent)).toBe(sha256Json(evidence));
  expect(jmapFolderStableKey(equivalent, "mailbox_1")).toBe(sha256Json({
    kind: "jmap", origin: evidence.origin, accountId: evidence.accountId, mailboxId: "mailbox_1",
  }));
  for (const other of [
    { ...evidence, accountId: "account_2" }, { ...evidence, origin: "https://other.example.invalid" },
  ]) {
    expect(jmapScopeFingerprint(other)).not.toBe(jmapScopeFingerprint(evidence));
    expect(jmapFolderStableKey(other, "mailbox_1")).not.toBe(jmapFolderStableKey(evidence, "mailbox_1"));
  }
  expect(jmapFolderStableKey(evidence, "mailbox_2")).not.toBe(jmapFolderStableKey(evidence, "mailbox_1"));
});

test("JMAP evidence: rejects unknown fields, versions, protocols and malformed IDs", () => {
  for (const invalid of [
    { ...evidence, version: 2 }, { ...evidence, kind: "imap" }, { ...evidence, folders: [] },
    { ...evidence, accountId: "bad/id" }, { ...evidence, accountId: "" },
    ...["invalid", "http://mail.example.invalid", "https://user:pass@mail.example.invalid", "https://mail.example.invalid/path",
      "https://mail.example.invalid?query=1", "https://mail.example.invalid#fragment"].map((origin) => ({ ...evidence, origin })),
  ]) expect(() => jmapScopeEvidenceSchema.parse(invalid)).toThrow();
  expect(() => jmapFolderStableKey(evidence, "bad/id")).toThrow();
  expect(connectorKindSchema.parse("jmap")).toBe("jmap");
  expect(connectorKindSchema.parse("imap_smtp")).toBe("imap_smtp");
  expect(connectorKindSchema.safeParse("unknown").success).toBeFalse();
});
