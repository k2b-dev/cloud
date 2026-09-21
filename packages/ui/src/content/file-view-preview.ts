export type FileViewFile = {
  path: string;
  mediaType?: string;
  size?: number;
};

export type FileViewPreviewKind = "markdown" | "image" | "pdf" | "json" | "delimited-text" | "audio" | "video" | "text";

const MEBIBYTE = 1024 * 1024;

const maxPreviewBytes: Record<FileViewPreviewKind, number> = {
  markdown: 2 * MEBIBYTE,
  image: 25 * MEBIBYTE,
  pdf: 50 * MEBIBYTE,
  json: 2 * MEBIBYTE,
  "delimited-text": 2 * MEBIBYTE,
  audio: 50 * MEBIBYTE,
  video: 50 * MEBIBYTE,
  text: 2 * MEBIBYTE,
};

// SVG remains inert because FileView renders every image through <img>; never inject its markup into the DOM.
const imageMediaTypes = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/webp",
  "image/x-icon",
]);
const audioMediaTypes = new Set([
  "audio/aac",
  "audio/flac",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/x-wav",
]);
const videoMediaTypes = new Set(["video/mp4", "video/ogg", "video/webm"]);

const markdownExtensions = new Set(["md", "markdown"]);
const imageExtensions = new Set(["avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"]);
const audioExtensions = new Set(["aac", "flac", "m4a", "mp3", "oga", "ogg", "wav", "weba"]);
const videoExtensions = new Set(["m4v", "mp4", "ogv", "webm"]);
const textExtensions = new Set([
  "c",
  "conf",
  "cpp",
  "css",
  "env",
  "go",
  "h",
  "html",
  "ini",
  "java",
  "js",
  "jsx",
  "log",
  "mjs",
  "php",
  "py",
  "rb",
  "rs",
  "sh",
  "sql",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
]);

export const fileViewExtension = (path: string): string => {
  const cleanPath = path.split(/[?#]/, 1)[0] ?? path;
  const name = cleanPath.slice(cleanPath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

const normalizedMediaType = (mediaType?: string): string => mediaType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";

const previewKindByType = (file: FileViewFile): FileViewPreviewKind | null => {
  const extension = fileViewExtension(file.path);
  const mediaType = normalizedMediaType(file.mediaType);

  if (mediaType === "text/markdown" || markdownExtensions.has(extension)) return "markdown";
  if (mediaType === "application/json" || mediaType.endsWith("+json") || extension === "json") return "json";
  if (mediaType === "text/csv" || mediaType === "text/tab-separated-values" || extension === "csv" || extension === "tsv") {
    return "delimited-text";
  }
  if (mediaType === "application/pdf" || extension === "pdf") return "pdf";
  if (imageMediaTypes.has(mediaType) || imageExtensions.has(extension)) return "image";
  if (audioMediaTypes.has(mediaType) || audioExtensions.has(extension)) return "audio";
  if (videoMediaTypes.has(mediaType) || videoExtensions.has(extension)) return "video";
  if (
    mediaType.startsWith("text/") ||
    mediaType === "application/javascript" ||
    mediaType === "application/sql" ||
    mediaType === "application/xml" ||
    textExtensions.has(extension)
  ) {
    return "text";
  }
  return null;
};

/**
 * Returns the built-in preview kind when FileView can render the file within
 * its bounded client-side limits. Custom renderers remain registry-driven.
 */
export const getFileViewPreviewKind = (file: FileViewFile): FileViewPreviewKind | null => {
  const kind = previewKindByType(file);
  if (!kind) return null;
  if (file.size !== undefined && (!Number.isFinite(file.size) || file.size < 0 || file.size > maxPreviewBytes[kind])) {
    return null;
  }
  return kind;
};

/** Use this to expose preview actions only for files FileView can render. */
export const canPreviewFile = (file: FileViewFile): boolean => getFileViewPreviewKind(file) !== null;

export type DelimitedTextPreview = {
  rows: string[][];
  truncated: boolean;
  totalRows: number;
  columnsTruncated: boolean;
};

export const parseDelimitedText = (
  input: string,
  delimiter: string,
  limits: { rows?: number; columns?: number; offset?: number } = {},
): DelimitedTextPreview => {
  const maxRows = Math.max(1, limits.rows ?? 201);
  const maxColumns = Math.max(1, limits.columns ?? 50);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let truncated = false;
  let totalRows = 0;
  let columnsTruncated = false;

  const pushField = () => {
    if (row.length < maxColumns) row.push(field);
    else {
      truncated = true;
      columnsTruncated = true;
    }
    field = "";
  };
  const pushRow = () => {
    if (rows.length < maxRows && (totalRows === 0 || totalRows > (limits.offset ?? 0))) rows.push(row);
    else truncated = true;
    totalRows++;
    row = [];
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"' && field.length === 0) quoted = true;
    else if (character === delimiter) pushField();
    else if (character === "\n" || character === "\r") {
      pushField();
      pushRow();
      if (character === "\r" && input[index + 1] === "\n") index += 1;
    } else {
      field += character;
    }
  }

  if (field.length > 0 || row.length > 0) {
    pushField();
    pushRow();
  }

  return { rows, truncated, totalRows, columnsTruncated };
};
