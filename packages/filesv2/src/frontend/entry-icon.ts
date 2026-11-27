import { fileIcons } from "@k2b/stdlib";

/**
 * The Tabler symbol of an entry for v2, which names icons without `ti-`: a folder, or the glyph of its file type.
 * Names such as `constructor` would find an inherited member of the lookup and fall back to the plain file.
 */
export function entryIcon(entry: { name: string; directory: boolean }): string {
  if (entry.directory) return "folder";
  const found: unknown = fileIcons.getFileIcon({ name: entry.name, type: "file" });
  const glyph = (typeof found === "string" ? found : "").split(/\s+/).find((token) => token.startsWith("ti-"));
  return glyph ? glyph.slice(3) : "file";
}
