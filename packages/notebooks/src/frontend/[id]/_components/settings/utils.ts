import type { LogTableEntry } from "@k2b/ui";
import type { NoteTreeNode } from "../sidebar/types";
import type { BackupDraft, BackupRunResult, BackupStatus, NoteSelectOption } from "./types";

export const flattenNoteOptions = (nodes: NoteTreeNode[], untitled = "Untitled", depth = 0): NoteSelectOption[] =>
  nodes.flatMap((note) => [
    {
      id: note.id,
      label: `${"\u00A0\u00A0".repeat(depth)}${note.title || untitled}`,
      description: `#${note.id}`,
      icon: note.lockedAt ? "ti ti-lock" : "ti ti-file-text",
    },
    ...flattenNoteOptions(note.children, untitled, depth + 1),
  ]);

export const readErrorMessage = async (response: Response, fallback: string): Promise<string> => {
  try {
    const data = (await response.json()) as { message?: string };
    if (typeof data?.message === "string" && data.message.length > 0) return data.message;
  } catch {
    // Keep the caller-provided fallback.
  }
  return fallback;
};

export const backupDraftFromStatus = (status: BackupStatus): BackupDraft => ({
  enabled: status.enabled,
  endpoint: status.endpoint,
  region: status.region || "us-east-1",
  bucket: status.bucket,
});

export const backupDraftIsDirty = (draft: BackupDraft, base: BackupDraft, accessKeyId: string, secretAccessKey: string): boolean =>
  draft.enabled !== base.enabled ||
  draft.endpoint.trim() !== base.endpoint ||
  (draft.region.trim() || "us-east-1") !== base.region ||
  draft.bucket.trim() !== base.bucket ||
  accessKeyId.trim().length > 0 ||
  secretAccessKey.trim().length > 0;

export const snapshotLogEntryFromRun = (run: BackupRunResult, notebookShortId: string): LogTableEntry => ({
  id: `local:${run.sha256}`,
  level: "info",
  source: "notebooks:snapshot:s3",
  message: run.message,
  metadata: {
    trigger: "manual",
    notebookShortId,
    bytes: run.bytes,
    sha256: run.sha256,
    latestZip: run.paths.latestZip,
    snapshotZip: run.paths.snapshotZip,
  },
  createdAt: run.exportedAt,
});
