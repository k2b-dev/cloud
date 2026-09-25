import { mkdir, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  arg,
  type CloudCliContext,
  type CloudCliText,
  command,
  confirmFlag,
  createAccessCommands,
  defineCliCommands,
  flag,
  localizeCloudCliText,
  printRows,
  printStructured,
} from "@k2b/cloud/cli";
import type { AccessEntry, PermissionLevel, Principal } from "@k2b/cloud/contracts";
import {
  assertMirrorServer,
  fetchOutline,
  findManifestFolder,
  findManifestNote,
  findMirror,
  MANIFEST_FILE,
  type Manifest,
  type ManifestNote,
  mirrorFileContent,
  newManifest,
  type OutlineEntry,
  readManifest,
  restoreAttachmentLinks,
  type SyncReport,
  stripFrontMatter,
  syncMirror,
  writeManifest,
} from "./cli-mirror";
import { findNamedBlocks, type NamedBlockType, namedBlockBody } from "./lib/named-blocks";
import {
  applyNoteEdits,
  type NoteEditBlockSummary,
  type NoteEditOperation,
  noteContentHash,
  summarizeNoteEditBlocks,
} from "./lib/note-edit";
import { noteSlug } from "./lib/note-path";
import { hasNoteTitleHeading } from "./lib/note-title";
import { PRESENTATION_MODES } from "./lib/presentation-mode";

type Notebook = {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  homepageNoteId: string | null;
  defaultPresentationMode: string;
  defaultNoteTitleTemplate: string;
  createdAt: string;
  updatedAt: string;
};

type Note = {
  id: string;
  notebookId: string;
  parentId: string | null;
  title: string;
  position: number;
  hasChildren: boolean;
  contentMd: string | null;
  createdAt: string;
  updatedAt: string;
  lockedAt: string | null;
};

type NoteEditResponse = {
  note: Note;
  content: string;
  changed: boolean;
  beforeHash: string;
  afterHash: string;
  blocks: NoteEditBlockSummary[];
};

type Page<T> = { data: T[]; pagination: { page: number; per_page: number; total: number; has_next: boolean } };

type Attachment = { id: string; filename: string; mimeType: string; sizeBytes: number; kind: "image" | "file"; createdAt: string };

type MessageResponse = { message: string };

type TreeNode = { id: string; title: string; hasChildren: boolean; updatedAt: string; children: TreeNode[] };

/** A resolved note: IDs always, the mirror when the address was a mirror file. */
type NoteTarget = {
  notebookId: string;
  noteId: string;
  note?: Note;
  mirror?: { root: string; manifest: Manifest; entry: ManifestNote };
};

type Mirror = { root: string; relPath: string; manifest: Manifest };

const NOTE_ID = /^[A-Za-z0-9]{6}$/;
const JSON_HEADERS = { "Content-Type": "application/json" };

const api = (notebookId: string, suffix = "") => `/api/notebooks/${encodeURIComponent(notebookId)}${suffix}`;
const noteApi = (target: { notebookId: string; noteId: string }, suffix = "") =>
  api(target.notebookId, `/notes/${encodeURIComponent(target.noteId)}${suffix}`);

const isHttpStatus = (error: unknown, status: number): boolean => error instanceof Error && error.message.startsWith(`${status} `);

const expandHome = (path: string): string => (path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path);

const looksLocal = (raw: string): boolean => /^(?:\/|\.{1,2}(?:\/|$)|~(?:\/|$))/.test(raw);

const depthOf = (path: string): number => path.split("/").length - 1;

const formatNumberedLines = (content: string): string =>
  content
    .split("\n")
    .map((line, index) => `${String(index + 1).padStart(4, " ")} | ${line}`)
    .join("\n");

const parseLineRange = (value: string): { startLine: number; endLine: number } => {
  const [startRaw, endRaw] = value.split(":");
  const startLine = Number.parseInt(startRaw ?? "", 10);
  const endLine = Number.parseInt(endRaw ?? startRaw ?? "", 10);
  if (!/^\d+(?::\d+)?$/.test(value) || !Number.isSafeInteger(startLine) || startLine < 1 || endLine < startLine)
    throw new Error(`Invalid line range "${value}". Use 1-based "start:end".`);
  return { startLine, endLine };
};

const parseLineValue = (value: string): number => {
  const line = Number.parseInt(value, 10);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(line) || line < 1)
    throw new Error(`Invalid line "${value}". Use a 1-based line number.`);
  return line;
};

/** Index of the first ATX level-1 heading outside fenced code, or -1. */
const firstHeadingLine = (lines: string[]): number => {
  let fence: string | null = null;
  for (const [index, line] of lines.entries()) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    if (/^\s{0,3}#(?:[\t ]+|$)/.test(line)) return index;
  }
  return -1;
};

function notebooksCommands(locale?: string) {
  const t = (text: CloudCliText) => localizeCloudCliText(locale, text);

  // ==========================
  // Shared helpers
  // ==========================

  const readContentSource = async (from: string | undefined, content: string | undefined): Promise<string | undefined> => {
    if (from !== undefined && content !== undefined)
      throw new Error(t({ en: "Pass only one of --from or --content.", de: "Übergib nur --from oder --content." }));
    if (content !== undefined) return content;
    if (from === "-") return Bun.stdin.text();
    if (from !== undefined) return readFile(expandHome(from), "utf8");
    return undefined;
  };

  const requireContent = async (from: string | undefined, content: string | undefined): Promise<string> => {
    const value = await readContentSource(from, content);
    if (value === undefined)
      throw new Error(
        t({
          en: "Missing content. Pass --from <file|-> or --content <text>.",
          de: "Inhalt fehlt. Übergib --from <datei|-> oder --content <text>.",
        }),
      );
    return value;
  };

  /** Fail before any request when nobody can answer the confirmation prompt. */
  const requireConfirmable = (yes: boolean): void => {
    if (!yes && !process.stdin.isTTY)
      throw new Error(t({ en: "Refusing without confirmation. Pass --yes.", de: "Abgebrochen ohne Bestätigung. Übergib --yes." }));
  };

  const confirm = async (yes: boolean, question: string): Promise<void> => {
    requireConfirmable(yes);
    if (yes) return;
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await prompt.question(`${question} [y/N] `);
    prompt.close();
    if (!/^(?:y|yes|j|ja)$/i.test(answer.trim())) throw new Error(t({ en: "Cancelled.", de: "Abgebrochen." }));
  };

  const rethrowConflict = (error: unknown): never => {
    if (isHttpStatus(error, 409) && /hash|updatedAt|changed|geändert|Konflikt|conflict/i.test(String((error as Error).message)))
      throw new Error(
        t({
          en: "409 The note changed elsewhere since you pulled or read it. Pull first (`cld notebooks pull <dir>`) or read it again, then retry.",
          de: "409 Die Notiz wurde seit deinem Pull oder Lesen anderswo geändert. Führe zuerst `cld notebooks pull <ordner>` aus oder lies sie erneut und versuche es dann noch einmal.",
        }),
      );
    throw error;
  };

  // ==========================
  // Addressing
  // ==========================

  const getNotebook = async (ctx: CloudCliContext, ref: string): Promise<Notebook> => {
    if (NOTE_ID.test(ref)) {
      try {
        return await ctx.readJson<Notebook>(await ctx.fetch(api(ref)));
      } catch (error) {
        if (!isHttpStatus(error, 404)) throw error;
      }
    }
    const page = await ctx.readJson<Page<Notebook>>(await ctx.fetch(`/api/notebooks?${new URLSearchParams({ q: ref, per_page: "100" })}`));
    const matches = page.data.filter((item) => item.name === ref);
    if (matches.length === 1) return matches[0]!;
    const list = (items: Notebook[]) => items.map((item) => `${item.name} (${item.id})`).join(", ");
    if (matches.length > 1)
      throw new Error(
        t({
          en: `Notebook name "${ref}" is ambiguous: ${list(matches)}. Use the ID.`,
          de: `Der Notizbuchname „${ref}“ ist mehrdeutig: ${list(matches)}. Verwende die ID.`,
        }),
      );
    throw new Error(
      t({
        en: `No notebook has the ID or exact name "${ref}".${page.data.length ? ` Similar: ${list(page.data.slice(0, 5))}` : ""}`,
        de: `Kein Notizbuch hat die ID oder den exakten Namen „${ref}“.${page.data.length ? ` Ähnlich: ${list(page.data.slice(0, 5))}` : ""}`,
      }),
    );
  };

  const openMirror = async (ctx: CloudCliContext, raw: string): Promise<Mirror | null> => {
    const found = await findMirror(expandHome(raw));
    if (!found) return null;
    const manifest = await readManifest(found.root);
    assertMirrorServer(manifest, ctx.options.server);
    return { ...found, manifest };
  };

  const requireMirror = async (ctx: CloudCliContext, raw: string): Promise<Mirror> => {
    const mirror = await openMirror(ctx, raw);
    if (mirror) return mirror;
    throw new Error(
      t({
        en: `"${raw}" is not a note address. Use a note ID, <notebook>:<path>, or a file inside a pulled mirror.`,
        de: `„${raw}“ ist keine Notizadresse. Verwende eine Notiz-ID, <notizbuch>:<pfad> oder eine Datei in einem gepullten Spiegel.`,
      }),
    );
  };

  const splitNotebookPath = (raw: string): { notebook: string; path: string } | null => {
    const colon = raw.indexOf(":");
    return colon > 0 ? { notebook: raw.slice(0, colon), path: raw.slice(colon + 1) } : null;
  };

  const resolvePath = async (ctx: CloudCliContext, notebookId: string, path: string): Promise<Note & { path: string }> =>
    ctx.readJson<Note & { path: string }>(await ctx.fetch(api(notebookId, `/resolve?${new URLSearchParams({ path })}`)));

  /** Resolve a note address: note ID, `<notebook>:<path>`, or a mirror file. */
  const resolveNote = async (ctx: CloudCliContext, raw: string): Promise<NoteTarget> => {
    if (!looksLocal(raw) && NOTE_ID.test(raw)) {
      const note = await ctx.readJson<Note>(await ctx.fetch(`/api/notebooks/notes/${encodeURIComponent(raw)}`));
      return { notebookId: note.notebookId, noteId: note.id, note };
    }
    const split = looksLocal(raw) ? null : splitNotebookPath(raw);
    if (split) {
      const notebook = await getNotebook(ctx, split.notebook);
      if (!split.path.replace(/\//g, "").trim())
        throw new Error(
          t({ en: `"${raw}" is the notebook root, not a note.`, de: `„${raw}“ ist die oberste Ebene des Notizbuchs, keine Notiz.` }),
        );
      const note = await resolvePath(ctx, notebook.id, split.path);
      return { notebookId: notebook.id, noteId: note.id, note };
    }
    const mirror = await requireMirror(ctx, raw);
    const entry = findManifestNote(mirror.manifest, mirror.relPath);
    if (!entry)
      throw new Error(
        t({
          en: `${mirror.relPath || "."} is not a note in the mirror manifest. Run \`cld notebooks pull ${mirror.root}\`, or write the file to create it.`,
          de: `${mirror.relPath || "."} ist keine Notiz im Spiegel-Manifest. Führe \`cld notebooks pull ${mirror.root}\` aus oder schreibe die Datei, um sie anzulegen.`,
        }),
      );
    return { notebookId: mirror.manifest.notebook.id, noteId: entry.id, mirror: { root: mirror.root, manifest: mirror.manifest, entry } };
  };

  const loadNote = async (ctx: CloudCliContext, target: NoteTarget): Promise<Note> =>
    target.note ?? ctx.readJson<Note>(await ctx.fetch(noteApi(target)));

  /** Notebook plus an optional note below it: `<notebook>`, `<notebook>:<path>`, or a mirror folder or file. */
  const resolveScope = async (
    ctx: CloudCliContext,
    raw: string,
  ): Promise<{ notebook: { id: string; name: string }; noteId: string | null }> => {
    if (looksLocal(raw)) {
      const mirror = await requireMirror(ctx, raw);
      const entry = mirror.relPath ? findManifestNote(mirror.manifest, mirror.relPath) : null;
      if (mirror.relPath && !entry)
        throw new Error(
          t({ en: `${mirror.relPath} is not in the mirror manifest.`, de: `${mirror.relPath} ist nicht im Spiegel-Manifest.` }),
        );
      return { notebook: mirror.manifest.notebook, noteId: entry?.id ?? null };
    }
    const split = splitNotebookPath(raw);
    const notebook = await getNotebook(ctx, split?.notebook ?? raw);
    const path = split?.path.replace(/^\/+|\/+$/g, "") ?? "";
    return { notebook: { id: notebook.id, name: notebook.name }, noteId: path ? (await resolvePath(ctx, notebook.id, path)).id : null };
  };

  /** A notebook: `<notebook>`, `<notebook>:`, or a path inside its mirror. */
  const resolveNotebookRef = async (ctx: CloudCliContext, raw: string): Promise<Notebook> => {
    if (looksLocal(raw)) return getNotebook(ctx, (await requireMirror(ctx, raw)).manifest.notebook.id);
    return getNotebook(ctx, raw.endsWith(":") ? raw.slice(0, -1) : raw);
  };

  // ==========================
  // Mirror write-back
  // ==========================

  const reportSync = (ctx: CloudCliContext, report: SyncReport) => {
    for (const kept of report.kept) {
      const reason = {
        "local-changes": t({ en: "local changes", de: "lokale Änderungen" }),
        "changed-on-both-sides": t({ en: "changed locally and on the server", de: "lokal und auf dem Server geändert" }),
        "deleted-on-server": t({ en: "local changes, note deleted on the server", de: "lokale Änderungen, Notiz auf dem Server gelöscht" }),
        "path-occupied": t({ en: "another local file is in the way", de: "eine andere lokale Datei ist im Weg" }),
      }[kept.reason];
      ctx.error(`${t({ en: "Kept", de: "Behalten" })} ${kept.path}: ${reason}`);
    }
  };

  const refreshMirror = async (
    ctx: CloudCliContext,
    mirror: { root: string; manifest: Manifest },
    writtenNoteId?: string,
  ): Promise<{ manifest: Manifest; report: SyncReport }> => {
    let manifest = mirror.manifest;
    if (writtenNoteId) {
      // The note now holds what was just uploaded; drop the stale record so its file is rewritten from the server copy.
      manifest = { ...manifest, notes: manifest.notes.filter((note) => note.id !== writtenNoteId) };
      const previous = mirror.manifest.notes.find((note) => note.id === writtenNoteId);
      if (previous) await unlink(join(mirror.root, previous.path)).catch(() => undefined);
    }
    const synced = await syncMirror(ctx, { root: mirror.root, manifest, force: false });
    reportSync(ctx, synced.report);
    return synced;
  };

  const mirrorPathOf = (manifest: Manifest, noteId: string): string | undefined => manifest.notes.find((note) => note.id === noteId)?.path;

  // ==========================
  // Commands
  // ==========================

  const pageFlags = {
    page: flag.int({ min: 1, description: t({ en: "Page number", de: "Seitennummer" }) }),
    perPage: flag.int({ name: "per-page", min: 1, max: 100, description: t({ en: "Items per page", de: "Einträge pro Seite" }) }),
  };
  const noteArg = {
    note: arg.required({
      valueLabel: "note",
      description: t({
        en: "Note ID, <notebook>:<path>, or a file in a pulled mirror",
        de: "Notiz-ID, <notizbuch>:<pfad> oder eine Datei in einem gepullten Spiegel",
      }),
    }),
  };
  const notebookArg = {
    notebook: arg.required({
      valueLabel: "notebook",
      description: t({
        en: "Notebook ID or exact name, or a pulled mirror folder",
        de: "Notizbuch-ID oder exakter Name oder ein gepullter Spiegelordner",
      }),
    }),
  };
  const inputFlags = {
    from: flag.string({
      valueLabel: "file|-",
      description: t({ en: "Read Markdown from a file, or - for stdin", de: "Markdown aus einer Datei lesen, - für stdin" }),
    }),
    content: flag.string({ description: t({ en: "Markdown given inline", de: "Markdown direkt angeben" }) }),
  };
  const withQuery = (path: string, query: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") params.set(key, String(value));
    const rendered = params.toString();
    return rendered ? `${path}?${rendered}` : path;
  };

  const buildTree = (outline: OutlineEntry[], rootId: string | null): TreeNode[] => {
    const byParent = new Map<string | null, OutlineEntry[]>();
    for (const entry of outline) byParent.set(entry.parentId, [...(byParent.get(entry.parentId) ?? []), entry]);
    const build = (parentId: string | null, depth: number): TreeNode[] =>
      depth > 64
        ? []
        : (byParent.get(parentId) ?? [])
            .sort((a, b) => a.title.toLocaleLowerCase().localeCompare(b.title.toLocaleLowerCase()) || a.id.localeCompare(b.id))
            .map((entry) => ({
              id: entry.id,
              title: entry.title,
              hasChildren: entry.hasChildren,
              updatedAt: entry.updatedAt,
              children: build(entry.id, depth + 1),
            }));
    return build(rootId, 0);
  };

  const buildEditOperation = async (flags: {
    from?: string;
    content?: string;
    replaceLines?: string;
    deleteLines?: string;
    insertBeforeLine?: string;
    insertAfterLine?: string;
    replaceBlock?: string;
    appendBlock?: string;
    prependBlock?: string;
    append: boolean;
    prepend: boolean;
    type?: string;
    index?: number;
    includeHandle: boolean;
  }): Promise<NoteEditOperation> => {
    const chosen = [
      flags.replaceLines,
      flags.deleteLines,
      flags.insertBeforeLine,
      flags.insertAfterLine,
      flags.replaceBlock,
      flags.appendBlock,
      flags.prependBlock,
      flags.append || undefined,
      flags.prepend || undefined,
    ].filter((value) => value !== undefined);
    if (chosen.length !== 1)
      throw new Error(
        t({
          en: "Pass exactly one edit operation per invocation. Use `write` to replace the whole note.",
          de: "Übergib genau eine Bearbeitung pro Aufruf. Verwende `write`, um die ganze Notiz zu ersetzen.",
        }),
      );
    const content = () => requireContent(flags.from, flags.content);
    const block = {
      ...(flags.type ? { type: flags.type as NamedBlockType } : {}),
      ...(flags.index !== undefined ? { index: flags.index } : {}),
    };
    if (flags.replaceLines) return { kind: "replace-lines", ...parseLineRange(flags.replaceLines), content: await content() };
    if (flags.deleteLines) return { kind: "delete-lines", ...parseLineRange(flags.deleteLines) };
    if (flags.insertBeforeLine)
      return { kind: "insert-before-line", line: parseLineValue(flags.insertBeforeLine), content: await content() };
    if (flags.insertAfterLine) return { kind: "insert-after-line", line: parseLineValue(flags.insertAfterLine), content: await content() };
    if (flags.replaceBlock)
      return { kind: "replace-block", name: flags.replaceBlock, ...block, includeHandle: flags.includeHandle, content: await content() };
    if (flags.appendBlock) return { kind: "append-block", name: flags.appendBlock, ...block, content: await content() };
    if (flags.prependBlock) return { kind: "prepend-block", name: flags.prependBlock, ...block, content: await content() };
    if (flags.append) return { kind: "append", content: await content() };
    return { kind: "prepend", content: await content() };
  };

  /** Where `write` puts content: an existing note, or a new note below a parent. */
  type WriteTarget =
    | { kind: "existing"; target: NoteTarget }
    | {
        kind: "new";
        notebookId: string;
        parentId: string | null;
        parentPath: string;
        name: string;
        mirror?: Mirror;
      };

  const resolveWriteTarget = async (ctx: CloudCliContext, raw: string): Promise<WriteTarget> => {
    const split = !looksLocal(raw) && !NOTE_ID.test(raw) ? splitNotebookPath(raw) : null;
    if (split) {
      const notebook = await getNotebook(ctx, split.notebook);
      const segments = split.path
        .split("/")
        .map((segment) => segment.trim())
        .filter(Boolean);
      if (segments.length === 0)
        throw new Error(
          t({ en: `"${raw}" is the notebook root, not a note.`, de: `„${raw}“ ist die oberste Ebene des Notizbuchs, keine Notiz.` }),
        );
      try {
        const note = await resolvePath(ctx, notebook.id, split.path);
        return { kind: "existing", target: { notebookId: notebook.id, noteId: note.id, note } };
      } catch (error) {
        if (!isHttpStatus(error, 404)) throw error;
      }
      return { kind: "new", notebookId: notebook.id, parentId: null, parentPath: segments.slice(0, -1).join("/"), name: segments.at(-1)! };
    }
    if (!looksLocal(raw) && NOTE_ID.test(raw)) return { kind: "existing", target: await resolveNote(ctx, raw) };

    const mirror = await requireMirror(ctx, raw);
    const entry = findManifestNote(mirror.manifest, mirror.relPath);
    if (entry)
      return {
        kind: "existing",
        target: {
          notebookId: mirror.manifest.notebook.id,
          noteId: entry.id,
          mirror: { root: mirror.root, manifest: mirror.manifest, entry },
        },
      };
    if (!mirror.relPath.endsWith(".md"))
      throw new Error(
        t({ en: `Mirror notes are .md files: ${mirror.relPath || "."}`, de: `Spiegel-Notizen sind .md-Dateien: ${mirror.relPath || "."}` }),
      );
    // `x/index.md` is the own content of the folder note `x`.
    const notePath =
      mirror.relPath.endsWith("/index.md") || mirror.relPath === "index.md" ? dirname(mirror.relPath) : mirror.relPath.slice(0, -3);
    if (notePath === ".")
      throw new Error(t({ en: "The mirror root has no index.md note.", de: "Die oberste Spiegel-Ebene hat keine index.md-Notiz." }));
    const segments = notePath.split("/");
    let parentId: string | null = null;
    let known = 0;
    for (let depth = segments.length - 1; depth > 0; depth -= 1) {
      const folder = findManifestFolder(mirror.manifest, segments.slice(0, depth).join("/"));
      if (folder) {
        parentId = folder.id;
        known = depth;
        break;
      }
    }
    return {
      kind: "new",
      notebookId: mirror.manifest.notebook.id,
      parentId,
      parentPath: segments.slice(known, -1).join("/"),
      name: segments.at(-1)!,
      mirror,
    };
  };

  const pullNotebook = async (ctx: CloudCliContext, notebookRaw: string | undefined, dirRaw: string, force: boolean) => {
    const root = resolve(expandHome(dirRaw));
    const existing = await readManifest(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    let manifest: Manifest;
    if (existing) {
      assertMirrorServer(existing, ctx.options.server);
      if (notebookRaw) {
        const notebook = await getNotebook(ctx, notebookRaw);
        if (notebook.id !== existing.notebook.id)
          throw new Error(
            t({
              en: `${root} mirrors ${existing.notebook.name} (${existing.notebook.id}), not ${notebook.name} (${notebook.id}).`,
              de: `${root} spiegelt ${existing.notebook.name} (${existing.notebook.id}), nicht ${notebook.name} (${notebook.id}).`,
            }),
          );
      }
      manifest = existing;
    } else {
      if (!notebookRaw)
        throw new Error(
          t({
            en: `${root} is not a notebook mirror. Pass the notebook too.`,
            de: `${root} ist kein Notizbuch-Spiegel. Gib auch das Notizbuch an.`,
          }),
        );
      const entries = await Array.fromAsync(new Bun.Glob("*").scan({ cwd: root, dot: true, onlyFiles: false })).catch(() => [] as string[]);
      if (entries.length > 0)
        throw new Error(
          t({
            en: `${root} is not empty and has no ${MANIFEST_FILE}. Pull into a new or empty folder.`,
            de: `${root} ist nicht leer und hat keine ${MANIFEST_FILE}. Pulle in einen neuen oder leeren Ordner.`,
          }),
        );
      const notebook = await getNotebook(ctx, notebookRaw);
      manifest = newManifest(ctx.options.server, { id: notebook.id, name: notebook.name });
      await mkdir(root, { recursive: true });
      await writeManifest(root, manifest);
    }
    const synced = await syncMirror(ctx, { root, manifest, force });
    const result = { root, notebook: synced.manifest.notebook, notes: synced.manifest.notes.length, ...synced.report };
    if (!printStructured(ctx, result)) {
      reportSync(ctx, synced.report);
      ctx.print(
        t({
          en: `Pulled ${synced.manifest.notebook.name} into ${root}: ${synced.report.written.length} written, ${synced.report.removed.length} removed, ${synced.report.attachments.downloaded} attachments downloaded, ${synced.report.kept.length} kept.`,
          de: `${synced.manifest.notebook.name} nach ${root} gepullt: ${synced.report.written.length} geschrieben, ${synced.report.removed.length} entfernt, ${synced.report.attachments.downloaded} Anhänge geladen, ${synced.report.kept.length} behalten.`,
        }),
      );
    }
    if (synced.report.kept.length > 0) {
      ctx.error(
        t({
          en: "Local changes were not overwritten. Write them back with `cld notebooks write <file>`, or discard them with `pull --force`.",
          de: "Lokale Änderungen wurden nicht überschrieben. Schreibe sie mit `cld notebooks write <datei>` zurück oder verwirf sie mit `pull --force`.",
        }),
      );
      return 1;
    }
    return 0;
  };

  const notebookAccessCommands = createAccessCommands({
    resourceLabel: "notebook",
    resourceArgLabel: "notebook",
    resourceArgDescription: "Notebook ID or exact name.",
    resolveResource: async (ctx, args) => {
      if (!args[0]) throw new Error("Missing notebook.");
      const notebook = await resolveNotebookRef(ctx, args[0]);
      return { ...notebook, label: `${notebook.name} (${notebook.id})` };
    },
    list: async (ctx, notebook) => ctx.readJson<AccessEntry[]>(await ctx.fetch(api(notebook.id, "/access"))),
    grant: async (ctx, notebook, principal: Principal, permission: PermissionLevel) =>
      ctx.readJson<AccessEntry>(
        await ctx.fetch(api(notebook.id, "/access"), {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ principal, permission }),
        }),
      ),
    update: async (ctx, notebook, accessId, permission) => {
      await ctx.readJson<MessageResponse>(
        await ctx.fetch(api(notebook.id, `/access/${encodeURIComponent(accessId)}`), {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ permission }),
        }),
      );
    },
    revoke: async (ctx, notebook, accessId) => {
      await ctx.readJson<MessageResponse>(
        await ctx.fetch(api(notebook.id, `/access/${encodeURIComponent(accessId)}`), { method: "DELETE" }),
      );
    },
    examples: {
      list: ['cld notebooks access list "Product Notes"', "cld notebooks access list nhTHpc --include-service-accounts"],
      grant: [
        'cld notebooks access grant "Product Notes" --user valentin.kolb --permission read',
        'cld notebooks access grant "Product Notes" --group "Editors" --permission write',
      ],
      set: ['cld notebooks access set "Product Notes" --user valentin.kolb --permission admin'],
      revoke: ['cld notebooks access revoke "Product Notes" --user valentin.kolb --yes'],
      searchPrincipals: ["cld notebooks access search-principals val --kind user,group"],
    },
  });

  return defineCliCommands({
    name: "notebooks",
    summary: t({
      en: "Read and write notes by ID or path, and mirror notebooks as Markdown folders.",
      de: "Notizen per ID oder Pfad lesen und schreiben und Notizbücher als Markdown-Ordner spiegeln.",
    }),
    groupSummaries: {
      access: t({ en: "Manage direct access to notebooks", de: "Direkten Zugriff auf Notizbücher verwalten" }),
      comments: t({ en: "Discuss a note", de: "Eine Notiz diskutieren" }),
      versions: t({ en: "Inspect and restore note versions", de: "Notizversionen prüfen und wiederherstellen" }),
      attachments: t({ en: "List, download, and delete notebook files", de: "Notizbuch-Dateien auflisten, laden und löschen" }),
      favorites: t({ en: "Keep your favorite notes", de: "Eigene Lieblingsnotizen pflegen" }),
      "api-keys": t({ en: "Manage notebook-bound API keys", de: "Notizbuch-gebundene API-Schlüssel verwalten" }),
      snapshots: t({ en: "Configure and run S3 snapshots", de: "S3-Snapshots konfigurieren und ausführen" }),
    },
    commands: [
      // ---------- Browse ----------
      command("ls", {
        summary: t({
          en: "List notebooks, or the child notes of a notebook or note",
          de: "Notizbücher oder die Unternotizen eines Notizbuchs oder einer Notiz auflisten",
        }),
        args: {
          scope: arg.optional({
            valueLabel: "notebook[:path]",
            description: t({
              en: "Notebook, <notebook>:<path>, or a mirror folder",
              de: "Notizbuch, <notizbuch>:<pfad> oder ein Spiegelordner",
            }),
          }),
        },
        flags: {
          q: flag.string({ description: t({ en: "Filter notebooks by name", de: "Notizbücher nach Namen filtern" }) }),
          ...pageFlags,
        },
        examples: ["cld notebooks ls", 'cld notebooks ls "Kolb Antik Doku":betrieb', "cld notebooks ls ~/docs-mirror/betrieb"],
        async run({ ctx, args, flags }) {
          if (!args.scope) {
            const payload = await ctx.readJson<Page<Notebook>>(
              await ctx.fetch(withQuery("/api/notebooks", { q: flags.q, page: flags.page, per_page: flags.perPage })),
            );
            printRows(ctx, payload, payload.data, [
              { key: "id", label: "ID" },
              { key: "name", label: t({ en: "NAME", de: "NAME" }) },
              { key: "updatedAt", label: t({ en: "UPDATED", de: "GEÄNDERT" }) },
            ]);
            return;
          }
          const scope = await resolveScope(ctx, args.scope);
          const outline = await fetchOutline(ctx, scope.notebook.id);
          const data = buildTree(outline, scope.noteId).map(({ children: _children, ...entry }) => entry);
          const payload = { notebook: scope.notebook, parentId: scope.noteId, data };
          printRows(
            ctx,
            payload,
            data.map((entry) => ({ ...entry, title: entry.hasChildren ? `${entry.title}/` : entry.title })),
            [
              { key: "id", label: "ID" },
              { key: "title", label: t({ en: "TITLE", de: "TITEL" }) },
              { key: "updatedAt", label: t({ en: "UPDATED", de: "GEÄNDERT" }) },
            ],
          );
        },
      }),
      command("tree", {
        summary: t({
          en: "Show the note tree of a notebook or below a note",
          de: "Den Notizbaum eines Notizbuchs oder unter einer Notiz zeigen",
        }),
        args: {
          scope: arg.required({
            valueLabel: "notebook[:path]",
            description: t({
              en: "Notebook, <notebook>:<path>, or a mirror folder",
              de: "Notizbuch, <notizbuch>:<pfad> oder ein Spiegelordner",
            }),
          }),
        },
        async run({ ctx, args }) {
          const scope = await resolveScope(ctx, args.scope);
          const data = buildTree(await fetchOutline(ctx, scope.notebook.id), scope.noteId);
          if (printStructured(ctx, { notebook: scope.notebook, parentId: scope.noteId, data })) return;
          const print = (nodes: TreeNode[], depth: number) => {
            for (const node of nodes) {
              ctx.print(`${"  ".repeat(depth)}- ${node.title} (${node.id})`);
              print(node.children, depth + 1);
            }
          };
          print(data, 0);
        },
      }),
      command("cat", {
        summary: t({
          en: "Print the live content of a note, including open editors",
          de: "Den aktuellen Inhalt einer Notiz ausgeben, inklusive offener Editoren",
        }),
        args: noteArg,
        flags: {
          numbered: flag.boolean({ description: t({ en: "Prefix 1-based line numbers", de: "1-basierte Zeilennummern voranstellen" }) }),
          blocks: flag.boolean({
            description: t({
              en: "Print the named block summary instead of the content",
              de: "Statt des Inhalts die benannten Blöcke ausgeben",
            }),
          }),
          block: flag.string({ description: t({ en: "Print one named block body", de: "Den Inhalt eines benannten Blocks ausgeben" }) }),
          type: flag.string({ description: t({ en: "Restrict --block to a block type", de: "--block auf einen Blocktyp einschränken" }) }),
          index: flag.int({
            min: 0,
            description: t({ en: "Select a duplicate --block by 0-based index", de: "Doppelten --block über 0-basierten Index wählen" }),
          }),
        },
        examples: [
          "cld notebooks cat ns98Kq",
          "cld notebooks cat kolb-docs:betrieb/backup --json",
          "cld notebooks cat ~/docs-mirror/betrieb/backup.md --block status",
        ],
        async run({ ctx, args, flags }) {
          const target = await resolveNote(ctx, args.note);
          const note = await ctx.readJson<Note>(await ctx.fetch(noteApi(target, "/content")));
          const content = note.contentMd ?? "";
          if (flags.block) {
            const name = flags.block.replace(/^@/, "");
            const matches = findNamedBlocks(content, name, flags.type as NamedBlockType | undefined);
            if (matches.length === 0)
              throw new Error(t({ en: `Named block @${name} was not found.`, de: `Benannter Block @${name} wurde nicht gefunden.` }));
            if (flags.index === undefined && matches.length > 1)
              throw new Error(
                t({
                  en: `@${name} is ambiguous (${matches.length} matches). Pass --index.`,
                  de: `@${name} ist mehrdeutig (${matches.length} Treffer). Übergib --index.`,
                }),
              );
            const block = matches[flags.index ?? 0];
            if (!block)
              throw new Error(t({ en: `@${name} has no index ${flags.index}.`, de: `@${name} hat keinen Index ${flags.index}.` }));
            const body = namedBlockBody(content, block);
            const result = {
              note: { id: note.id, notebookId: note.notebookId, title: note.title, updatedAt: note.updatedAt },
              block: {
                name: block.name,
                type: block.type,
                index: flags.index ?? 0,
                startLine: block.startLine + 1,
                endLine: block.endLine + 1,
                hash: noteContentHash(body),
                content: body,
              },
            };
            if (!printStructured(ctx, result)) ctx.print(body);
            return;
          }
          const blocks = summarizeNoteEditBlocks(content);
          const { contentMd: _contentMd, ...meta } = note;
          const result = { note: meta, content, contentHash: noteContentHash(content), lineCount: content.split("\n").length, blocks };
          if (printStructured(ctx, result)) return;
          if (flags.blocks) {
            for (const item of blocks) ctx.print(`@${item.name} ${item.type} ${item.startLine}:${item.endLine} ${item.hash}`);
            return;
          }
          await ctx.write(flags.numbered ? `${formatNumberedLines(content)}\n` : content);
        },
      }),
      command("stat", {
        summary: t({
          en: "Show note or notebook metadata; <notebook>: addresses the notebook",
          de: "Metadaten einer Notiz oder eines Notizbuchs zeigen; <notizbuch>: meint das Notizbuch",
        }),
        args: noteArg,
        async run({ ctx, args }) {
          if (!looksLocal(args.note) && /^[^:]+:\/?$/.test(args.note)) {
            const notebook = await getNotebook(ctx, args.note.slice(0, args.note.indexOf(":")));
            if (!printStructured(ctx, notebook)) {
              ctx.print(`${notebook.name} (${notebook.id})`);
              if (notebook.description) ctx.print(notebook.description);
              ctx.print(`${t({ en: "updated", de: "geändert" })}: ${notebook.updatedAt}`);
            }
            return;
          }
          const target = await resolveNote(ctx, args.note);
          const { contentMd: _contentMd, ...note } = await loadNote(ctx, target);
          const mirrorPath = target.mirror?.entry.path;
          if (printStructured(ctx, { ...note, ...(mirrorPath ? { mirrorPath } : {}) })) return;
          ctx.print(`${note.title} (${note.id})`);
          ctx.print(`${t({ en: "notebook", de: "Notizbuch" })}: ${note.notebookId}`);
          ctx.print(`${t({ en: "updated", de: "geändert" })}: ${note.updatedAt}`);
          if (note.lockedAt) ctx.print(`${t({ en: "locked", de: "gesperrt" })}: ${note.lockedAt}`);
        },
      }),
      command("search", {
        summary: t({ en: "Search notes by text, tags, and time", de: "Notizen nach Text, Tags und Zeit durchsuchen" }),
        args: { query: arg.rest({ valueLabel: "query", description: t({ en: "Search text", de: "Suchtext" }) }) },
        flags: {
          notebook: flag.string({ description: t({ en: "Limit to one notebook", de: "Auf ein Notizbuch beschränken" }) }),
          tags: flag.string({
            aliases: ["tag"],
            description: t({ en: "Comma-separated tags; all must match", de: "Kommagetrennte Tags; alle müssen passen" }),
          }),
          createdAfter: flag.string({
            name: "created-after",
            description: t({ en: "Created at or after this ISO time", de: "Erstellt ab diesem ISO-Zeitpunkt" }),
          }),
          createdBefore: flag.string({
            name: "created-before",
            description: t({ en: "Created at or before this ISO time", de: "Erstellt bis zu diesem ISO-Zeitpunkt" }),
          }),
          updatedAfter: flag.string({
            name: "updated-after",
            description: t({ en: "Updated at or after this ISO time", de: "Geändert ab diesem ISO-Zeitpunkt" }),
          }),
          updatedBefore: flag.string({
            name: "updated-before",
            description: t({ en: "Updated at or before this ISO time", de: "Geändert bis zu diesem ISO-Zeitpunkt" }),
          }),
          ...pageFlags,
        },
        examples: ['cld notebooks search "backup restore" --json', "cld notebooks search --notebook kolb-docs --tags runbook"],
        async run({ ctx, args, flags }) {
          const notebook = flags.notebook ? await resolveNotebookRef(ctx, flags.notebook) : null;
          const payload = await ctx.readJson<Page<{ note: Note; notebook: { id: string; name: string }; snippet: string | null }>>(
            await ctx.fetch(
              withQuery("/api/notebooks/search", {
                q: args.query.join(" ").trim(),
                notebook: notebook?.id,
                tags: flags.tags?.replace(/#/g, ""),
                created_after: flags.createdAfter,
                created_before: flags.createdBefore,
                updated_after: flags.updatedAfter,
                updated_before: flags.updatedBefore,
                page: flags.page,
                per_page: flags.perPage,
              }),
            ),
          );
          printRows(
            ctx,
            payload,
            payload.data.map((hit) => ({
              id: hit.note.id,
              title: hit.note.title,
              notebook: hit.notebook.name,
              snippet: (hit.snippet ?? "")
                .replace(/[\uE000\uE001]/g, "")
                .replace(/\s+/g, " ")
                .slice(0, 120),
            })),
            [
              { key: "id", label: "ID" },
              { key: "title", label: t({ en: "TITLE", de: "TITEL" }) },
              { key: "notebook", label: t({ en: "NOTEBOOK", de: "NOTIZBUCH" }) },
              { key: "snippet", label: t({ en: "MATCH", de: "TREFFER" }) },
            ],
          );
        },
      }),
      command("tags", {
        summary: t({ en: "List tags and how many notes carry them", de: "Tags und ihre Notizanzahl auflisten" }),
        args: notebookArg,
        async run({ ctx, args }) {
          const notebook = await resolveNotebookRef(ctx, args.notebook);
          const payload = await ctx.readJson<{ tag: string; count: number }[]>(await ctx.fetch(api(notebook.id, "/tags")));
          printRows(ctx, payload, payload, [
            { key: "tag", label: "TAG" },
            { key: "count", label: t({ en: "NOTES", de: "NOTIZEN" }) },
          ]);
        },
      }),
      command("backlinks", {
        summary: t({ en: "List notes that link to a note", de: "Notizen auflisten, die auf eine Notiz verlinken" }),
        args: noteArg,
        async run({ ctx, args }) {
          const target = await resolveNote(ctx, args.note);
          const payload = await ctx.readJson<{ data: Array<Record<string, unknown>> }>(await ctx.fetch(noteApi(target, "/backlinks")));
          printRows(ctx, payload, payload.data, [
            { key: "noteId", label: "ID" },
            { key: "title", label: t({ en: "TITLE", de: "TITEL" }) },
            { key: "notebookName", label: t({ en: "NOTEBOOK", de: "NOTIZBUCH" }) },
          ]);
        },
      }),
      command("graph", {
        summary: t({ en: "Print the note link graph as JSON", de: "Den Linkgraphen der Notizen als JSON ausgeben" }),
        args: notebookArg,
        async run({ ctx, args }) {
          const notebook = await resolveNotebookRef(ctx, args.notebook);
          ctx.json(await ctx.readJson<unknown>(await ctx.fetch(api(notebook.id, "/graph"))));
        },
      }),

      // ---------- Write ----------
      command("write", {
        summary: t({
          en: "Replace a note's content, or create the note if it is missing",
          de: "Den Inhalt einer Notiz ersetzen oder die Notiz anlegen, falls sie fehlt",
        }),
        description: t({
          en: "The title is the first # heading; without one, the file name (new notes) or the current title is added as heading. A mirror file is checked against the pulled content hash; elsewhere pass --if-content-hash. Without --from, a mirror file writes itself.",
          de: "Der Titel ist die erste #-Überschrift; fehlt sie, wird der Dateiname (neue Notizen) oder der bisherige Titel als Überschrift ergänzt. Eine Spiegeldatei wird gegen den gepullten Inhalts-Hash geprüft; sonst übergib --if-content-hash. Ohne --from schreibt sich eine Spiegeldatei selbst.",
        }),
        args: noteArg,
        flags: {
          ...inputFlags,
          parents: flag.boolean({
            description: t({
              en: "Create missing parent notes, like mkdir -p",
              de: "Fehlende übergeordnete Notizen anlegen, wie mkdir -p",
            }),
          }),
          ifContentHash: flag.string({
            name: "if-content-hash",
            description: t({ en: "Reject the write if the content changed", de: "Schreiben ablehnen, wenn sich der Inhalt geändert hat" }),
          }),
        },
        examples: [
          "cld notebooks write kolb-docs:betrieb/backup --from backup.md --parents",
          "cld notebooks write ~/docs-mirror/betrieb/backup.md",
          "printf '# Status\\n\\nAll good\\n' | cld notebooks write ns98Kq --from -",
        ],
        async run({ ctx, args, flags }) {
          const destination = await resolveWriteTarget(ctx, args.note);
          const ownFile = destination.kind === "existing" ? destination.target.mirror : destination.mirror;
          const ownPath = destination.kind === "existing" ? destination.target.mirror?.entry.path : destination.mirror?.relPath;
          let source = await readContentSource(flags.from, flags.content);
          const fromOwnFile = source === undefined;
          if (source === undefined) {
            if (!ownFile || !ownPath)
              throw new Error(
                t({
                  en: "Missing content. Pass --from <file|-> or --content <text>.",
                  de: "Inhalt fehlt. Übergib --from <datei|-> oder --content <text>.",
                }),
              );
            source = await readFile(join(ownFile.root, ownPath), "utf8");
          }
          let content = stripFrontMatter(source);
          if (ownPath) content = restoreAttachmentLinks(content, depthOf(ownPath));

          if (destination.kind === "existing") {
            const { target } = destination;
            if (!hasNoteTitleHeading(content)) content = `# ${(await loadNote(ctx, target)).title}\n\n${content}`;
            const response = await ctx
              .readJson<NoteEditResponse>(
                await ctx.fetch(noteApi(target, "/content"), {
                  method: "PATCH",
                  headers: JSON_HEADERS,
                  body: JSON.stringify({
                    operations: [{ kind: "set-content", content }],
                    ifContentHash: flags.ifContentHash ?? target.mirror?.entry.contentHash,
                  }),
                }),
              )
              .catch(rethrowConflict);
            const synced = target.mirror ? await refreshMirror(ctx, target.mirror, response.note.id) : null;
            const mirrorPath = synced ? mirrorPathOf(synced.manifest, response.note.id) : undefined;
            const result = {
              action: response.changed ? "updated" : "unchanged",
              note: response.note,
              contentHash: response.afterHash,
              ...(mirrorPath ? { mirrorPath } : {}),
            };
            if (!printStructured(ctx, result))
              ctx.print(
                `${response.changed ? t({ en: "Updated", de: "Aktualisiert" }) : t({ en: "Unchanged", de: "Unverändert" })} ${mirrorPath ?? response.note.title} (${response.note.id})`,
              );
            return;
          }

          if (!hasNoteTitleHeading(content)) content = `# ${destination.name}\n\n${content}`;
          const note = await ctx
            .readJson<Note>(
              await ctx.fetch(api(destination.notebookId, "/notes"), {
                method: "POST",
                headers: JSON_HEADERS,
                body: JSON.stringify({
                  ...(destination.parentId ? { parentId: destination.parentId } : {}),
                  parentPath: destination.parentPath,
                  createParents: flags.parents,
                  contentMd: content,
                }),
              }),
            )
            .catch((error: unknown) => {
              if (isHttpStatus(error, 404) && !flags.parents)
                throw new Error(
                  `${(error as Error).message} ${t({ en: "Pass --parents to create missing parent notes.", de: "Übergib --parents, um fehlende übergeordnete Notizen anzulegen." })}`,
                );
              throw error;
            });
          let mirrorPath: string | undefined;
          if (destination.mirror) {
            // The uploaded file is now a note; the mirror rewrites it under its canonical name.
            if (fromOwnFile) await unlink(join(destination.mirror.root, destination.mirror.relPath));
            mirrorPath = mirrorPathOf((await refreshMirror(ctx, destination.mirror)).manifest, note.id);
          }
          const result = {
            action: "created",
            note,
            contentHash: noteContentHash(note.contentMd ?? content),
            ...(mirrorPath ? { mirrorPath } : {}),
          };
          if (!printStructured(ctx, result)) ctx.print(`${t({ en: "Created", de: "Angelegt" })} ${mirrorPath ?? note.title} (${note.id})`);
        },
      }),
      command("edit", {
        summary: t({
          en: "Apply one precise edit: lines, named blocks, append, or prepend",
          de: "Eine präzise Bearbeitung anwenden: Zeilen, benannte Blöcke, anhängen oder voranstellen",
        }),
        description: t({
          en: "Line numbers are 1-based and inclusive. Through a mirror file, the pulled content hash is the default precondition and local unsaved changes are refused.",
          de: "Zeilennummern sind 1-basiert und inklusiv. Über eine Spiegeldatei ist der gepullte Inhalts-Hash die Standard-Vorbedingung; ungesicherte lokale Änderungen werden abgelehnt.",
        }),
        args: noteArg,
        flags: {
          ...inputFlags,
          replaceLines: flag.string({
            name: "replace-lines",
            valueLabel: "start:end",
            description: t({ en: "Replace a line range", de: "Einen Zeilenbereich ersetzen" }),
          }),
          deleteLines: flag.string({
            name: "delete-lines",
            valueLabel: "start:end",
            description: t({ en: "Delete a line range", de: "Einen Zeilenbereich löschen" }),
          }),
          insertBeforeLine: flag.string({
            name: "insert-before-line",
            valueLabel: "line",
            description: t({ en: "Insert before a line", de: "Vor einer Zeile einfügen" }),
          }),
          insertAfterLine: flag.string({
            name: "insert-after-line",
            valueLabel: "line",
            description: t({ en: "Insert after a line", de: "Nach einer Zeile einfügen" }),
          }),
          replaceBlock: flag.string({
            name: "replace-block",
            valueLabel: "name",
            description: t({ en: "Replace a named block", de: "Einen benannten Block ersetzen" }),
          }),
          appendBlock: flag.string({
            name: "append-block",
            valueLabel: "name",
            description: t({ en: "Append to a named block", de: "An einen benannten Block anhängen" }),
          }),
          prependBlock: flag.string({
            name: "prepend-block",
            valueLabel: "name",
            description: t({ en: "Prepend to a named block", de: "Einem benannten Block voranstellen" }),
          }),
          append: flag.boolean({ description: t({ en: "Append to the note", de: "An die Notiz anhängen" }) }),
          prepend: flag.boolean({ description: t({ en: "Prepend to the note", de: "Der Notiz voranstellen" }) }),
          type: flag.string({ description: t({ en: "Restrict the named block type", de: "Den Typ des benannten Blocks einschränken" }) }),
          index: flag.int({
            min: 0,
            description: t({
              en: "Select a duplicate named block by 0-based index",
              de: "Doppelten benannten Block über 0-basierten Index wählen",
            }),
          }),
          includeHandle: flag.boolean({
            name: "include-handle",
            description: t({ en: "Replace the @name handle too", de: "Auch den @name-Anker ersetzen" }),
          }),
          ifUpdatedAt: flag.string({
            name: "if-updated-at",
            description: t({ en: "Reject if updatedAt changed", de: "Ablehnen, wenn sich updatedAt geändert hat" }),
          }),
          ifContentHash: flag.string({
            name: "if-content-hash",
            description: t({ en: "Reject if the content changed", de: "Ablehnen, wenn sich der Inhalt geändert hat" }),
          }),
          ifBlockHash: flag.string({
            name: "if-block-hash",
            description: t({ en: "Reject if the selected block changed", de: "Ablehnen, wenn sich der gewählte Block geändert hat" }),
          }),
          dryRun: flag.boolean({
            name: "dry-run",
            description: t({ en: "Compute the result without saving", de: "Ergebnis berechnen, ohne zu speichern" }),
          }),
        },
        examples: [
          "cld notebooks edit kolb-docs:betrieb/backup --append --content '- [ ] Restore testen'",
          "cld notebooks edit ~/docs-mirror/betrieb/backup.md --replace-lines 3:4 --from fix.md",
        ],
        async run({ ctx, args, flags }) {
          const target = await resolveNote(ctx, args.note);
          const operation = await buildEditOperation(flags);
          if (target.mirror) {
            const { entry, root } = target.mirror;
            const text = await readFile(join(root, entry.path), "utf8").catch(() => null);
            if (text !== null && noteContentHash(mirrorFileContent(text, entry.path)) !== entry.contentHash)
              throw new Error(
                t({
                  en: `${entry.path} has local changes. Write the file back first, or pull --force to discard them.`,
                  de: `${entry.path} hat lokale Änderungen. Schreibe die Datei zuerst zurück oder verwirf sie mit pull --force.`,
                }),
              );
          }
          const request = {
            operations: [operation],
            ifUpdatedAt: flags.ifUpdatedAt,
            ifContentHash: flags.ifContentHash ?? target.mirror?.entry.contentHash,
            ifBlockHash: flags.ifBlockHash,
          };
          if (flags.dryRun) {
            const note = await ctx.readJson<Note>(await ctx.fetch(noteApi(target, "/content")));
            if (request.ifUpdatedAt !== undefined && request.ifUpdatedAt !== note.updatedAt)
              rethrowConflict(new Error("409 updatedAt changed"));
            let edit: ReturnType<typeof applyNoteEdits>;
            try {
              edit = applyNoteEdits(note.contentMd ?? "", request.operations, {
                ifContentHash: request.ifContentHash,
                ifBlockHash: request.ifBlockHash,
              });
            } catch (error) {
              if (error instanceof Error && "status" in error && error.status === 409) rethrowConflict(new Error(`409 ${error.message}`));
              throw error;
            }
            const { contentMd: _contentMd, ...meta } = note;
            if (!printStructured(ctx, { note: meta, ...edit })) ctx.print(edit.content);
            return;
          }
          const response = await ctx
            .readJson<NoteEditResponse>(
              await ctx.fetch(noteApi(target, "/content"), { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(request) }),
            )
            .catch(rethrowConflict);
          const synced = target.mirror ? await refreshMirror(ctx, target.mirror, response.note.id) : null;
          const mirrorPath = synced ? mirrorPathOf(synced.manifest, response.note.id) : undefined;
          if (printStructured(ctx, { ...response, ...(mirrorPath ? { mirrorPath } : {}) })) return;
          ctx.print(
            `${response.changed ? t({ en: "Edited", de: "Bearbeitet" }) : t({ en: "Unchanged", de: "Unverändert" })} ${mirrorPath ?? response.note.title} (${response.note.id})`,
          );
          ctx.print(`${response.beforeHash} -> ${response.afterHash}`);
        },
      }),
      command("preview", {
        summary: t({
          en: "Check query and TOC blocks without saving; diagnostics exit 1",
          de: "Query- und TOC-Blöcke ohne Speichern prüfen; Diagnosen beenden mit 1",
        }),
        args: noteArg,
        flags: inputFlags,
        async run({ ctx, args, flags }) {
          const markdown = await readContentSource(flags.from, flags.content);
          const target = await resolveNote(ctx, args.note);
          const payload = await ctx.readJson<{ blocks: unknown[]; headings: unknown[]; diagnostics: { line: number; message: string }[] }>(
            await ctx.fetch(noteApi(target, "/block-preview"), {
              method: "POST",
              headers: JSON_HEADERS,
              body: JSON.stringify(markdown === undefined ? {} : { markdown: stripFrontMatter(markdown) }),
            }),
          );
          if (!printStructured(ctx, payload)) {
            ctx.print(`${payload.blocks.length} blocks, ${payload.headings.length} headings, ${payload.diagnostics.length} diagnostics.`);
            for (const diagnostic of payload.diagnostics) ctx.print(`Line ${diagnostic.line}: ${diagnostic.message}`);
          }
          return payload.diagnostics.length > 0 ? 1 : 0;
        },
      }),
      command("mv", {
        summary: t({ en: "Move and/or rename a note", de: "Eine Notiz verschieben und/oder umbenennen" }),
        description: t({
          en: "An existing target note becomes the new parent, like `mv file dir/`. Otherwise the last target segment is the new title below its parent. `<notebook>:` moves to the top level.",
          de: "Eine vorhandene Zielnotiz wird die neue übergeordnete Notiz, wie `mv datei ordner/`. Sonst ist das letzte Zielsegment der neue Titel unter dessen übergeordneter Notiz. `<notizbuch>:` verschiebt auf die oberste Ebene.",
        }),
        args: {
          ...noteArg,
          target: arg.required({
            valueLabel: "target",
            description: t({ en: "New parent or new path", de: "Neue übergeordnete Notiz oder neuer Pfad" }),
          }),
        },
        flags: {
          position: flag.int({
            min: 0,
            description: t({ en: "0-based position among the new siblings", de: "0-basierte Position unter den neuen Geschwistern" }),
          }),
        },
        examples: [
          "cld notebooks mv kolb-docs:alt/backup kolb-docs:betrieb",
          'cld notebooks mv ns98Kq "kolb-docs:betrieb/Backup und Restore"',
        ],
        async run({ ctx, args, flags }) {
          const source = await resolveNote(ctx, args.note);
          const note = await loadNote(ctx, source);
          let parentId: string | null;
          let title: string | undefined;
          if (!looksLocal(args.target) && NOTE_ID.test(args.target)) {
            const into = await resolveNote(ctx, args.target);
            if (into.notebookId !== source.notebookId)
              throw new Error(
                t({
                  en: "Moving between notebooks is not supported; use cp and rm.",
                  de: "Verschieben zwischen Notizbüchern geht nicht; verwende cp und rm.",
                }),
              );
            parentId = into.noteId;
          } else if (!looksLocal(args.target) && splitNotebookPath(args.target)) {
            const split = splitNotebookPath(args.target)!;
            const notebook = await getNotebook(ctx, split.notebook);
            if (notebook.id !== source.notebookId)
              throw new Error(
                t({
                  en: "Moving between notebooks is not supported; use cp and rm.",
                  de: "Verschieben zwischen Notizbüchern geht nicht; verwende cp und rm.",
                }),
              );
            const segments = split.path
              .split("/")
              .map((segment) => segment.trim())
              .filter(Boolean);
            const into = segments.length
              ? await resolvePath(ctx, notebook.id, split.path).catch((error: unknown) =>
                  isHttpStatus(error, 404) && !split.path.endsWith("/") ? null : Promise.reject(error),
                )
              : null;
            if (into || segments.length === 0) parentId = into?.id ?? null;
            else {
              parentId = segments.length > 1 ? (await resolvePath(ctx, notebook.id, segments.slice(0, -1).join("/"))).id : null;
              title = segments.at(-1);
            }
          } else {
            const mirror = await requireMirror(ctx, args.target);
            if (mirror.manifest.notebook.id !== source.notebookId)
              throw new Error(
                t({
                  en: "Moving between notebooks is not supported; use cp and rm.",
                  de: "Verschieben zwischen Notizbüchern geht nicht; verwende cp und rm.",
                }),
              );
            const into = mirror.relPath ? findManifestNote(mirror.manifest, mirror.relPath) : null;
            if (into || !mirror.relPath) parentId = into?.id ?? null;
            else {
              const dir = dirname(mirror.relPath);
              const folder = dir === "." ? null : findManifestFolder(mirror.manifest, dir);
              if (dir !== "." && !folder)
                throw new Error(t({ en: `${dir} is not a note folder in the mirror.`, de: `${dir} ist kein Notizordner im Spiegel.` }));
              parentId = folder?.id ?? null;
              title = basename(mirror.relPath).replace(/\.md$/, "");
            }
          }
          if (parentId === note.id)
            throw new Error(
              t({ en: "A note cannot be moved into itself.", de: "Eine Notiz kann nicht in sich selbst verschoben werden." }),
            );

          let current = note;
          if (title !== undefined && noteSlug(title) !== noteSlug(note.title)) {
            const content = (await ctx.readJson<Note>(await ctx.fetch(noteApi(source, "/content")))).contentMd ?? "";
            const lines = content.split("\n");
            const line = firstHeadingLine(lines);
            const operation: NoteEditOperation =
              line >= 0
                ? { kind: "replace-lines", startLine: line + 1, endLine: line + 1, content: `# ${title}` }
                : { kind: "prepend", content: `# ${title}\n\n` };
            current = (
              await ctx
                .readJson<NoteEditResponse>(
                  await ctx.fetch(noteApi(source, "/content"), {
                    method: "PATCH",
                    headers: JSON_HEADERS,
                    body: JSON.stringify({ operations: [operation], ifContentHash: noteContentHash(content) }),
                  }),
                )
                .catch(rethrowConflict)
            ).note;
          }
          if (parentId !== note.parentId || flags.position !== undefined)
            current = await ctx.readJson<Note>(
              await ctx.fetch(noteApi(source, "/move"), {
                method: "POST",
                headers: JSON_HEADERS,
                body: JSON.stringify({ parentId, position: flags.position ?? note.position }),
              }),
            );
          const synced = source.mirror ? await refreshMirror(ctx, source.mirror) : null;
          const mirrorPath = synced ? mirrorPathOf(synced.manifest, current.id) : undefined;
          if (!printStructured(ctx, { note: current, ...(mirrorPath ? { mirrorPath } : {}) }))
            ctx.print(`${t({ en: "Moved", de: "Verschoben" })} ${mirrorPath ?? current.title} (${current.id})`);
        },
      }),
      command("cp", {
        summary: t({ en: "Copy a note into another notebook", de: "Eine Notiz in ein anderes Notizbuch kopieren" }),
        args: {
          ...noteArg,
          target: arg.required({
            valueLabel: "notebook[:parent]",
            description: t({ en: "Target notebook and optional parent path", de: "Zielnotizbuch und optionaler übergeordneter Pfad" }),
          }),
        },
        async run({ ctx, args }) {
          const source = await resolveNote(ctx, args.note);
          const scope = await resolveScope(ctx, args.target);
          const copy = await ctx.readJson<Note>(
            await ctx.fetch(noteApi(source, "/copy"), {
              method: "POST",
              headers: JSON_HEADERS,
              body: JSON.stringify({ targetNotebookId: scope.notebook.id, targetParentId: scope.noteId }),
            }),
          );
          if (!printStructured(ctx, copy))
            ctx.print(`${t({ en: "Copied to", de: "Kopiert nach" })} ${scope.notebook.name}: ${copy.title} (${copy.id})`);
        },
      }),
      command("rm", {
        summary: t({ en: "Delete a note and all of its children", de: "Eine Notiz mit allen Unternotizen löschen" }),
        args: noteArg,
        flags: { yes: confirmFlag(t({ en: "Delete without asking", de: "Ohne Nachfrage löschen" })) },
        async run({ ctx, args, flags }) {
          requireConfirmable(flags.yes);
          const target = await resolveNote(ctx, args.note);
          const note = await loadNote(ctx, target);
          await confirm(
            flags.yes,
            t({
              en: `Delete "${note.title}" (${note.id}) and all of its children?`,
              de: `„${note.title}“ (${note.id}) mit allen Unternotizen löschen?`,
            }),
          );
          const payload = await ctx.readJson<MessageResponse>(await ctx.fetch(noteApi(target), { method: "DELETE" }));
          if (target.mirror) await refreshMirror(ctx, target.mirror);
          if (!printStructured(ctx, { deleted: { id: note.id, title: note.title }, message: payload.message }))
            ctx.print(`${t({ en: "Deleted", de: "Gelöscht" })} ${note.title} (${note.id})`);
        },
      }),
      command("lock", {
        summary: t({ en: "Lock a note permanently", de: "Eine Notiz dauerhaft sperren" }),
        args: noteArg,
        flags: { yes: confirmFlag(t({ en: "Lock without asking", de: "Ohne Nachfrage sperren" })) },
        async run({ ctx, args, flags }) {
          requireConfirmable(flags.yes);
          const target = await resolveNote(ctx, args.note);
          const note = await loadNote(ctx, target);
          await confirm(
            flags.yes,
            t({
              en: `Lock "${note.title}" (${note.id}) permanently? This cannot be undone.`,
              de: `„${note.title}“ (${note.id}) dauerhaft sperren? Das lässt sich nicht rückgängig machen.`,
            }),
          );
          const locked = await ctx.readJson<Note>(await ctx.fetch(noteApi(target, "/lock"), { method: "POST" }));
          if (!printStructured(ctx, locked)) ctx.print(`${t({ en: "Locked", de: "Gesperrt" })} ${locked.title} (${locked.id})`);
        },
      }),
      command("attach", {
        summary: t({
          en: "Upload a file and print a ready-to-paste Markdown link",
          de: "Eine Datei hochladen und einen einfügefertigen Markdown-Link ausgeben",
        }),
        args: {
          note: arg.required({
            valueLabel: "note",
            description: t({ en: "Note address, or <notebook>: for the notebook", de: "Notizadresse oder <notizbuch>: für das Notizbuch" }),
          }),
          file: arg.required({ valueLabel: "file", description: t({ en: "Local file to upload", de: "Hochzuladende lokale Datei" }) }),
        },
        async run({ ctx, args }) {
          const notebookId =
            !looksLocal(args.note) && /^[^:]+:\/?$/.test(args.note)
              ? (await resolveNotebookRef(ctx, args.note)).id
              : (await resolveNote(ctx, args.note)).notebookId;
          const path = expandHome(args.file);
          const form = new FormData();
          form.append("file", Bun.file(path), basename(path));
          const attachment = await ctx.readJson<Attachment>(
            await ctx.fetch(api(notebookId, "/attachments"), { method: "POST", body: form }),
          );
          const label = attachment.filename.replace(/[[\]]/g, "");
          const markdown = `${attachment.kind === "image" ? "!" : ""}[${label}](attach://${attachment.id})`;
          if (!printStructured(ctx, { attachment, markdown })) ctx.print(markdown);
        },
      }),
      command("pull", {
        summary: t({
          en: "Mirror a notebook into a local folder of Markdown files",
          de: "Ein Notizbuch in einen lokalen Ordner mit Markdown-Dateien spiegeln",
        }),
        description: t({
          en: "One-way: only changed notes are downloaded; renamed, moved, and deleted notes follow. Files with local changes are never overwritten; they are listed and pull exits 1. --force discards them. An existing mirror can be pulled with just its folder.",
          de: "Einweg: Nur geänderte Notizen werden geladen; umbenannte, verschobene und gelöschte Notizen folgen. Dateien mit lokalen Änderungen werden nie überschrieben; sie werden aufgelistet und pull endet mit 1. --force verwirft sie. Ein vorhandener Spiegel lässt sich nur mit seinem Ordner pullen.",
        }),
        args: {
          first: arg.required({
            valueLabel: "notebook|dir",
            description: t({
              en: "Notebook, or the folder of an existing mirror",
              de: "Notizbuch oder der Ordner eines vorhandenen Spiegels",
            }),
          }),
          dir: arg.optional({ valueLabel: "dir", description: t({ en: "Mirror folder", de: "Spiegelordner" }) }),
        },
        flags: {
          force: flag.boolean({
            description: t({
              en: "Overwrite and delete files with local changes",
              de: "Dateien mit lokalen Änderungen überschreiben und löschen",
            }),
          }),
        },
        examples: ['cld notebooks pull "Kolb Antik Doku" ~/docs-mirror', "cld notebooks pull ~/docs-mirror"],
        run: ({ ctx, args, flags }) =>
          args.dir ? pullNotebook(ctx, args.first, args.dir, flags.force) : pullNotebook(ctx, undefined, args.first, flags.force),
      }),

      // ---------- Notebooks ----------
      command("create", {
        summary: t({
          en: "Create an empty notebook, or one from a template",
          de: "Ein leeres Notizbuch anlegen oder eines aus einer Vorlage",
        }),
        args: { name: arg.required({ description: t({ en: "Notebook name", de: "Name des Notizbuchs" }) }) },
        flags: {
          description: flag.string({ description: t({ en: "Description", de: "Beschreibung" }) }),
          icon: flag.string({ description: t({ en: "Icon", de: "Symbol" }) }),
          template: flag.string({
            description: t({
              en: "Start from a built-in template (see `templates`)",
              de: "Mit einer eingebauten Vorlage beginnen (siehe `templates`)",
            }),
          }),
        },
        async run({ ctx, args, flags }) {
          const notebook = flags.template
            ? await ctx.readJson<Notebook>(
                await ctx.fetch(`/api/notebooks/templates/${encodeURIComponent(flags.template)}`, {
                  method: "POST",
                  headers: JSON_HEADERS,
                  body: JSON.stringify({ name: args.name }),
                }),
              )
            : await ctx.readJson<Notebook>(
                await ctx.fetch("/api/notebooks", {
                  method: "POST",
                  headers: JSON_HEADERS,
                  body: JSON.stringify({ name: args.name, description: flags.description, icon: flags.icon, welcomeNote: false }),
                }),
              );
          if (!printStructured(ctx, notebook)) ctx.print(`${t({ en: "Created", de: "Angelegt" })} ${notebook.name} (${notebook.id})`);
        },
      }),
      command("templates", {
        summary: t({ en: "List built-in notebook templates", de: "Eingebaute Notizbuchvorlagen auflisten" }),
        async run({ ctx }) {
          const payload = await ctx.readJson<Array<{ id: string; name: string; description: string }>>(
            await ctx.fetch("/api/notebooks/templates"),
          );
          printRows(ctx, payload, payload, [
            { key: "id", label: "ID" },
            { key: "name", label: t({ en: "NAME", de: "NAME" }) },
            { key: "description", label: t({ en: "DESCRIPTION", de: "BESCHREIBUNG" }) },
          ]);
        },
      }),
      command("update", {
        summary: t({ en: "Change notebook settings", de: "Notizbuch-Einstellungen ändern" }),
        args: notebookArg,
        flags: {
          name: flag.string({ description: t({ en: "Name", de: "Name" }) }),
          description: flag.string({ description: t({ en: "Description", de: "Beschreibung" }) }),
          clearDescription: flag.boolean({
            name: "clear-description",
            description: t({ en: "Remove the description", de: "Beschreibung entfernen" }),
          }),
          icon: flag.string({ description: t({ en: "Icon", de: "Symbol" }) }),
          clearIcon: flag.boolean({ name: "clear-icon", description: t({ en: "Remove the icon", de: "Symbol entfernen" }) }),
          homepage: flag.string({ description: t({ en: "Homepage note address", de: "Adresse der Startseiten-Notiz" }) }),
          clearHomepage: flag.boolean({
            name: "clear-homepage",
            description: t({ en: "Remove the homepage", de: "Startseite entfernen" }),
          }),
          defaultNoteTitleTemplate: flag.string({
            name: "default-note-title-template",
            description: t({ en: "Liquid template for the H1 of new empty notes", de: "Liquid-Vorlage für die H1 neuer leerer Notizen" }),
          }),
          defaultPresentationMode: flag.enum(PRESENTATION_MODES, {
            name: "default-presentation-mode",
            description: t({ en: "Default view for editors and admins", de: "Standardansicht für Bearbeitende und Admins" }),
          }),
        },
        async run({ ctx, args, flags }) {
          const notebook = await resolveNotebookRef(ctx, args.notebook);
          const body: Record<string, unknown> = {};
          if (flags.name !== undefined) body.name = flags.name;
          if (flags.description !== undefined || flags.clearDescription) body.description = flags.description ?? null;
          if (flags.icon !== undefined || flags.clearIcon) body.icon = flags.icon ?? null;
          if (flags.homepage !== undefined || flags.clearHomepage) {
            const home = flags.homepage ? await resolveNote(ctx, flags.homepage) : null;
            if (home && home.notebookId !== notebook.id)
              throw new Error(
                t({ en: "The homepage must be a note of this notebook.", de: "Die Startseite muss eine Notiz dieses Notizbuchs sein." }),
              );
            body.homepageNoteId = home?.noteId ?? null;
          }
          if (flags.defaultNoteTitleTemplate !== undefined) body.defaultNoteTitleTemplate = flags.defaultNoteTitleTemplate;
          if (flags.defaultPresentationMode !== undefined) body.defaultPresentationMode = flags.defaultPresentationMode;
          if (Object.keys(body).length === 0) throw new Error(t({ en: "No settings to change.", de: "Keine Einstellungen zu ändern." }));
          const updated = await ctx.readJson<Notebook>(
            await ctx.fetch(api(notebook.id), { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(body) }),
          );
          if (!printStructured(ctx, updated)) ctx.print(`${t({ en: "Updated", de: "Aktualisiert" })} ${updated.name} (${updated.id})`);
        },
      }),
      command("delete", {
        summary: t({ en: "Delete a notebook and all of its content", de: "Ein Notizbuch mit allen Inhalten löschen" }),
        args: notebookArg,
        flags: { yes: confirmFlag(t({ en: "Delete without asking", de: "Ohne Nachfrage löschen" })) },
        async run({ ctx, args, flags }) {
          requireConfirmable(flags.yes);
          const notebook = await resolveNotebookRef(ctx, args.notebook);
          await confirm(
            flags.yes,
            t({
              en: `Delete the notebook "${notebook.name}" (${notebook.id}) and all notes?`,
              de: `Das Notizbuch „${notebook.name}“ (${notebook.id}) mit allen Notizen löschen?`,
            }),
          );
          const payload = await ctx.readJson<MessageResponse>(await ctx.fetch(api(notebook.id), { method: "DELETE" }));
          if (!printStructured(ctx, payload)) ctx.print(payload.message);
        },
      }),
      command("export", {
        summary: t({ en: "Export a notebook as a portable ZIP archive", de: "Ein Notizbuch als portables ZIP-Archiv exportieren" }),
        args: notebookArg,
        flags: { out: flag.string({ description: t({ en: "Destination ZIP path", de: "Ziel-ZIP-Pfad" }) }) },
        async run({ ctx, args, flags }) {
          const notebook = await resolveNotebookRef(ctx, args.notebook);
          const output = expandHome(flags.out ?? `${notebook.name.replace(/[^a-zA-Z0-9._-]+/g, "-")}.zip`);
          const response = await ctx.fetch(api(notebook.id, "/export.zip"));
          if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
          await Bun.write(output, response);
          if (!printStructured(ctx, { notebook: { id: notebook.id, name: notebook.name }, output }))
            ctx.print(`${t({ en: "Exported to", de: "Exportiert nach" })} ${output}`);
        },
      }),

      // ---------- Sub-resources ----------
      command("comments list", {
        summary: t({ en: "List comments on a note", de: "Kommentare einer Notiz auflisten" }),
        args: noteArg,
        flags: pageFlags,
        async run({ ctx, args, flags }) {
          const target = await resolveNote(ctx, args.note);
          const payload = await ctx.readJson<{
            items: Array<{ id: string; authorDisplayName: string; content: string; createdAt: string }>;
          }>(await ctx.fetch(withQuery(noteApi(target, "/comments/page"), { page: flags.page, per_page: flags.perPage })));
          printRows(
            ctx,
            payload,
            payload.items.map((item) => ({ ...item, content: item.content.replace(/\s+/g, " ").slice(0, 120) })),
            [
              { key: "id", label: "ID" },
              { key: "authorDisplayName", label: t({ en: "AUTHOR", de: "AUTOR" }) },
              { key: "content", label: t({ en: "COMMENT", de: "KOMMENTAR" }) },
              { key: "createdAt", label: t({ en: "CREATED", de: "ERSTELLT" }) },
            ],
          );
        },
      }),
      command("comments add", {
        summary: t({ en: "Add a Markdown comment", de: "Einen Markdown-Kommentar hinzufügen" }),
        args: noteArg,
        flags: inputFlags,
        async run({ ctx, args, flags }) {
          const target = await resolveNote(ctx, args.note);
          const content = await requireContent(flags.from, flags.content);
          const comment = await ctx.readJson<{ id: string }>(
            await ctx.fetch(noteApi(target, "/comments"), { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ content }) }),
          );
          if (!printStructured(ctx, comment)) ctx.print(`${t({ en: "Added comment", de: "Kommentar hinzugefügt" })} ${comment.id}`);
        },
      }),
      command("comments update", {
        summary: t({ en: "Change your recent comment", de: "Eigenen neuen Kommentar ändern" }),
        args: { ...noteArg, comment: arg.required({ valueLabel: "comment-id", description: t({ en: "Comment ID", de: "Kommentar-ID" }) }) },
        flags: inputFlags,
        async run({ ctx, args, flags }) {
          const target = await resolveNote(ctx, args.note);
          const content = await requireContent(flags.from, flags.content);
          const comment = await ctx.readJson<{ id: string }>(
            await ctx.fetch(noteApi(target, `/comments/${encodeURIComponent(args.comment)}`), {
              method: "PATCH",
              headers: JSON_HEADERS,
              body: JSON.stringify({ content }),
            }),
          );
          if (!printStructured(ctx, comment)) ctx.print(`${t({ en: "Updated comment", de: "Kommentar geändert" })} ${comment.id}`);
        },
      }),
      command("comments delete", {
        summary: t({ en: "Delete your recent comment", de: "Eigenen neuen Kommentar löschen" }),
        args: { ...noteArg, comment: arg.required({ valueLabel: "comment-id", description: t({ en: "Comment ID", de: "Kommentar-ID" }) }) },
        flags: { yes: confirmFlag(t({ en: "Delete without asking", de: "Ohne Nachfrage löschen" })) },
        async run({ ctx, args, flags }) {
          requireConfirmable(flags.yes);
          const target = await resolveNote(ctx, args.note);
          await confirm(flags.yes, t({ en: `Delete comment ${args.comment}?`, de: `Kommentar ${args.comment} löschen?` }));
          const payload = await ctx.readJson<MessageResponse>(
            await ctx.fetch(noteApi(target, `/comments/${encodeURIComponent(args.comment)}`), { method: "DELETE" }),
          );
          if (!printStructured(ctx, payload)) ctx.print(payload.message);
        },
      }),
      command("versions list", {
        summary: t({ en: "List versions of a note", de: "Versionen einer Notiz auflisten" }),
        args: noteArg,
        flags: pageFlags,
        async run({ ctx, args, flags }) {
          const target = await resolveNote(ctx, args.note);
          const payload = await ctx.readJson<Page<{ id: string; createdAt: string }>>(
            await ctx.fetch(withQuery(noteApi(target, "/versions"), { page: flags.page, per_page: flags.perPage })),
          );
          printRows(ctx, payload, payload.data, [
            { key: "id", label: "ID" },
            { key: "createdAt", label: t({ en: "CREATED", de: "ERSTELLT" }) },
          ]);
        },
      }),
      command("versions cat", {
        summary: t({ en: "Print the content of one version", de: "Den Inhalt einer Version ausgeben" }),
        args: { ...noteArg, version: arg.required({ valueLabel: "version-id", description: t({ en: "Version ID", de: "Versions-ID" }) }) },
        async run({ ctx, args }) {
          const target = await resolveNote(ctx, args.note);
          const version = await ctx.readJson<{ id: string; createdAt: string; contentMd: string | null }>(
            await ctx.fetch(noteApi(target, `/versions/${encodeURIComponent(args.version)}/content`)),
          );
          if (!printStructured(ctx, { id: version.id, createdAt: version.createdAt, content: version.contentMd ?? "" }))
            await ctx.write(version.contentMd ?? "");
        },
      }),
      command("versions restore", {
        summary: t({
          en: "Restore a version into an existing empty note",
          de: "Eine Version in eine vorhandene leere Notiz wiederherstellen",
        }),
        args: { ...noteArg, version: arg.required({ valueLabel: "version-id", description: t({ en: "Version ID", de: "Versions-ID" }) }) },
        flags: { into: flag.string({ required: true, description: t({ en: "Empty target note", de: "Leere Zielnotiz" }) }) },
        async run({ ctx, args, flags }) {
          const source = await resolveNote(ctx, args.note);
          const target = await resolveNote(ctx, flags.into!);
          const version = await ctx.readJson<{ yjsSnapshot: string }>(
            await ctx.fetch(noteApi(source, `/versions/${encodeURIComponent(args.version)}/content`)),
          );
          const restored = await ctx.readJson<Note>(
            await ctx.fetch(noteApi(target, "/restore"), {
              method: "POST",
              headers: JSON_HEADERS,
              body: JSON.stringify({ yjsSnapshot: version.yjsSnapshot }),
            }),
          );
          if (!printStructured(ctx, restored))
            ctx.print(`${t({ en: "Restored into", de: "Wiederhergestellt in" })} ${restored.title} (${restored.id})`);
        },
      }),
      command("attachments list", {
        summary: t({ en: "List notebook attachments", de: "Anhänge eines Notizbuchs auflisten" }),
        args: notebookArg,
        async run({ ctx, args }) {
          const notebook = await resolveNotebookRef(ctx, args.notebook);
          const payload = await ctx.readJson<Attachment[]>(await ctx.fetch(api(notebook.id, "/attachments")));
          printRows(ctx, payload, payload, [
            { key: "id", label: "ID" },
            { key: "filename", label: t({ en: "FILE", de: "DATEI" }) },
            { key: "mimeType", label: t({ en: "TYPE", de: "TYP" }) },
            { key: "sizeBytes", label: "BYTES" },
          ]);
        },
      }),
      command("attachments download", {
        summary: t({ en: "Download an attachment", de: "Einen Anhang herunterladen" }),
        args: {
          ...notebookArg,
          attachment: arg.required({ valueLabel: "attachment-id", description: t({ en: "Attachment ID", de: "Anhang-ID" }) }),
        },
        flags: { out: flag.string({ description: t({ en: "Destination path", de: "Zielpfad" }) }) },
        async run({ ctx, args, flags }) {
          const notebook = await resolveNotebookRef(ctx, args.notebook);
          const meta = await ctx.readJson<Attachment>(
            await ctx.fetch(api(notebook.id, `/attachments/${encodeURIComponent(args.attachment)}`)),
          );
          const output = expandHome(flags.out ?? meta.filename);
          const response = await ctx.fetch(api(notebook.id, `/attachments/${encodeURIComponent(meta.id)}/content`));
          if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
          await Bun.write(output, response);
          if (!printStructured(ctx, { attachment: meta, output })) ctx.print(`${t({ en: "Saved", de: "Gespeichert" })} ${output}`);
        },
      }),
      command("attachments delete", {
        summary: t({
          en: "Delete an attachment; shows how many notes use it",
          de: "Einen Anhang löschen; zeigt, wie viele Notizen ihn nutzen",
        }),
        args: {
          ...notebookArg,
          attachment: arg.required({ valueLabel: "attachment-id", description: t({ en: "Attachment ID", de: "Anhang-ID" }) }),
        },
        flags: { yes: confirmFlag(t({ en: "Delete without asking", de: "Ohne Nachfrage löschen" })) },
        async run({ ctx, args, flags }) {
          requireConfirmable(flags.yes);
          const notebook = await resolveNotebookRef(ctx, args.notebook);
          const usage = await ctx.readJson<{ count: number }>(
            await ctx.fetch(api(notebook.id, `/attachments/${encodeURIComponent(args.attachment)}/usage`)),
          );
          await confirm(
            flags.yes,
            t({
              en: `Delete attachment ${args.attachment}? ${usage.count} notes link to it.`,
              de: `Anhang ${args.attachment} löschen? ${usage.count} Notizen verlinken ihn.`,
            }),
          );
          const payload = await ctx.readJson<MessageResponse>(
            await ctx.fetch(api(notebook.id, `/attachments/${encodeURIComponent(args.attachment)}`), { method: "DELETE" }),
          );
          if (!printStructured(ctx, { ...payload, linkedNotes: usage.count })) ctx.print(payload.message);
        },
      }),
      command("favorites list", {
        summary: t({ en: "List your favorite notes in a notebook", de: "Eigene Lieblingsnotizen eines Notizbuchs auflisten" }),
        args: notebookArg,
        async run({ ctx, args }) {
          const notebook = await resolveNotebookRef(ctx, args.notebook);
          const payload = await ctx.readJson<{ noteId: string; createdAt: string }[]>(await ctx.fetch(api(notebook.id, "/favorites")));
          printRows(ctx, payload, payload, [
            { key: "noteId", label: "ID" },
            { key: "createdAt", label: t({ en: "ADDED", de: "HINZUGEFÜGT" }) },
          ]);
        },
      }),
      ...(["add", "remove"] as const).map((action) =>
        command(`favorites ${action}`, {
          summary:
            action === "add"
              ? t({ en: "Add a note to your favorites", de: "Eine Notiz zu den Favoriten hinzufügen" })
              : t({ en: "Remove a note from your favorites", de: "Eine Notiz aus den Favoriten entfernen" }),
          args: noteArg,
          async run({ ctx, args }) {
            const target = await resolveNote(ctx, args.note);
            const payload = await ctx.readJson<{ favorite: boolean }>(
              await ctx.fetch(noteApi(target, "/favorite"), {
                method: "PUT",
                headers: JSON_HEADERS,
                body: JSON.stringify({ favorite: action === "add" }),
              }),
            );
            if (!printStructured(ctx, { noteId: target.noteId, ...payload })) ctx.print(`${payload.favorite ? "★" : "☆"} ${target.noteId}`);
          },
        }),
      ),
      command("api-keys list", {
        summary: t({ en: "List notebook-bound API keys", de: "Notizbuch-gebundene API-Schlüssel auflisten" }),
        args: notebookArg,
        async run({ ctx, args }) {
          const notebook = await resolveNotebookRef(ctx, args.notebook);
          const payload = await ctx.readJson<{ items: Array<Record<string, unknown>> }>(await ctx.fetch(api(notebook.id, "/api-keys")));
          printRows(ctx, payload, payload.items, [
            { key: "id", label: "ID" },
            { key: "name", label: t({ en: "NAME", de: "NAME" }) },
            { key: "permission", label: t({ en: "PERMISSION", de: "RECHT" }) },
            { key: "lastUsedAt", label: t({ en: "LAST USED", de: "ZULETZT GENUTZT" }) },
          ]);
        },
      }),
      command("api-keys create", {
        summary: t({
          en: "Create a notebook-bound API key; the token is shown once",
          de: "Einen notizbuch-gebundenen API-Schlüssel anlegen; das Token wird einmal gezeigt",
        }),
        args: { ...notebookArg, name: arg.required({ description: t({ en: "Key name", de: "Name des Schlüssels" }) }) },
        flags: {
          permission: flag.enum(["read", "write", "admin"], { default: "read", description: t({ en: "Permission", de: "Recht" }) }),
          expiresAt: flag.string({
            name: "expires-at",
            description: t({ en: "Optional ISO expiry time", de: "Optionaler ISO-Ablaufzeitpunkt" }),
          }),
        },
        async run({ ctx, args, flags }) {
          const notebook = await resolveNotebookRef(ctx, args.notebook);
          const payload = await ctx.readJson<{ credential: { id: string; name: string }; token: string }>(
            await ctx.fetch(api(notebook.id, "/api-keys"), {
              method: "POST",
              headers: JSON_HEADERS,
              body: JSON.stringify({ name: args.name, permission: flags.permission, expiresAt: flags.expiresAt ?? null }),
            }),
          );
          if (!printStructured(ctx, payload)) {
            ctx.print(`${t({ en: "Created", de: "Angelegt" })} ${payload.credential.name} (${payload.credential.id})`);
            ctx.print(payload.token);
          }
        },
      }),
      command("api-keys revoke", {
        summary: t({ en: "Revoke a notebook API key", de: "Einen Notizbuch-API-Schlüssel widerrufen" }),
        args: { ...notebookArg, key: arg.required({ valueLabel: "key-id", description: t({ en: "API key ID", de: "API-Schlüssel-ID" }) }) },
        flags: { yes: confirmFlag(t({ en: "Revoke without asking", de: "Ohne Nachfrage widerrufen" })) },
        async run({ ctx, args, flags }) {
          requireConfirmable(flags.yes);
          const notebook = await resolveNotebookRef(ctx, args.notebook);
          await confirm(flags.yes, t({ en: `Revoke API key ${args.key}?`, de: `API-Schlüssel ${args.key} widerrufen?` }));
          const payload = await ctx.readJson<MessageResponse>(
            await ctx.fetch(api(notebook.id, `/api-keys/${encodeURIComponent(args.key)}`), { method: "DELETE" }),
          );
          if (!printStructured(ctx, payload)) ctx.print(payload.message);
        },
      }),
      command("snapshots show", {
        summary: t({
          en: "Show the S3 snapshot settings (secrets redacted)",
          de: "S3-Snapshot-Einstellungen zeigen (Geheimnisse ausgeblendet)",
        }),
        args: notebookArg,
        async run({ ctx, args }) {
          const notebook = await resolveNotebookRef(ctx, args.notebook);
          ctx.json(await ctx.readJson<unknown>(await ctx.fetch(api(notebook.id, "/snapshots/config"))));
        },
      }),
      command("snapshots set", {
        summary: t({ en: "Change the S3 snapshot settings", de: "S3-Snapshot-Einstellungen ändern" }),
        args: notebookArg,
        flags: {
          enabled: flag.enum(["true", "false"], {
            description: t({ en: "Enable or disable snapshots", de: "Snapshots ein- oder ausschalten" }),
          }),
          endpoint: flag.string({ description: "S3 endpoint" }),
          region: flag.string({ description: "S3 region" }),
          bucket: flag.string({ description: "S3 bucket" }),
          accessKeyId: flag.string({ name: "access-key-id", description: "S3 access key ID" }),
          secretAccessKey: flag.string({ name: "secret-access-key", description: "S3 secret access key" }),
        },
        async run({ ctx, args, flags }) {
          const notebook = await resolveNotebookRef(ctx, args.notebook);
          const current = await ctx.readJson<{ enabled: boolean }>(await ctx.fetch(api(notebook.id, "/snapshots/config")));
          ctx.json(
            await ctx.readJson<unknown>(
              await ctx.fetch(api(notebook.id, "/snapshots/config"), {
                method: "PUT",
                headers: JSON_HEADERS,
                body: JSON.stringify({
                  enabled: flags.enabled === undefined ? current.enabled : flags.enabled === "true",
                  endpoint: flags.endpoint,
                  region: flags.region,
                  bucket: flags.bucket,
                  accessKeyId: flags.accessKeyId,
                  secretAccessKey: flags.secretAccessKey,
                }),
              }),
            ),
          );
        },
      }),
      command("snapshots logs", {
        summary: t({ en: "List recent snapshot runs", de: "Letzte Snapshot-Läufe auflisten" }),
        args: notebookArg,
        async run({ ctx, args }) {
          const notebook = await resolveNotebookRef(ctx, args.notebook);
          const payload = await ctx.readJson<Array<Record<string, unknown>>>(await ctx.fetch(api(notebook.id, "/snapshots/logs")));
          printRows(ctx, payload, payload, [
            { key: "createdAt", label: t({ en: "TIME", de: "ZEIT" }) },
            { key: "level", label: "LEVEL" },
            { key: "message", label: t({ en: "MESSAGE", de: "MELDUNG" }) },
          ]);
        },
      }),
      command("snapshots run", {
        summary: t({ en: "Run an S3 snapshot now", de: "Jetzt einen S3-Snapshot ausführen" }),
        args: notebookArg,
        async run({ ctx, args }) {
          const notebook = await resolveNotebookRef(ctx, args.notebook);
          ctx.json(await ctx.readJson<unknown>(await ctx.fetch(api(notebook.id, "/snapshots/run"), { method: "POST" })));
        },
      }),
      ...notebookAccessCommands,
    ],
  });
}

const module = notebooksCommands();
export default {
  ...module,
  help: (locale?: string) => notebooksCommands(locale).help!(),
  run: (ctx: CloudCliContext) => notebooksCommands(ctx.options.locale).run(ctx),
};
