import type { ImapRemoteMessageRef, RemoteMessageRef } from "../contracts";

type AddressColumns = {
  uid_validity: string | number | bigint | null;
  uid: string | number | bigint | null;
  remote_id: string | null;
  modseq: string | number | bigint | null;
};
type RemoteMessageAddress =
  | Omit<ImapRemoteMessageRef, "folderStableKey">
  | Omit<Extract<RemoteMessageRef, { kind: "jmap" }>, "folderStableKey">;

/** Decode the database's exclusive address forms before any numeric transport conversion. */
export function decodeRemoteMessageAddress(row: AddressColumns, allowMissing?: false): RemoteMessageAddress;
export function decodeRemoteMessageAddress(row: AddressColumns, allowMissing: true): RemoteMessageAddress | null;
export function decodeRemoteMessageAddress(row: AddressColumns, allowMissing = false): RemoteMessageAddress | null {
  if (typeof row.remote_id === "string" && row.uid_validity === null && row.uid === null) {
    return { kind: "jmap", emailId: row.remote_id };
  }
  if (row.remote_id === null && row.uid_validity != null && row.uid != null) {
    return {
      kind: "imap",
      uidValidity: String(row.uid_validity),
      uid: String(row.uid),
      modseq: row.modseq === null ? null : String(row.modseq),
    };
  }
  if (allowMissing && row.remote_id === null && row.uid_validity === null && row.uid === null) return null;
  throw Object.assign(new Error("Stored remote message address is incomplete or mixes protocols"), {
    code: "INVALID_REMOTE_MESSAGE_ADDRESS",
  });
}

export const unsupportedRemoteMessageProtocol = () =>
  Object.assign(new Error("JMAP message addresses are not supported by the IMAP transport"), {
    code: "REMOTE_MESSAGE_PROTOCOL_UNSUPPORTED",
  });

/** A missing address is never evidence that two snapshots refer to the same remote copy. */
export const sameRemoteSnapshotAddress = (
  left: AddressColumns & { folder_id: string | null },
  right: AddressColumns & { folder_id: string | null },
): boolean => {
  const a = decodeRemoteMessageAddress(left, true);
  const b = decodeRemoteMessageAddress(right, true);
  if (!left.folder_id || left.folder_id !== right.folder_id || !a || !b) return false;
  if (a.kind === "jmap") return b.kind === "jmap" && a.emailId === b.emailId;
  return b.kind === "imap" && a.uidValidity === b.uidValidity && a.uid === b.uid;
};
