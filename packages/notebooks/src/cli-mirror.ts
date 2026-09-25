/**
 * One-way Markdown mirror of a notebook for `cld notebooks pull`.
 *
 * Layout: a note without children is `<segment>.md`; a note with children is
 * a folder `<segment>/` whose own content is `index.md`. Segments are mirror
 * path segments from `lib/note-path`. Attachments live in `_attachments/` and
 * `attach://<id>` links are rewritten to relative paths. Every file starts
 * with front matter (`id`, `title`, `updatedAt`). The manifest
 * `.cld-notebook.json` maps every file to its note and records the content
 * hash that was downloaded, so local edits are detected and never overwritten
 * without `--force`.
 */
import { mkdir, readdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { CloudCliContext } from "@k2b/cloud/cli";
import { noteContentHash } from "./lib/note-edit";
import { buildNotePaths } from "./lib/note-path";

export const MANIFEST_FILE = ".cld-notebook.json";
export const ATTACHMENTS_DIR = "_attachments";
const MANIFEST_VERSION = 1;
const OUTLINE_PAGE_SIZE = 1_000;
const FETCH_CONCURRENCY = 8;
const MAX_MIRROR_DEPTH = 64;

export type ManifestNote = { id: string; path: string; contentHash: string; updatedAt: string };

export type Manifest = {
  version: typeof MANIFEST_VERSION;
  server: string;
  notebook: { id: string; name: string };
  notes: ManifestNote[];
};

export type OutlineEntry = { id: string; parentId: string | null; title: string; hasChildren: boolean; updatedAt: string };

type AttachmentMeta = { id: string; filename: string };

type NoteContent = { id: string; title: string; updatedAt: string; contentMd: string | null };

export type MirrorRef = { root: string; manifest: Manifest; relPath: string };

export type SyncReport = {
  written: string[];
  removed: string[];
  /** Local files that were left untouched, with the reason. */
  kept: Array<{ path: string; reason: "local-changes" | "changed-on-both-sides" | "deleted-on-server" | "path-occupied" }>;
  attachments: { downloaded: number; removed: number };
};

const normalizeServer = (server: string): string => server.replace(/\/+$/, "");

const posixPath = (path: string): string => path.split(sep).join("/");

const depthOf = (path: string): number => path.split("/").length - 1;

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

// ==========================
// Manifest
// ==========================

export const readManifest = async (root: string): Promise<Manifest> => {
  const parsed = JSON.parse(await readFile(join(root, MANIFEST_FILE), "utf8")) as Manifest;
  if (parsed.version !== MANIFEST_VERSION || !parsed.notebook?.id || !Array.isArray(parsed.notes))
    throw new Error(`${join(root, MANIFEST_FILE)} is not a notebook mirror manifest (version ${MANIFEST_VERSION}).`);
  return parsed;
};

export const writeManifest = async (root: string, manifest: Manifest): Promise<void> => {
  const sorted: Manifest = { ...manifest, notes: [...manifest.notes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
  const target = join(root, MANIFEST_FILE);
  await writeFile(`${target}.tmp`, `${JSON.stringify(sorted, null, 2)}\n`);
  await rename(`${target}.tmp`, target);
};

/** Find the mirror containing `path` (a file, folder, or not-yet-existing file inside one). */
export const findMirror = async (path: string): Promise<{ root: string; relPath: string } | null> => {
  const absolute = resolve(path);
  let dir = absolute;
  for (let level = 0; level < MAX_MIRROR_DEPTH; level += 1) {
    if (await exists(join(dir, MANIFEST_FILE))) return { root: dir, relPath: posixPath(relative(dir, absolute)) };
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
};

/** Refuse a mirror that belongs to another Cloud server than the active profile. */
export const assertMirrorServer = (manifest: Manifest, server: string): void => {
  if (normalizeServer(manifest.server) !== normalizeServer(server))
    throw new Error(`This mirror belongs to ${manifest.server}, but the active profile uses ${server}.`);
};

/** Manifest entry of a mirror path: `x.md`, `x/index.md`, or the folder `x`. */
export const findManifestNote = (manifest: Manifest, relPath: string): ManifestNote | null => {
  const clean = relPath.replace(/\/+$/, "");
  return manifest.notes.find((note) => note.path === clean || note.path === `${clean}/index.md`) ?? null;
};

/** Note that owns the folder `dir` of a mirror: `dir/index.md` or the leaf `dir.md` that gains a child. */
export const findManifestFolder = (manifest: Manifest, dir: string): ManifestNote | null =>
  manifest.notes.find((note) => note.path === `${dir}/index.md` || note.path === `${dir}.md`) ?? null;

// ==========================
// File format
// ==========================

const FRONT_MATTER = /^---\n((?:[A-Za-z]+: .*\n){1,10})---\n/;

/** Remove the mirror front matter (a block with an `id:` field); other front matter stays content. */
export const stripFrontMatter = (text: string): string => {
  const match = FRONT_MATTER.exec(text);
  return match && /^id: /m.test(match[1]!) ? text.slice(match[0].length) : text;
};

const safeFileName = (filename: string): string =>
  filename
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|-+$/g, "")
    .slice(0, 120) || "file";

export const attachmentFileName = (attachment: AttachmentMeta): string => `${attachment.id}-${safeFileName(attachment.filename)}`;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `attach://<id>` → relative `_attachments/<id>-<name>` for a file at `depth`. */
export const rewriteAttachmentLinks = (content: string, depth: number, attachments: ReadonlyMap<string, AttachmentMeta>): string =>
  content.replace(/attach:\/\/([A-Za-z0-9]{6})/g, (link, id: string) => {
    const attachment = attachments.get(id);
    return attachment ? `${"../".repeat(depth)}${ATTACHMENTS_DIR}/${attachmentFileName(attachment)}` : link;
  });

/** Inverse of `rewriteAttachmentLinks` for the same depth. */
export const restoreAttachmentLinks = (content: string, depth: number): string =>
  content.replace(
    new RegExp(`(?<![./\\w])${escapeRegExp("../".repeat(depth))}${ATTACHMENTS_DIR}/([A-Za-z0-9]{6})-[A-Za-z0-9._-]*`, "g"),
    "attach://$1",
  );

/** Server content of a mirror file at `path`: without front matter and with `attach://` links. */
export const mirrorFileContent = (text: string, path: string): string => restoreAttachmentLinks(stripFrontMatter(text), depthOf(path));

export const renderMirrorFile = (
  note: { id: string; title: string; updatedAt: string },
  content: string,
  path: string,
  attachments: ReadonlyMap<string, AttachmentMeta>,
): string =>
  `---\nid: ${note.id}\ntitle: ${JSON.stringify(note.title)}\nupdatedAt: ${note.updatedAt}\n---\n${rewriteAttachmentLinks(content, depthOf(path), attachments)}`;

/** Whether the local file differs from the content recorded in the manifest. */
export const localFileState = async (
  root: string,
  note: ManifestNote,
): Promise<{ state: "missing" | "clean" | "modified"; text?: string }> => {
  const text = await readFile(join(root, note.path), "utf8").catch(() => null);
  if (text === null) return { state: "missing" };
  return { state: noteContentHash(mirrorFileContent(text, note.path)) === note.contentHash ? "clean" : "modified", text };
};

// ==========================
// Server reads
// ==========================

const mapLimit = async <T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

const notebookPath = (notebookId: string, suffix = "") => `/api/notebooks/${encodeURIComponent(notebookId)}${suffix}`;

export const fetchOutline = async (ctx: CloudCliContext, notebookId: string): Promise<OutlineEntry[]> => {
  const entries: OutlineEntry[] = [];
  for (let page = 1; ; page += 1) {
    const payload = await ctx.readJson<{ data: OutlineEntry[]; pagination: { has_next: boolean } }>(
      await ctx.fetch(notebookPath(notebookId, `/outline?page=${page}&per_page=${OUTLINE_PAGE_SIZE}`)),
    );
    entries.push(...payload.data);
    if (!payload.pagination.has_next) return entries;
  }
};

const fetchAttachments = async (ctx: CloudCliContext, notebookId: string): Promise<AttachmentMeta[]> =>
  ctx.readJson<AttachmentMeta[]>(await ctx.fetch(notebookPath(notebookId, "/attachments")));

const fetchContent = async (ctx: CloudCliContext, notebookId: string, noteId: string): Promise<NoteContent> =>
  ctx.readJson<NoteContent>(await ctx.fetch(notebookPath(notebookId, `/notes/${encodeURIComponent(noteId)}/content`)));

/** Mirror file path of every outline note. */
export const mirrorLayout = (outline: readonly OutlineEntry[]): Map<string, string> => {
  const paths = buildNotePaths(
    outline.map((entry) => ({ ...entry, shortId: entry.id })),
    { mirror: true },
  );
  return new Map(outline.map((entry) => [entry.id, entry.hasChildren ? `${paths.get(entry.id)}/index.md` : `${paths.get(entry.id)}.md`]));
};

// ==========================
// Sync
// ==========================

const removeEmptyDirs = async (root: string, paths: Iterable<string>): Promise<void> => {
  const dirs = new Set<string>();
  for (const path of paths) {
    for (let dir = dirname(path); dir !== "." && dir !== ""; dir = dirname(dir)) dirs.add(dir);
  }
  for (const dir of [...dirs].sort((a, b) => depthOf(b) - depthOf(a))) {
    const entries = await readdir(join(root, dir)).catch(() => null);
    if (entries && entries.length === 0) await rmdir(join(root, dir)).catch(() => undefined);
  }
};

const syncAttachments = async (ctx: CloudCliContext, root: string, notebookId: string, attachments: AttachmentMeta[]) => {
  const dir = join(root, ATTACHMENTS_DIR);
  const wanted = new Map(attachments.map((attachment) => [attachmentFileName(attachment), attachment]));
  const present = new Set(await readdir(dir).catch(() => [] as string[]));
  let removed = 0;
  for (const name of present) {
    if (/^[A-Za-z0-9]{6}-/.test(name) && !wanted.has(name)) {
      await unlink(join(dir, name));
      removed += 1;
    }
  }
  const missing = [...wanted].filter(([name]) => !present.has(name));
  if (missing.length > 0) await mkdir(dir, { recursive: true });
  await mapLimit(missing, FETCH_CONCURRENCY, async ([name, attachment]) => {
    const response = await ctx.fetch(notebookPath(notebookId, `/attachments/${encodeURIComponent(attachment.id)}/content`));
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    await Bun.write(join(dir, name), response);
  });
  if (present.size + missing.length - removed === 0) await rmdir(dir).catch(() => undefined);
  return { downloaded: missing.length, removed };
};

/**
 * Bring the mirror to the server state. Only changed notes are downloaded.
 * Files with local changes are never overwritten or deleted unless `force`
 * is set; a clean or locally changed file whose note moved moves with it.
 */
export const syncMirror = async (
  ctx: CloudCliContext,
  params: { root: string; manifest: Manifest; force: boolean },
): Promise<{ manifest: Manifest; report: SyncReport }> => {
  const { root, manifest, force } = params;
  const notebookId = manifest.notebook.id;
  const [outline, attachmentList] = await Promise.all([fetchOutline(ctx, notebookId), fetchAttachments(ctx, notebookId)]);
  const attachments = new Map(attachmentList.map((attachment) => [attachment.id, attachment]));
  const layout = mirrorLayout(outline);
  const previous = new Map(manifest.notes.map((note) => [note.id, note]));
  const local = new Map(await Promise.all(manifest.notes.map(async (note) => [note.id, await localFileState(root, note)] as const)));

  const needed = outline.filter((entry) => {
    const known = previous.get(entry.id);
    const state = local.get(entry.id)?.state;
    return !known || known.updatedAt !== entry.updatedAt || state === "missing" || (force && state === "modified");
  });
  const fetched = new Map(
    (await mapLimit(needed, FETCH_CONCURRENCY, (entry) => fetchContent(ctx, notebookId, entry.id))).map((note) => [note.id, note]),
  );

  const report: SyncReport = { written: [], removed: [], kept: [], attachments: { downloaded: 0, removed: 0 } };
  const writes: Array<{ id: string; path: string; text: string; inPlace: boolean }> = [];
  const removes = new Set<string>();
  const next: ManifestNote[] = [];

  for (const entry of outline) {
    const known = previous.get(entry.id);
    const state = local.get(entry.id);
    const target = layout.get(entry.id)!;
    const remote = fetched.get(entry.id);
    const meta = { id: entry.id, title: entry.title, updatedAt: entry.updatedAt };

    if (known && state?.state === "modified" && !force) {
      const serverChanged = remote !== undefined && noteContentHash(remote.contentMd ?? "") !== known.contentHash;
      if (serverChanged) {
        report.kept.push({ path: known.path, reason: "changed-on-both-sides" });
        next.push(known);
        continue;
      }
      if (known.path !== target) {
        // Carry the local edits along; only the relative attachment links follow the new depth.
        writes.push({
          id: entry.id,
          path: target,
          text: renderMirrorFile(meta, mirrorFileContent(state.text!, known.path), target, attachments),
          inPlace: false,
        });
        removes.add(known.path);
      }
      report.kept.push({ path: target, reason: "local-changes" });
      next.push({ ...known, path: target, updatedAt: entry.updatedAt });
      continue;
    }

    const content = remote ? (remote.contentMd ?? "") : state?.text !== undefined ? mirrorFileContent(state.text, known!.path) : null;
    if (content === null) continue;
    if (!remote && known?.path === target) {
      next.push(known);
      continue;
    }
    if (known && known.path !== target) removes.add(known.path);
    writes.push({
      id: entry.id,
      path: target,
      text: renderMirrorFile(meta, content, target, attachments),
      inPlace: known?.path === target,
    });
    next.push({ id: entry.id, path: target, contentHash: noteContentHash(content), updatedAt: remote?.updatedAt ?? entry.updatedAt });
  }

  const onServer = new Set(outline.map((entry) => entry.id));
  for (const known of manifest.notes) {
    if (onServer.has(known.id)) continue;
    if (local.get(known.id)?.state === "modified" && !force) {
      report.kept.push({ path: known.path, reason: "deleted-on-server" });
      next.push(known);
    } else {
      removes.add(known.path);
    }
  }

  // A path that stays occupied by a kept or unrelated local file is never overwritten.
  const applicable: typeof writes = [];
  for (const write of writes) {
    if (!write.inPlace && !force) {
      const keptThere = next.some((note) => note.id !== write.id && note.path === write.path && !removes.has(note.path));
      const onDisk = removes.has(write.path) ? null : await readFile(join(root, write.path), "utf8").catch(() => null);
      if (keptThere || (onDisk !== null && onDisk !== write.text)) {
        report.kept.push({ path: write.path, reason: "path-occupied" });
        next.splice(
          next.findIndex((note) => note.id === write.id),
          1,
        );
        continue;
      }
    }
    applicable.push(write);
  }

  for (const path of removes) {
    await unlink(join(root, path)).catch(() => undefined);
    report.removed.push(path);
  }
  for (const write of applicable) {
    await mkdir(dirname(join(root, write.path)), { recursive: true });
    await writeFile(join(root, write.path), write.text);
    report.written.push(write.path);
  }
  await removeEmptyDirs(root, removes);
  report.attachments = await syncAttachments(ctx, root, notebookId, attachmentList);

  const updated: Manifest = { ...manifest, notes: next };
  await writeManifest(root, updated);
  return { manifest: updated, report };
};

/** Record a note whose server content is known, e.g. right after a write. */
export const recordMirrorNote = async (
  root: string,
  manifest: Manifest,
  note: { id: string; title: string; updatedAt: string },
  content: string,
  attachments: ReadonlyMap<string, AttachmentMeta> = new Map(),
): Promise<Manifest> => {
  const known = manifest.notes.find((entry) => entry.id === note.id);
  if (!known) return manifest;
  await writeFile(join(root, known.path), renderMirrorFile(note, content, known.path, attachments));
  const updated: Manifest = {
    ...manifest,
    notes: manifest.notes.map((entry) =>
      entry.id === note.id ? { ...entry, contentHash: noteContentHash(content), updatedAt: note.updatedAt } : entry,
    ),
  };
  await writeManifest(root, updated);
  return updated;
};

export const newManifest = (server: string, notebook: { id: string; name: string }): Manifest => ({
  version: MANIFEST_VERSION,
  server: normalizeServer(server),
  notebook,
  notes: [],
});
