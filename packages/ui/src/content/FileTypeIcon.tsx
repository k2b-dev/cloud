import { fileIcons } from "@k2b/stdlib";
import type { JSX } from "solid-js";
import { resolveFileListMessages } from "./file-list-messages";

/** The colour family a file's icon tile uses. `other` covers code, text, and unknown files. */
export type FileType = "folder" | "pdf" | "image" | "sheet" | "document" | "slides" | "video" | "audio" | "archive" | "other";

export type FileTypeIconProps = {
  /** The file or folder name; its extension picks the glyph and the type colour. */
  name: string;
  mediaType?: string;
  folder?: boolean;
  /** Shows an open folder, for example the folder a list is showing. */
  open?: boolean;
  /** A Tabler icon class that replaces the glyph the name picks; the type colour still follows the name. */
  icon?: string;
  /** `sm` for tree rows, `md` for list rows, `lg` for grid previews. Defaults to `md`. */
  size?: "sm" | "md" | "lg";
  class?: string;
};

// Known extensions decide first: a generic media type such as `text/plain` or `text/csv` must not hide a sheet,
// a slide deck, a document, or an archive behind the neutral family.
const BY_EXTENSION = new Map<string, FileType>(
  (
    [
      ["sheet", ["xls", "xlsx", "ods", "csv"]],
      ["slides", ["ppt", "pptx", "odp"]],
      ["document", ["doc", "docx", "odt", "rtf"]],
      ["archive", ["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"]],
    ] as const
  ).flatMap(([type, extensions]) => extensions.map((extension) => [extension, type] as const)),
);

/** Resolve the colour family for a file or folder from its name and media type. */
export const fileTypeOf = (file: { name: string; mediaType?: string; folder?: boolean }): FileType => {
  if (file.folder) return "folder";
  const known = BY_EXTENSION.get(file.name.split(".").pop()?.toLowerCase() ?? "");
  if (known) return known;
  const category = fileIcons.getFileCategory({ name: file.name, type: "file", mimeType: file.mediaType });
  return category === "pdf" || category === "image" || category === "video" || category === "audio" || category === "archive"
    ? category
    : "other";
};

/**
 * The readable kind of a file in `locale`, such as "PDF", "Image", or "Spreadsheet", for a meta line like
 * "PDF · 4.2 MB" instead of a media type. An unknown kind names the file's extension ("ICC"), and a file without
 * one reads "File".
 */
export const fileKindLabel = (file: { name: string; mediaType?: string; folder?: boolean }, locale: string): string => {
  const t = resolveFileListMessages(locale);
  const type = fileTypeOf(file);
  if (type !== "other") return t[type];
  const dot = file.name.lastIndexOf(".");
  const extension = dot > 0 ? file.name.slice(dot + 1) : "";
  return /^[a-z0-9]{1,8}$/i.test(extension) ? extension.toUpperCase() : t.file;
};

/** `fileIcons` adds Tailwind colour utilities that @k2b/ui does not ship; only the `ti-*` glyph is kept. */
const glyph = (props: FileTypeIconProps): string => {
  // `fileIcons` looks names up in plain objects, so a name such as `constructor` returns an inherited member
  // instead of a class string; such names fall back to the generic glyph.
  const found: unknown =
    props.icon ?? fileIcons.getFileIcon({ name: props.name, type: props.folder ? "directory" : "file", mimeType: props.mediaType });
  const icon =
    (typeof found === "string" ? found : "")
      .split(/\s+/)
      .filter((token) => token.startsWith("ti-"))
      .join(" ") || (props.folder ? "ti-folder" : "ti-file");
  return props.folder && props.open ? icon.replace(/\bti-folder$/, "ti-folder-open") : icon;
};

/**
 * A file or folder glyph in a soft chip of its type colour. Folders take the app accent hook
 * `--k2b-app-workspace-active`; code, text, and unknown files a neutral ink. The box size is fixed per `size`.
 */
export function FileTypeIcon(props: FileTypeIconProps): JSX.Element {
  return (
    <span
      class={`k2b-icon-tile k2b-file-type-icon ${props.class ?? ""}`}
      data-file-type={fileTypeOf({ name: props.name, mediaType: props.mediaType, folder: props.folder })}
      data-size={props.size ?? "md"}
      aria-hidden="true"
    >
      <i class={`ti ${glyph(props)}`} />
    </span>
  );
}
