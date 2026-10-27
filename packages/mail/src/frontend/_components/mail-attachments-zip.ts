import { downloadAsZip } from "@k2b/stdlib/browser";
import { MAX_DRAFT_ATTACHMENT_BYTES } from "../../contracts";

/**
 * Packs a conversation's files into one ZIP in the browser. The archive holds at most what one draft may carry
 * (`MAX_DRAFT_ATTACHMENT_BYTES`), so a large conversation fails before it fetches anything instead of filling memory.
 * Equal names get a counter, so no file replaces another in the archive.
 */
export const downloadMailAttachments = async (
  files: ReadonlyArray<{ name: string; href: string; size: number }>,
  archiveName: string,
): Promise<void> => {
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_DRAFT_ATTACHMENT_BYTES) throw new Error("The files are too large to pack together.");
  const used = new Map<string, number>();
  const entries = [];
  for (const file of files) {
    const response = await fetch(file.href, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`Could not load ${file.name}.`);
    const safe = file.name.replace(/[\\/]/g, "_").replace(/^\.+/, "_") || "attachment";
    const seen = used.get(safe) ?? 0;
    used.set(safe, seen + 1);
    const dot = safe.lastIndexOf(".");
    const filename = seen === 0 ? safe : dot > 0 ? `${safe.slice(0, dot)} (${seen + 1})${safe.slice(dot)}` : `${safe} (${seen + 1})`;
    entries.push({ filename, source: await response.blob() });
  }
  await downloadAsZip(entries, archiveName.replace(/[\\/]/g, "_"));
};
