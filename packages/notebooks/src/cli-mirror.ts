/**
 * Markdown mirror of a notebook for `cld notebooks pull`.
 *
 * Layout: a note without children is `<segment>.md`; a note with children is
 * a folder `<segment>/` whose own content is `index.md`. Segments are mirror
 * path segments from `lib/note-path`. Attachments live in `_attachments/` and
 * `attach://<id>` links are rewritten to relative paths; so are `note://<id>`
 * link targets of notes inside the mirror. Every file starts
 * with front matter (`id`, `title`, `updatedAt`). The manifest
 * `.cld-notebook.json` maps every file to its note and records the content
 * hash that was downloaded and the hash of the file that was written, so
 * local edits are detected exactly and never overwritten without `--force`.
 */
import { mkdir, readdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import type { CloudCliContext } from "@k2b/cloud/cli";
import { noteContentHash } from "./lib/note-edit";
import { buildNotePaths } from "./lib/note-path";

export const MANIFEST_FILE = ".cld-notebook.json";
export const ATTACHMENTS_DIR = "_attachments";
const MANIFEST_VERSION = 1;
const OUTLINE_PAGE_SIZE = 1_000;
const FETCH_CONCURRENCY = 8;
const MAX_MIRROR_DEPTH = 64;

export type ManifestNote = {
  id: string;
  path: string;
  /** Hash of the server content that was downloaded. */
  contentHash: string;
  /** Hash of the exact file text that was written; missing in manifests written before note links became paths. */
  fileHash?: string;
  updatedAt: string;
};

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
  /** Local files that pull kept where they are instead of matching the server, with the reason. */
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

/** Mirror file path of every note, by note ID. */
export type NotePaths = ReadonlyMap<string, string>;

/** Note ID of every mirror file, by path. */
export type NoteFiles = ReadonlyMap<string, string>;

export const manifestFiles = (manifest: Manifest): NoteFiles => new Map(manifest.notes.map((note) => [note.path, note.id]));

const relativeNoteLink = (from: string, to: string): string => posix.relative(posix.dirname(from), to);

/** `](note://<id>` → `](<relative path>` for a file at `path`; notes outside the mirror keep their link. */
export const rewriteNoteLinks = (content: string, path: string, notePaths: NotePaths): string =>
  content.replace(/\]\(note:\/\/([A-Za-z0-9]{6})(?=[)#\s])/g, (link, id: string) => {
    const target = notePaths.get(id);
    return target ? `](${relativeNoteLink(path, target)}` : link;
  });

const RELATIVE_NOTE_LINK = /\]\(([^()#\s]+\.md)(?=[)#\s])/g;

/** Note of a relative link target from `path`, when it names the note's file the way `rewriteNoteLinks` writes it. */
const linkedNote = (target: string, path: string, noteFiles: NoteFiles): string | undefined => {
  const file = posix.join(posix.dirname(path), target);
  return relativeNoteLink(path, file) === target ? noteFiles.get(file) : undefined;
};

/**
 * `](<relative path>` → `](note://<id>` for every relative link from `path` that names a note's file the way
 * `rewriteNoteLinks` writes it. Undoes `rewriteNoteLinks`, but also turns such a literal relative link into a note link.
 */
export const restoreNoteLinks = (content: string, path: string, noteFiles: NoteFiles): string =>
  content.replace(RELATIVE_NOTE_LINK, (link, target: string) => {
    const id = linkedNote(target, path, noteFiles);
    return id ? `](note://${id}` : link;
  });

/** Relative note links of a file at `path` follow their notes from `before` to `after`; a note that left gets its `note://` link. */
const followNoteLinks = (content: string, path: string, before: NoteFiles, after: NotePaths): string =>
  content.replace(RELATIVE_NOTE_LINK, (link, target: string) => {
    const id = linkedNote(target, path, before);
    if (!id) return link;
    const moved = after.get(id);
    return moved ? `](${relativeNoteLink(path, moved)}` : `](note://${id}`;
  });

/** Whether the note links of a file at `path` change when notes move from `before` to `after`; literal relative links may also count. */
const noteLinksChange = (text: string, path: string, before: NoteFiles, after: NotePaths): boolean => {
  const content = stripFrontMatter(text);
  return rewriteNoteLinks(restoreNoteLinks(content, path, before), path, after) !== content;
};

/** Mirror text as it lives in a file at `path`, with its relative links turned back into `attach://` and `note://` links. */
export const restoreMirrorLinks = (content: string, path: string, noteFiles: NoteFiles): string =>
  restoreNoteLinks(restoreAttachmentLinks(content, depthOf(path)), path, noteFiles);

/** Content to upload for a mirror file at `path`: without front matter and with `attach://` and `note://` links. */
export const mirrorFileContent = (text: string, path: string, noteFiles: NoteFiles): string =>
  restoreMirrorLinks(stripFrontMatter(text), path, noteFiles);

export const renderMirrorFile = (
  note: { id: string; title: string; updatedAt: string },
  content: string,
  path: string,
  attachments: ReadonlyMap<string, AttachmentMeta>,
  notePaths: NotePaths,
): string =>
  `---\nid: ${note.id}\ntitle: ${JSON.stringify(note.title)}\nupdatedAt: ${note.updatedAt}\n---\n${rewriteNoteLinks(rewriteAttachmentLinks(content, depthOf(path), attachments), path, notePaths)}`;

/**
 * Whether the local file still holds exactly what pull wrote. Entries without `fileHash` come from files
 * that never had note links as paths; for them the content without front matter is compared.
 */
export const localFileState = async (
  root: string,
  note: ManifestNote,
): Promise<{ state: "missing" | "clean" | "modified"; text?: string }> => {
  const text = await readFile(join(root, note.path), "utf8").catch(() => null);
  if (text === null) return { state: "missing" };
  const clean =
    note.fileHash === undefined
      ? noteContentHash(restoreAttachmentLinks(stripFrontMatter(text), depthOf(note.path))) === note.contentHash
      : noteContentHash(text) === note.fileHash;
  return { state: clean ? "clean" : "modified", text };
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
 * is set; they move along when their note moved, and their relative note
 * links follow the notes they name, so writing them back keeps every link on
 * its note. A move onto a path that another file holds is skipped, and the
 * note stays at its old path. Notes in `refetch` were just written: their
 * files take the server copy regardless of local state.
 *
 * Note links point to the final paths of the next manifest. A clean file is
 * rendered again from downloaded content when it moves, or when a note it
 * links to moves, appears, or leaves the mirror.
 */
export const syncMirror = async (
  ctx: CloudCliContext,
  params: { root: string; manifest: Manifest; force: boolean; refetch?: ReadonlySet<string> },
): Promise<{ manifest: Manifest; report: SyncReport }> => {
  const { root, manifest, force, refetch = new Set<string>() } = params;
  const notebookId = manifest.notebook.id;
  const [outline, attachmentList] = await Promise.all([fetchOutline(ctx, notebookId), fetchAttachments(ctx, notebookId)]);
  const attachments = new Map(attachmentList.map((attachment) => [attachment.id, attachment]));
  const layout = mirrorLayout(outline);
  const entries = new Map(outline.map((entry) => [entry.id, entry]));
  const previous = new Map(manifest.notes.map((note) => [note.id, note]));
  const previousFiles = manifestFiles(manifest);
  const local = new Map(await Promise.all(manifest.notes.map(async (note) => [note.id, await localFileState(root, note)] as const)));
  const edited = (id: string) => !force && !refetch.has(id) && local.get(id)?.state === "modified";

  const fetched = new Map<string, NoteContent>();
  const download = async (ids: string[]) => {
    for (const note of await mapLimit(ids, FETCH_CONCURRENCY, (id) => fetchContent(ctx, notebookId, id))) fetched.set(note.id, note);
  };
  // New, changed, missing, discarded, and just written notes, and clean notes that move (their relative links change).
  await download(
    outline
      .filter((entry) => {
        const known = previous.get(entry.id);
        if (!known || known.updatedAt !== entry.updatedAt || refetch.has(entry.id)) return true;
        return !edited(entry.id) && (local.get(entry.id)?.state !== "clean" || known.path !== layout.get(entry.id));
      })
      .map((entry) => entry.id),
  );

  // Final path of every note in the next manifest; files kept for local changes stay where they are.
  const kept = new Map<string, SyncReport["kept"][number]>();
  const placed = new Map<string, string>();
  for (const entry of outline) {
    const known = previous.get(entry.id);
    const remote = fetched.get(entry.id);
    if (known && edited(entry.id) && remote && noteContentHash(remote.contentMd ?? "") !== known.contentHash) {
      kept.set(entry.id, { path: known.path, reason: "changed-on-both-sides" });
      placed.set(entry.id, known.path);
    } else {
      placed.set(entry.id, layout.get(entry.id)!);
    }
  }
  const onServer = new Set(outline.map((entry) => entry.id));
  for (const known of manifest.notes) {
    if (onServer.has(known.id) || !edited(known.id)) continue;
    kept.set(known.id, { path: known.path, reason: "deleted-on-server" });
    placed.set(known.id, known.path);
  }

  // Local edits carry over; everything else is rendered from server content.
  const contentOf = (id: string): string =>
    edited(id) ? mirrorFileContent(local.get(id)!.text!, previous.get(id)!.path, previousFiles) : (fetched.get(id)!.contentMd ?? "");
  const render = (id: string, path: string, content = contentOf(id)): string =>
    renderMirrorFile(entries.get(id)!, content, path, attachments, placed);

  // A move needs a free path: not held by another note, and not by an unrelated local file unless that file
  // already has the exact text (an interrupted pull). A skipped move keeps the old path, which can block another move.
  const moving = force ? [] : outline.map((entry) => entry.id).filter((id) => !kept.has(id) && previous.get(id)?.path !== placed.get(id));
  const unrelated = new Map(
    await Promise.all(
      moving.map(async (id) => {
        const path = placed.get(id)!;
        return [id, previousFiles.has(path) ? null : await readFile(join(root, path), "utf8").catch(() => null)] as const;
      }),
    ),
  );
  const holders = new Map<string, number>();
  const hold = (path: string, change: number) => holders.set(path, (holders.get(path) ?? 0) + change);
  for (const path of placed.values()) hold(path, 1);
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of moving) {
      if (kept.has(id)) continue;
      const path = placed.get(id)!;
      const file = unrelated.get(id) ?? null;
      if (holders.get(path) === 1 && (file === null || file === render(id, path))) continue;
      const known = previous.get(id);
      kept.set(id, { path: known?.path ?? path, reason: "path-occupied" });
      hold(path, -1);
      if (known) {
        placed.set(id, known.path);
        hold(known.path, 1);
      } else placed.delete(id);
      changed = true;
    }
  }

  // A file with local edits at its final path: moved along with its note, or in place with relative note links that
  // follow their notes. Everything else in it stays as the user wrote it.
  const editedText = (id: string, path: string): string => {
    const text = local.get(id)!.text!;
    if (path !== previous.get(id)!.path) return render(id, path);
    const body = stripFrontMatter(text);
    return `${text.slice(0, text.length - body.length)}${followNoteLinks(body, path, previousFiles, placed)}`;
  };

  // Clean files whose note links change because a linked note moved, appeared, or left the mirror, and edited files
  // that pull rewrites, whose file hash must describe the server copy at the new place.
  await download(
    outline
      .filter((entry) => {
        const known = previous.get(entry.id);
        const path = placed.get(entry.id);
        const state = local.get(entry.id);
        if (!known || state?.text === undefined || path === undefined || fetched.has(entry.id)) return false;
        if (edited(entry.id)) return path !== known.path || editedText(entry.id, path) !== state.text;
        return state.state === "clean" && noteLinksChange(state.text, known.path, previousFiles, placed);
      })
      .map((entry) => entry.id),
  );

  const writes: Array<{ path: string; text: string }> = [];
  const removes = new Set<string>();
  const next: ManifestNote[] = [];
  const keepEdits = (known: ManifestNote, path: string) => {
    const text = editedText(known.id, path);
    if (path !== known.path) removes.add(known.path);
    if (path !== known.path || text !== local.get(known.id)!.text) writes.push({ path, text });
  };
  for (const entry of outline) {
    const known = previous.get(entry.id);
    const path = placed.get(entry.id);
    if (path === undefined) continue;
    const remote = fetched.get(entry.id);
    if (edited(entry.id)) {
      keepEdits(known!, path);
      if (!kept.has(entry.id)) kept.set(entry.id, { path, reason: "local-changes" });
      // A conflict keeps its old record, so the next pull still sees it. Otherwise the server copy is still the base
      // of the edits, and the file hash names what pull would write for it at the final place.
      if (kept.get(entry.id)!.reason === "changed-on-both-sides") next.push(known!);
      else
        next.push({
          ...known!,
          path,
          updatedAt: entry.updatedAt,
          ...(remote ? { fileHash: noteContentHash(render(entry.id, path, remote.contentMd ?? "")) } : {}),
        });
      continue;
    }
    if (!remote) {
      next.push(known!);
      continue;
    }
    const text = render(entry.id, path);
    if (known && known.path !== path) removes.add(known.path);
    if (known?.path !== path || local.get(entry.id)?.text !== text) writes.push({ path, text });
    next.push({
      id: entry.id,
      path,
      contentHash: noteContentHash(remote.contentMd ?? ""),
      fileHash: noteContentHash(text),
      updatedAt: remote.updatedAt,
    });
  }
  for (const known of manifest.notes) {
    if (onServer.has(known.id)) continue;
    if (kept.has(known.id)) {
      keepEdits(known, known.path);
      next.push(known);
    } else removes.add(known.path);
  }

  const report: SyncReport = { written: [], removed: [], kept: [...kept.values()], attachments: { downloaded: 0, removed: 0 } };
  for (const path of removes) {
    await unlink(join(root, path)).catch(() => undefined);
    report.removed.push(path);
  }
  for (const write of writes) {
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

export const newManifest = (server: string, notebook: { id: string; name: string }): Manifest => ({
  version: MANIFEST_VERSION,
  server: normalizeServer(server),
  notebook,
  notes: [],
});
