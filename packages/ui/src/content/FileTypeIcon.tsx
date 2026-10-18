import { fileIcons } from "@k2b/stdlib";
import type { JSX } from "solid-js";

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

const SHEET = new Set(["xls", "xlsx", "ods", "csv"]);
const SLIDES = new Set(["ppt", "pptx", "odp"]);

/** Resolve the colour family for a file or folder from its name and media type. */
export const fileTypeOf = (file: { name: string; mediaType?: string; folder?: boolean }): FileType => {
  if (file.folder) return "folder";
  const category = fileIcons.getFileCategory({ name: file.name, type: "file", mimeType: file.mediaType });
  if (category === "document") {
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    return SHEET.has(extension) ? "sheet" : SLIDES.has(extension) ? "slides" : "document";
  }
  return category === "pdf" || category === "image" || category === "video" || category === "audio" || category === "archive"
    ? category
    : "other";
};

/** `fileIcons` adds Tailwind colour utilities that @k2b/ui does not ship; only the `ti-*` glyph is kept. */
const glyph = (props: FileTypeIconProps): string => {
  const icon = (
    props.icon ?? fileIcons.getFileIcon({ name: props.name, type: props.folder ? "directory" : "file", mimeType: props.mediaType })
  )
    .split(/\s+/)
    .filter((token) => token.startsWith("ti-"))
    .join(" ");
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
