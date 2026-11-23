/**
 * Minimal file metadata required by the file-icon utilities.
 *
 * Consumers can pass any object conforming to this shape (e.g. a full
 * `FileInfo` from a storage API) without importing the concrete type.
 */
export type FileInfoLike = {
  name: string;
  type: "file" | "directory";
  mimeType?: string;
};

// ============ Types ============

/**
 * Broad file-type category used for action matching and grouping.
 *
 * Categories: `"image"`, `"pdf"`, `"video"`, `"audio"`, `"text"`,
 * `"code"`, `"document"`, `"archive"`, `"other"`.
 */
export type FileCategory = "image" | "pdf" | "video" | "audio" | "text" | "code" | "document" | "archive" | "other";

/**
 * Determines the broad {@link FileCategory} of a file.
 *
 * The MIME type is checked first (e.g. `image/*`, `video/*`). When the
 * MIME type is absent or does not match a known category, the file
 * extension is used as a fallback. If neither matches, returns `"other"`.
 *
 * @param item - File metadata (name, type, optional MIME type)
 * @returns The resolved file category
 */
export function getFileCategory(item: FileInfoLike): FileCategory {
  const mime = item.mimeType ?? "";
  const ext = item.name.split(".").pop()?.toLowerCase() ?? "";

  if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"].includes(ext)) {
    return "image";
  }

  if (mime === "application/pdf" || ext === "pdf") {
    return "pdf";
  }

  if (mime.startsWith("video/") || ["mp4", "webm", "mkv", "avi", "mov", "wmv", "flv", "m4v"].includes(ext)) {
    return "video";
  }

  if (mime.startsWith("audio/") || ["mp3", "wav", "ogg", "flac", "aac", "m4a", "wma"].includes(ext)) {
    return "audio";
  }

  if (
    [
      "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "py", "pyw", "rs", "go", "c", "h", "cpp", "hpp", "cc",
      "java", "kt", "cs", "rb", "php", "swift", "sh", "bash", "zsh", "ps1", "bat", "cmd", "sql",
    ].includes(ext)
  ) {
    return "code";
  }

  if (
    mime.startsWith("text/") ||
    [
      "txt", "md", "mdx", "markdown", "rst", "log", "json", "jsonc", "yaml", "yml", "toml", "xml", "ini", "env",
      "gitignore", "dockerfile", "makefile",
    ].includes(ext)
  ) {
    return "text";
  }

  if (["doc", "docx", "odt", "xls", "xlsx", "ods", "csv", "ppt", "pptx", "odp", "rtf"].includes(ext)) {
    return "document";
  }

  if (mime.includes("zip") || mime.includes("compressed") || ["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"].includes(ext)) {
    return "archive";
  }

  return "other";
}

// ============ Icon Mappings ============

const EXTENSION_ICONS: Record<string, string> = {
  // JavaScript / TypeScript
  js: "ti-brand-javascript text-yellow-400",
  mjs: "ti-brand-javascript text-yellow-400",
  cjs: "ti-brand-javascript text-yellow-400",
  jsx: "ti-brand-javascript text-yellow-400",
  ts: "ti-brand-typescript text-blue-500",
  mts: "ti-brand-typescript text-blue-500",
  cts: "ti-brand-typescript text-blue-500",
  tsx: "ti-brand-typescript text-blue-500",

  // Web
  html: "ti-brand-html5 text-orange-500",
  htm: "ti-brand-html5 text-orange-500",
  css: "ti-brand-css3 text-blue-400",
  scss: "ti-brand-sass text-pink-400",
  sass: "ti-brand-sass text-pink-400",
  less: "ti-file-code text-blue-300",
  vue: "ti-brand-vue text-green-500",
  svelte: "ti-brand-svelte text-orange-600",

  // Python
  py: "ti-brand-python text-yellow-500",
  pyw: "ti-brand-python text-yellow-500",
  pyx: "ti-brand-python text-yellow-500",
  pxd: "ti-brand-python text-yellow-500",
  pyi: "ti-brand-python text-yellow-500",
  ipynb: "ti-notebook text-orange-400",

  // Rust
  rs: "ti-brand-rust text-orange-700",
  rlib: "ti-brand-rust text-orange-700",

  // Go
  go: "ti-brand-golang text-cyan-500",
  mod: "ti-brand-golang text-cyan-500",
  sum: "ti-brand-golang text-cyan-500",

  // C / C++
  c: "ti-brand-c text-blue-600",
  h: "ti-brand-c text-blue-600",
  cpp: "ti-brand-cpp text-blue-700",
  hpp: "ti-brand-cpp text-blue-700",
  cc: "ti-brand-cpp text-blue-700",
  cxx: "ti-brand-cpp text-blue-700",

  // Java / Kotlin
  java: "ti-coffee text-red-600",
  jar: "ti-coffee text-red-600",
  kt: "ti-brand-kotlin text-purple-500",
  kts: "ti-brand-kotlin text-purple-500",

  // C# / .NET
  cs: "ti-brand-c-sharp text-purple-600",
  csx: "ti-brand-c-sharp text-purple-600",
  fs: "ti-brand-f-sharp text-blue-500",
  fsx: "ti-brand-f-sharp text-blue-500",

  // Ruby
  rb: "ti-diamond text-red-500",
  rake: "ti-diamond text-red-500",
  gemspec: "ti-diamond text-red-500",

  // PHP
  php: "ti-brand-php text-indigo-400",
  phtml: "ti-brand-php text-indigo-400",

  // Swift / Objective-C
  swift: "ti-brand-swift text-orange-500",
  m: "ti-apple text-zinc-500",
  mm: "ti-apple text-zinc-500",

  // Shell
  sh: "ti-terminal-2 text-green-500",
  bash: "ti-terminal-2 text-green-500",
  zsh: "ti-terminal-2 text-green-500",
  fish: "ti-terminal-2 text-green-500",
  ps1: "ti-brand-powershell text-blue-500",
  psm1: "ti-brand-powershell text-blue-500",
  bat: "ti-terminal text-zinc-500",
  cmd: "ti-terminal text-zinc-500",

  // Config / Data
  json: "ti-braces text-yellow-500",
  jsonc: "ti-braces text-yellow-500",
  json5: "ti-braces text-yellow-500",
  yaml: "ti-file-settings text-red-400",
  yml: "ti-file-settings text-red-400",
  toml: "ti-file-settings text-zinc-500",
  xml: "ti-file-code text-orange-400",
  ini: "ti-settings text-zinc-400",
  env: "ti-key text-yellow-600",
  properties: "ti-settings text-zinc-400",

  // Markup / Docs
  md: "ti-markdown text-zinc-500",
  mdx: "ti-markdown text-zinc-500",
  markdown: "ti-markdown text-zinc-500",
  rst: "ti-file-text text-zinc-500",
  txt: "ti-file-text text-zinc-400",
  rtf: "ti-file-text text-zinc-400",
  tex: "ti-tex text-green-600",
  latex: "ti-tex text-green-600",

  // Database
  sql: "ti-database text-blue-500",
  sqlite: "ti-database text-blue-400",
  db: "ti-database text-zinc-500",

  // Docker / DevOps
  dockerfile: "ti-brand-docker text-blue-500",
  dockerignore: "ti-brand-docker text-blue-300",

  // Git
  gitignore: "ti-brand-git text-orange-500",
  gitattributes: "ti-brand-git text-orange-500",
  gitmodules: "ti-brand-git text-orange-500",

  // Images
  png: "ti-photo text-emerald-500",
  jpg: "ti-photo text-emerald-500",
  jpeg: "ti-photo text-emerald-500",
  gif: "ti-photo text-emerald-500",
  webp: "ti-photo text-emerald-500",
  avif: "ti-photo text-emerald-500",
  bmp: "ti-photo text-emerald-500",
  ico: "ti-photo text-emerald-500",
  svg: "ti-svg text-orange-400",
  psd: "ti-brand-adobe-photoshop text-blue-500",
  ai: "ti-brand-adobe-illustrator text-orange-500",
  xd: "ti-brand-adobe-xd text-pink-500",
  fig: "ti-brand-figma text-purple-500",
  sketch: "ti-brand-sketch text-orange-400",

  // Video
  mp4: "ti-video text-purple-500",
  webm: "ti-video text-purple-500",
  mkv: "ti-video text-purple-500",
  avi: "ti-video text-purple-500",
  mov: "ti-video text-purple-500",
  wmv: "ti-video text-purple-500",
  flv: "ti-video text-purple-500",
  m4v: "ti-video text-purple-500",

  // Audio
  mp3: "ti-music text-pink-500",
  wav: "ti-music text-pink-500",
  ogg: "ti-music text-pink-500",
  flac: "ti-music text-pink-500",
  aac: "ti-music text-pink-500",
  m4a: "ti-music text-pink-500",
  wma: "ti-music text-pink-500",

  // Documents
  pdf: "ti-file-type-pdf text-red-500",
  doc: "ti-file-type-doc text-blue-600",
  docx: "ti-file-type-doc text-blue-600",
  odt: "ti-file-type-doc text-blue-500",
  xls: "ti-file-spreadsheet text-green-600",
  xlsx: "ti-file-spreadsheet text-green-600",
  ods: "ti-file-spreadsheet text-green-500",
  csv: "ti-file-spreadsheet text-green-500",
  ppt: "ti-presentation text-orange-500",
  pptx: "ti-presentation text-orange-500",
  odp: "ti-presentation text-orange-400",

  // Archives
  zip: "ti-file-zip text-yellow-600",
  tar: "ti-file-zip text-yellow-600",
  gz: "ti-file-zip text-yellow-600",
  tgz: "ti-file-zip text-yellow-600",
  bz2: "ti-file-zip text-yellow-600",
  xz: "ti-file-zip text-yellow-600",
  "7z": "ti-file-zip text-yellow-600",
  rar: "ti-file-zip text-yellow-600",

  // Executables / Binaries
  exe: "ti-app-window text-zinc-500",
  msi: "ti-app-window text-zinc-500",
  dmg: "ti-app-window text-zinc-500",
  app: "ti-app-window text-zinc-500",
  deb: "ti-package text-red-500",
  rpm: "ti-package text-red-500",
  apk: "ti-brand-android text-green-500",
  ipa: "ti-brand-apple text-zinc-500",

  // Fonts
  ttf: "ti-typography text-zinc-500",
  otf: "ti-typography text-zinc-500",
  woff: "ti-typography text-zinc-500",
  woff2: "ti-typography text-zinc-500",
  eot: "ti-typography text-zinc-500",

  // 3D / CAD
  obj: "ti-3d-cube-sphere text-zinc-500",
  fbx: "ti-3d-cube-sphere text-zinc-500",
  stl: "ti-3d-cube-sphere text-zinc-500",
  gltf: "ti-3d-cube-sphere text-zinc-500",
  glb: "ti-3d-cube-sphere text-zinc-500",
  blend: "ti-brand-blender text-orange-500",

  // Misc
  log: "ti-file-analytics text-zinc-400",
  lock: "ti-lock text-zinc-500",
  bak: "ti-file-diff text-zinc-400",
  tmp: "ti-clock text-zinc-400",
  cache: "ti-clock text-zinc-400",
};

// Special filename to icon mapping
const FILENAME_ICONS: Record<string, string> = {
  dockerfile: "ti-brand-docker text-blue-500",
  "docker-compose.yml": "ti-brand-docker text-blue-500",
  "docker-compose.yaml": "ti-brand-docker text-blue-500",
  "compose.yml": "ti-brand-docker text-blue-500",
  "compose.yaml": "ti-brand-docker text-blue-500",
  makefile: "ti-settings-code text-zinc-500",
  cmakelists: "ti-settings-code text-zinc-500",
  "package.json": "ti-brand-npm text-red-500",
  "package-lock.json": "ti-brand-npm text-red-400",
  "yarn.lock": "ti-brand-yarn text-blue-400",
  "bun.lockb": "ti-file-zip text-orange-400",
  "pnpm-lock.yaml": "ti-brand-npm text-orange-400",
  "tsconfig.json": "ti-brand-typescript text-blue-500",
  "jsconfig.json": "ti-brand-javascript text-yellow-400",
  ".prettierrc": "ti-wand text-pink-400",
  ".eslintrc": "ti-shield-check text-purple-500",
  ".gitignore": "ti-brand-git text-orange-500",
  ".env": "ti-key text-yellow-600",
  ".env.local": "ti-key text-yellow-600",
  ".env.development": "ti-key text-yellow-500",
  ".env.production": "ti-key text-yellow-700",
  readme: "ti-book text-blue-400",
  "readme.md": "ti-book text-blue-400",
  license: "ti-license text-zinc-500",
  "license.md": "ti-license text-zinc-500",
  changelog: "ti-list-details text-green-500",
  "changelog.md": "ti-list-details text-green-500",
};

// Special folder name to icon mapping (GNOME standard desktop directories)
const FOLDER_ICONS: Record<string, string> = {
  documents: "ti-briefcase text-blue-500",
  dokumente: "ti-briefcase text-blue-500",
  desktop: "ti-device-desktop-analytics text-zinc-500",
  schreibtisch: "ti-device-desktop-analytics text-zinc-500",
  pictures: "ti-photo text-emerald-500",
  bilder: "ti-photo text-emerald-500",
  music: "ti-music text-pink-500",
  musik: "ti-music text-pink-500",
  videos: "ti-video text-purple-500",
  downloads: "ti-download text-cyan-500",
  templates: "ti-template text-zinc-400",
  vorlagen: "ti-template text-zinc-400",
  public: "ti-world text-green-500",
  "\u00f6ffentlich": "ti-world text-green-500",
  trash: "ti-trash text-zinc-400",
};

// ============ Public API ============

/**
 * Returns a Tabler Icons CSS class string for a file or directory.
 *
 * Icon lookup follows this priority chain:
 * 1. **Directory** -- checks the `FOLDER_ICONS` map by folder name,
 *    falls back to a generic folder icon.
 * 2. **Exact filename** -- checks `FILENAME_ICONS` (e.g. `"dockerfile"`).
 * 3. **File extension** -- checks `EXTENSION_ICONS`.
 * 4. **MIME type prefix** -- matches broad types like `image/*`, `video/*`.
 * 5. **Default** -- returns `"ti-file text-zinc-400"`.
 *
 * @param item - File metadata (name, type, optional MIME type)
 * @returns Tabler icon class string with a Tailwind color utility
 */
export function getFileIcon(item: FileInfoLike): string {
  if (item.type === "directory") {
    const folderIcon = FOLDER_ICONS[item.name.toLowerCase()];
    if (folderIcon) return folderIcon;
    return "ti-folder text-amber-500";
  }

  const name = item.name.toLowerCase();

  if (FILENAME_ICONS[name]) {
    return FILENAME_ICONS[name];
  }

  const ext = name.split(".").pop() ?? "";
  if (EXTENSION_ICONS[ext]) {
    return EXTENSION_ICONS[ext];
  }

  const mime = item.mimeType ?? "";

  if (mime.startsWith("image/")) return "ti-photo text-emerald-500";
  if (mime.startsWith("video/")) return "ti-video text-purple-500";
  if (mime.startsWith("audio/")) return "ti-music text-pink-500";
  if (mime.startsWith("text/")) return "ti-file-text text-zinc-500";
  if (mime === "application/pdf") return "ti-file-type-pdf text-red-500";
  if (mime.includes("zip") || mime.includes("compressed")) return "ti-file-zip text-yellow-600";

  return "ti-file text-zinc-400";
}

/**
 * Namespace object exposing all file-icon utilities for convenience imports.
 *
 * @example
 * import { fileIcons } from "@k2b/stdlib";
 * const icon = fileIcons.getFileIcon(file);
 * const category = fileIcons.getFileCategory(file);
 */
export const fileIcons = {
  getFileCategory,
  getFileIcon,
} as const;
