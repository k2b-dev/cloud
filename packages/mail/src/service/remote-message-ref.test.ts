import { describe, expect, test } from "bun:test";
import { messageInspectorPlacementSchema } from "../contracts";
import { decodeRemoteMessageAddress, sameRemoteSnapshotAddress } from "./remote-message-ref";

const imap = { uid_validity: "10", uid: "42", remote_id: null, modseq: "99" };
const jmap = { uid_validity: null, uid: null, remote_id: "email_alpha", modseq: null };
const missing = { uid_validity: null, uid: null, remote_id: null, modseq: null };

describe("remote message addresses", () => {
  test("C1: decodes IMAP numerics without losing precision and opaque JMAP IDs", () => {
    expect(decodeRemoteMessageAddress(imap)).toEqual({ kind: "imap", uidValidity: "10", uid: "42", modseq: "99" });
    expect(decodeRemoteMessageAddress({ ...imap, uid: 42, uid_validity: 10n, modseq: null })).toEqual({
      kind: "imap",
      uidValidity: "10",
      uid: "42",
      modseq: null,
    });
    expect(decodeRemoteMessageAddress({ ...imap, uid_validity: "18446744073709551615" })).toMatchObject({
      uidValidity: "18446744073709551615",
    });
    expect(decodeRemoteMessageAddress(jmap)).toEqual({ kind: "jmap", emailId: "email_alpha" });
  });

  test("C1: checks all eight nullable address shapes; only snapshots may have no address", () => {
    for (const uid_validity of [null, "10"])
      for (const uid of [null, "42"])
        for (const remote_id of [null, "email_alpha"]) {
          const row = { uid_validity, uid, remote_id, modseq: null };
          const addressed =
            (remote_id === null && uid_validity !== null && uid !== null) || (remote_id !== null && uid_validity === null && uid === null);
          const absent = remote_id === null && uid_validity === null && uid === null;
          const stage = `C1 ${JSON.stringify(row)}`;
          if (addressed) expect(decodeRemoteMessageAddress(row), stage).not.toBeNull();
          else expect(() => decodeRemoteMessageAddress(row), stage).toThrow("Stored remote message address");
          if (addressed || absent) expect(() => decodeRemoteMessageAddress(row, true), stage).not.toThrow();
          else expect(() => decodeRemoteMessageAddress(row, true), stage).toThrow("Stored remote message address");
        }
    expect(decodeRemoteMessageAddress(missing, true)).toBeNull();
  });

  test("C7: compares protocol, folder and identity, never two absent addresses", () => {
    const a = { ...jmap, folder_id: "folder-a" };
    expect(sameRemoteSnapshotAddress(a, a)).toBeTrue();
    expect(sameRemoteSnapshotAddress(a, { ...a, remote_id: "email_beta" })).toBeFalse();
    expect(sameRemoteSnapshotAddress(a, { ...a, folder_id: "folder-b" })).toBeFalse();
    expect(sameRemoteSnapshotAddress(a, { ...imap, folder_id: "folder-a" })).toBeFalse();
    expect(sameRemoteSnapshotAddress({ ...missing, folder_id: "folder-a" }, { ...missing, folder_id: "folder-a" })).toBeFalse();
    expect(sameRemoteSnapshotAddress({ ...imap, folder_id: "folder-a" }, { ...imap, uid: 42, folder_id: "folder-a" })).toBeTrue();
    expect(sameRemoteSnapshotAddress({ ...imap, folder_id: "folder-a" }, { ...imap, uid: "43", folder_id: "folder-a" })).toBeFalse();
  });

  test("C9: preserves IMAP JSON and accepts JMAP without invented UID fields", () => {
    const common = { folderId: "abc123", folderName: "Inbox", remotePath: "INBOX", flags: [], keywords: [] };
    const old = { ...common, uidValidity: "10", uid: "42", modseq: null };
    expect(messageInspectorPlacementSchema.parse(old)).toEqual(old);
    const remote = { ...common, remoteId: "email_alpha" };
    expect(messageInspectorPlacementSchema.parse(remote)).toEqual(remote);
    expect(messageInspectorPlacementSchema.safeParse({ ...old, remoteId: "email_alpha" }).success).toBeFalse();
    expect(messageInspectorPlacementSchema.safeParse({ ...remote, uid: "null" }).success).toBeFalse();
  });
});
