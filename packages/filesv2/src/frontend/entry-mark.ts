import { type FileType, fileTypeOf } from "@k2b/ui";
import type { MarkProps } from "@k2b/ui/v2";
import { entryIcon } from "./entry-icon";

/** The colour of Files itself: a folder, a storage and the places of Files wear it. */
export const FILES_COLOR = "#1d4ed8";

/** The data colour of each kind of file, so a PDF looks the same in every list, card and sentence. */
const TYPE_COLORS: Record<FileType, string | undefined> = {
  folder: FILES_COLOR,
  pdf: "#dc2626",
  image: "#0891b2",
  sheet: "#15803d",
  document: "#2563eb",
  slides: "#c2410c",
  video: "#7c3aed",
  audio: "#db2777",
  archive: "#a16207",
  // code, text and unknown files stay neutral: their type letters say what they are
  other: undefined,
};

/**
 * The mark of an entry: its symbol on the tint of its type, with the type in letters on the corner ("PDF", "DXF").
 * A folder carries the colour of Files and no letters.
 */
export function entryMark(entry: { name: string; directory: boolean }): MarkProps {
  const type = fileTypeOf({ name: entry.name, folder: entry.directory });
  const dot = entry.name.lastIndexOf(".");
  const extension = !entry.directory && dot > 0 ? entry.name.slice(dot + 1) : "";
  return {
    icon: entry.directory ? "folder-filled" : entryIcon(entry),
    color: TYPE_COLORS[type],
    ...(/^[a-z0-9]{2,4}$/i.test(extension) ? { kind: extension.toUpperCase() } : {}),
  };
}

/** Group storage colours: distinct from the file types, steady per storage across sidebar, cards and sentences. */
const STORAGE_COLORS = ["#0f766e", "#7c3aed", "#c2410c", "#0369a1", "#be185d", "#4d7c0f", "#a16207", "#4338ca"] as const;

/**
 * The mark of a storage: the own home in the colour of Files, each group storage in a colour of its own, picked from
 * its ID so it stays the same on every page and for every person.
 */
export function storageMark(base: { id: string; kind: "users" | "groups" }): MarkProps {
  if (base.kind === "users") return { icon: "home", color: FILES_COLOR };
  let hash = 0;
  for (const char of base.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return { icon: "users", color: STORAGE_COLORS[hash % STORAGE_COLORS.length] };
}
