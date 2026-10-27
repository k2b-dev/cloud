import { createZip, downloadFileFromContent } from "@k2b/stdlib/browser";
import { MAX_DRAFT_ATTACHMENT_BYTES } from "../../contracts";

/** A name for every entry that no other entry has: equal names get the next free counter ("report (2).pdf"). */
export const uniqueArchiveNames = (names: readonly string[]): string[] => {
  const used = new Set<string>();
  return names.map((name) => {
    const safe = name.replace(/[\\/]/g, "_").replace(/^\.+/, "_") || "attachment";
    const dot = safe.lastIndexOf(".");
    const [stem, extension] = dot > 0 ? [safe.slice(0, dot), safe.slice(dot)] : [safe, ""];
    let candidate = safe;
    for (let counter = 2; used.has(candidate.toLowerCase()); counter += 1) candidate = `${stem} (${counter})${extension}`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
};

/**
 * Packs a conversation's files into one ZIP in the browser. The archive holds at most what one draft may carry
 * (`MAX_DRAFT_ATTACHMENT_BYTES`), so a large conversation fails before it fetches anything instead of filling memory.
 * An aborted `signal` stops the fetches and downloads nothing.
 */
export const downloadMailAttachments = async (
  files: ReadonlyArray<{ name: string; href: string; size: number }>,
  archiveName: string,
  signal: AbortSignal,
): Promise<void> => {
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_DRAFT_ATTACHMENT_BYTES) throw new Error("The files are too large to pack together.");
  const names = uniqueArchiveNames(files.map((file) => file.name));
  const entries = [];
  for (const [index, file] of files.entries()) {
    const response = await fetch(file.href, { credentials: "same-origin", signal });
    if (!response.ok) throw new Error(`Could not load ${file.name}.`);
    entries.push({ filename: names[index]!, source: await response.blob() });
  }
  const archive = await createZip(entries);
  signal.throwIfAborted();
  downloadFileFromContent(archive, archiveName.replace(/[\\/]/g, "_"), "application/zip");
};
