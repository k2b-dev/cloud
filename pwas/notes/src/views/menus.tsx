import { files } from "@k2b/stdlib/browser";
import { type DropdownItem, toast } from "@k2b/ui";
import { exportAll } from "../lib/transfer";
import { app, t } from "../state";
import { openImport } from "./Import";
import { openSettings } from "./Settings";
import { openWhatIs } from "./WhatIs";

export async function runExport(options: { includeLinks?: boolean } = {}) {
  const store = app.store();
  if (!store) return;
  try {
    const result = await exportAll(store, { includeLinks: options.includeLinks ?? false });
    files.downloadFileFromContent(result.blob, result.filename);
    toast.success(t().exportedBody({ count: result.notes }), { title: t().exported({ filename: result.filename }) });
  } catch {
    toast.error(t().exportFailed, { action: { label: t().retry, onClick: () => void runExport(options) } });
  }
}

export const overviewMenu = (): DropdownItem[] => [
  {
    items: [
      { label: t().exportAll, icon: "ti ti-download", action: () => void runExport() },
      { label: t().importNotes, icon: "ti ti-upload", action: () => openImport() },
    ],
  },
  {
    items: [
      { label: t().settings, icon: "ti ti-settings", action: () => openSettings() },
      { label: t().whatIs, icon: "ti ti-info-circle", action: () => openWhatIs() },
    ],
  },
];
