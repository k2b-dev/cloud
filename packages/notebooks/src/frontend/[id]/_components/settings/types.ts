import type { DateContext } from "@k2b/stdlib";
import type { LogTableEntry } from "@k2b/ui";
import type { Notebook, NoteTreeNode } from "../sidebar/types";

export type NotebookSettingsProps = {
  notebook: Notebook;
  tree: NoteTreeNode[];
  isAdmin: boolean;
  canWrite: boolean;
  dateConfig: DateContext;
  /** Returns an element inside the app; settings that depend on the app's width follow its `k2b-app-area` host. */
  host: () => Element;
};

export type NoteSelectOption = {
  id: string;
  label: string;
  description?: string;
  icon?: string;
};

export type BackupStatus = {
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  scheduleCron: string;
  accessKeyIdSet: boolean;
  secretAccessKeySet: boolean;
  configured: boolean;
  missing: string[];
  target: string | null;
};

export type BackupRunResult = {
  message: string;
  exportedAt: string;
  filename: string;
  bytes: number;
  sha256: string;
  paths: {
    latestZip: string;
    snapshotZip: string;
    manifest: string;
  };
};

export type BackupDraft = Pick<BackupStatus, "enabled" | "endpoint" | "region" | "bucket">;

export type SnapshotLogEntry = LogTableEntry;
