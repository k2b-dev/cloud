export type PreviewVariant = "small" | "large" | "pdf" | "text";
export type PreviewSourceKind = "image" | "pdf" | "office" | "text";

const extensions: Record<PreviewSourceKind, readonly string[]> = {
  image: ["jpg", "jpeg", "png", "webp", "gif", "avif", "tif", "tiff"],
  pdf: ["pdf"],
  office: ["docx", "doc", "odt", "xlsx", "xls", "ods", "pptx", "ppt", "odp", "rtf"],
  text: [
    "txt",
    "md",
    "markdown",
    "csv",
    "json",
    "log",
    "js",
    "jsx",
    "ts",
    "tsx",
    "css",
    "html",
    "xml",
    "yaml",
    "yml",
    "toml",
    "py",
    "sh",
    "sql",
    "rs",
    "go",
    "java",
    "c",
    "h",
    "cpp",
  ],
};

/** File extensions take precedence over optional transport metadata. No SVG or HTML rendering. */
export function previewSourceKind(name: string, mediaType?: string): PreviewSourceKind | null {
  const extension = name.split(/[\\/]/).at(-1)?.split(".").slice(1).at(-1)?.toLowerCase();
  for (const kind of ["image", "pdf", "office", "text"] as const) {
    if (extension && extensions[kind].includes(extension)) return kind;
  }
  const type = mediaType?.split(";")[0]?.trim().toLowerCase();
  if (["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "image/tiff"].includes(type ?? "")) return "image";
  if (type === "application/pdf") return "pdf";
  if (["text/plain", "text/markdown", "text/csv", "application/json"].includes(type ?? "")) return "text";
  return null;
}
