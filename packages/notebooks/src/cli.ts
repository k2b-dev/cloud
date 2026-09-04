import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  arg,
  type CloudApiClient,
  type CloudCliContext,
  type CloudCliFlags,
  command,
  confirmFlag,
  createAccessCommands,
  defineCliCommands,
  flag,
  printRows as printJsonOrTable,
  printStructured,
} from "@valentinkolb/cloud/cli";
import type { AccessEntry, PermissionLevel, Principal } from "@valentinkolb/cloud/contracts";
import type { ApiType } from "./api";
import { findNamedBlocks, type NamedBlockType, namedBlockBody } from "./lib/named-blocks";
import {
  applyNoteEdits,
  type NoteEditBlockSummary,
  type NoteEditOperation,
  noteContentHash,
  summarizeNoteEditBlocks,
} from "./lib/note-edit";
import { PRESENTATION_MODES, type PresentationMode } from "./lib/presentation-mode";

type Notebook = {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  homepageNoteId: string | null;
  defaultPresentationMode: PresentationMode;
  defaultNoteTitleTemplate: string;
  createdBy: string | null;
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
  yjsSnapshotAt: string | null;
  contentMd: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lockedAt: string | null;
};

type NoteWithContent = Note & {
  yjsSnapshot: string | null;
};

type NoteEditResponse = {
  note: Note;
  content: string;
  changed: boolean;
  beforeHash: string;
  afterHash: string;
  blocks: NoteEditBlockSummary[];
};

type NoteTreeNode = Note & {
  children: NoteTreeNode[];
};

type NoteVersion = {
  id: string;
  noteId: string;
  createdBy: string | null;
  createdAt: string;
};

type NoteComment = {
  id: string;
  notebookId: string;
  noteId: string;
  authorUserId: string | null;
  authorDisplayName: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
  canDelete: boolean;
};

type NoteCommentPage = {
  items: NoteComment[];
  page: number;
  perPage: number;
  total: number;
  hasNext: boolean;
};

type Pagination = {
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
  has_next: boolean;
};

type Page<T> = {
  data: T[];
  pagination: Pagination;
};

type MessageResponse = {
  message: string;
};

type NoteSearchHit = {
  note: Omit<Note, "contentMd">;
  notebook: Pick<Notebook, "id" | "name" | "icon">;
  snippet: string | null;
};

const compactSearchSnippet = (snippet: string | null): string => {
  const compact = snippet?.replaceAll("\uE000", "").replaceAll("\uE001", "").replace(/\s+/g, " ").trim() ?? "";
  return compact.length > 160 ? `${compact.slice(0, 159).trimEnd()}…` : compact;
};

type Attachment = {
  id: string;
  notebookId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  kind: "image" | "file";
  createdBy: string | null;
  createdAt: string;
};

type Template = { id: string; name: string; description: string; icon: string };

type ApiKey = {
  id: string;
  serviceAccountId: string;
  name: string;
  kind: "api_token";
  status: "active" | "revoked";
  tokenPrefix: string;
  scopes: string[];
  permission: "none" | "read" | "write" | "admin";
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
};

type SnapshotConfig = {
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  scheduleCron: string;
  accessKeyIdSet: boolean;
  secretAccessKeySet: boolean;
  configured: boolean;
  missing: string[];
  target: string | null;
};

const NOTEBOOK_DEFAULT_KEY = "notebooks.notebook";
const RESOURCE_ID_RE = /^[A-Za-z0-9]{6}$/;

const stringFlag = (flags: CloudCliFlags, ...names: string[]): string | undefined => {
  for (const name of names) {
    const value = flags[name];
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.at(-1);
  }
  return undefined;
};

const booleanFlag = (flags: CloudCliFlags, ...names: string[]): boolean => names.some((name) => flags[name] === true);

const optionalBooleanFlag = (flags: CloudCliFlags, ...names: string[]): boolean | undefined => {
  const raw = stringFlag(flags, ...names);
  if (raw === undefined) return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`--${names[0]} must be true or false.`);
};

const numberFlag = (flags: CloudCliFlags, name: string): number | undefined => {
  const value = stringFlag(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`--${name} must be a 0-based integer.`);
  return parsed;
};

const paginationQuery = (flags: CloudCliFlags, extra: Record<string, string | undefined> = {}) => {
  const query: Record<string, string> = {};
  const page = stringFlag(flags, "page");
  const perPage = stringFlag(flags, "per-page", "per_page");
  if (page) query.page = page;
  if (perPage) query.per_page = perPage;
  for (const [key, value] of Object.entries(extra)) {
    if (value) query[key] = value;
  }
  return query;
};

const notebookRows = (items: Notebook[]) =>
  items.map((notebook) => ({
    id: notebook.id,
    name: notebook.name,
    updatedAt: notebook.updatedAt,
  }));

const noteRows = (items: Note[]) =>
  items.map((note) => ({
    id: note.id,
    title: note.title,
    parent: note.parentId ?? "",
    updatedAt: note.updatedAt,
  }));

const printTree = (ctx: CloudCliContext, nodes: NoteTreeNode[], depth = 0) => {
  for (const node of nodes) {
    ctx.print(`${"  ".repeat(depth)}- ${node.title} (${node.id})`);
    printTree(ctx, node.children, depth + 1);
  }
};

const requireArg = (args: string[], index: number, label: string): string => {
  const value = args[index];
  if (!value) throw new Error(`Missing ${label}.`);
  return value;
};

const requireDefaultNotebookRef = async (ctx: CloudCliContext): Promise<string> => {
  const ref = await ctx.getDefault(NOTEBOOK_DEFAULT_KEY);
  if (!ref) throw new Error("Missing notebook. Pass --notebook <notebook> or run `cld notebooks use <notebook>`.");
  return ref;
};

const resolveNotebookArg = async (
  ctx: CloudCliContext,
  args: string[],
  requiredTrailingArgs: number,
): Promise<{ notebookRef: string; rest: string[] }> => {
  const flagged = stringFlag(ctx.flags, "notebook");
  if (flagged) return { notebookRef: flagged, rest: args };
  if (args.length > requiredTrailingArgs) return { notebookRef: requireArg(args, 0, "notebook"), rest: args.slice(1) };
  return { notebookRef: await requireDefaultNotebookRef(ctx), rest: args };
};

const resolveNoteCommandArgs = async (
  ctx: CloudCliContext,
  args: string[],
  requiredTrailingAfterNote = 0,
): Promise<{ notebookRef: string; noteRef: string; rest: string[] }> => {
  const flaggedNote = stringFlag(ctx.flags, "note");
  if (flaggedNote) {
    const { notebookRef, rest } = await resolveNotebookArg(ctx, args, requiredTrailingAfterNote);
    return { notebookRef, noteRef: flaggedNote, rest };
  }
  const { notebookRef, rest } = await resolveNotebookArg(ctx, args, requiredTrailingAfterNote + 1);
  return { notebookRef, noteRef: requireArg(rest, 0, "note"), rest: rest.slice(1) };
};

const parseLineRange = (value: string): { startLine: number; endLine: number } => {
  const [startRaw, endRaw] = value.split(":");
  const startLine = Number.parseInt(startRaw ?? "", 10);
  const endLine = Number.parseInt(endRaw ?? startRaw ?? "", 10);
  if (
    !/^\d+(?::\d+)?$/.test(value) ||
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    throw new Error(`Invalid line range "${value}". Use 1-based "start:end".`);
  }
  return { startLine, endLine };
};

const parseLineValue = (value: string, label: string): number => {
  const line = Number.parseInt(value, 10);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(line) || line < 1)
    throw new Error(`Invalid ${label} "${value}". Use a 1-based line number.`);
  return line;
};

const readInputContent = async (ctx: CloudCliContext, required = true): Promise<string> => {
  const literal = stringFlag(ctx.flags, "content");
  const file = stringFlag(ctx.flags, "file", "f");
  const stdin = booleanFlag(ctx.flags, "stdin");
  const sources = [literal !== undefined, file !== undefined, stdin].filter(Boolean).length;
  if (sources > 1) throw new Error("Pass only one of --content, --file, or --stdin.");
  if (literal !== undefined) return literal;
  if (file) return readFile(file, "utf8");
  if (stdin) return Bun.stdin.text();
  if (required) throw new Error("Missing edit content. Pass --content, --file, or --stdin.");
  return "";
};

const formatNumberedLines = (content: string): string =>
  content
    .split("\n")
    .map((line, index) => `${String(index + 1).padStart(4, " ")} | ${line}`)
    .join("\n");

const printBlocks = (ctx: CloudCliContext, blocks: NoteEditBlockSummary[]) => {
  if (blocks.length === 0) {
    ctx.print("Blocks: none");
    return;
  }
  ctx.print("Blocks:");
  for (const block of blocks) {
    ctx.print(`  @${block.name} ${block.type} lines ${block.startLine}:${block.endLine} ${block.hash}`);
  }
};

const isHttpStatus = (error: unknown, status: number): boolean => error instanceof Error && error.message.startsWith(`${status} `);

const formatNotebookCandidates = (items: Notebook[]): string =>
  items
    .slice(0, 5)
    .map((item) => `${item.name} (${item.id})`)
    .join(", ");

const formatNoteCandidates = (items: Note[]): string =>
  items
    .slice(0, 5)
    .map((item) => `${item.title} (${item.id})`)
    .join(", ");

const resolveNotePath = (tree: NoteTreeNode[], path: string): Note | null => {
  const segments = path
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) return null;

  let level = tree;
  let current: NoteTreeNode | null = null;
  for (const segment of segments) {
    const matches = level.filter((note) => note.title === segment || note.id === segment);
    if (matches.length > 1) {
      throw new Error(`Note path "${path}" is ambiguous at "${segment}". Use a short id for that segment.`);
    }
    current = matches[0] ?? null;
    if (!current) return null;
    level = current.children;
  }
  return current;
};

const resolveNotebookRef = async (ctx: CloudCliContext, api: CloudApiClient<ApiType>, ref: string): Promise<Notebook> => {
  if (RESOURCE_ID_RE.test(ref)) {
    try {
      return await ctx.readJson<Notebook>(await api[":id"].$get({ param: { id: ref } }));
    } catch (error) {
      if (!isHttpStatus(error, 404)) throw error;
    }
  }
  const response = await api.index.$get({ query: { q: ref, per_page: "20" } });
  const page = await ctx.readJson<Page<Notebook>>(response);
  const matches = page.data.filter((item) => item.name === ref);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(`Notebook "${ref}" is ambiguous. Use one of: ${matches.map((item) => `${item.name} (${item.id})`).join(", ")}`);
  }
  const candidates = formatNotebookCandidates(page.data);
  throw new Error(
    candidates
      ? `Notebook "${ref}" was not found by short id or exact name. Similar matches: ${candidates}`
      : `Notebook "${ref}" was not found by short id or exact name.`,
  );
};

const resolveNoteRef = async (ctx: CloudCliContext, api: CloudApiClient<ApiType>, notebookId: string, ref: string): Promise<Note> => {
  if (RESOURCE_ID_RE.test(ref)) {
    try {
      return await ctx.readJson<Note>(await api[":id"].notes[":noteId"].$get({ param: { id: notebookId, noteId: ref } }));
    } catch (error) {
      if (!isHttpStatus(error, 404)) throw error;
    }
  }
  if (ref.includes("/")) {
    const tree = await ctx.readJson<NoteTreeNode[]>(await api[":id"].tree.$get({ param: { id: notebookId } }));
    const pathMatch = resolveNotePath(tree, ref);
    if (pathMatch) return pathMatch;
  }
  const response = await api[":id"].notes.$get({
    param: { id: notebookId },
    query: { q: ref, per_page: "50" },
  });
  const page = await ctx.readJson<Page<Note>>(response);
  const matches = page.data.filter((item) => item.title === ref);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(`Note "${ref}" is ambiguous. Use one of: ${matches.map((item) => `${item.title} (${item.id})`).join(", ")}`);
  }
  const candidates = formatNoteCandidates(page.data);
  throw new Error(
    candidates
      ? `Note "${ref}" was not found in notebook ${notebookId} by short id or exact title. Similar matches: ${candidates}`
      : `Note "${ref}" was not found in notebook ${notebookId} by short id or exact title.`,
  );
};

const buildEditOperation = async (ctx: CloudCliContext): Promise<NoteEditOperation> => {
  const operations = [
    "replace-lines",
    "delete-lines",
    "insert-before-line",
    "insert-after-line",
    "replace-block",
    "append-block",
    "prepend-block",
    "append",
    "prepend",
    "set-content",
  ].filter((name) => stringFlag(ctx.flags, name) !== undefined || booleanFlag(ctx.flags, name));
  if (operations.length > 1) throw new Error("Pass exactly one edit operation per invocation.");
  const blockType = stringFlag(ctx.flags, "type") as NamedBlockType | undefined;
  const index = numberFlag(ctx.flags, "index");
  const blockOptions = {
    ...(blockType ? { type: blockType } : {}),
    ...(index !== undefined ? { index } : {}),
  };

  const replaceLines = stringFlag(ctx.flags, "replace-lines");
  if (replaceLines) return { kind: "replace-lines", ...parseLineRange(replaceLines), content: await readInputContent(ctx) };

  const deleteLines = stringFlag(ctx.flags, "delete-lines");
  if (deleteLines) return { kind: "delete-lines", ...parseLineRange(deleteLines) };

  const insertBeforeLine = stringFlag(ctx.flags, "insert-before-line");
  if (insertBeforeLine)
    return { kind: "insert-before-line", line: parseLineValue(insertBeforeLine, "line"), content: await readInputContent(ctx) };

  const insertAfterLine = stringFlag(ctx.flags, "insert-after-line");
  if (insertAfterLine)
    return { kind: "insert-after-line", line: parseLineValue(insertAfterLine, "line"), content: await readInputContent(ctx) };

  const replaceBlock = stringFlag(ctx.flags, "replace-block");
  if (replaceBlock) {
    return {
      kind: "replace-block",
      name: replaceBlock,
      ...blockOptions,
      includeHandle: booleanFlag(ctx.flags, "include-handle"),
      content: await readInputContent(ctx),
    };
  }

  const appendBlock = stringFlag(ctx.flags, "append-block");
  if (appendBlock) return { kind: "append-block", name: appendBlock, ...blockOptions, content: await readInputContent(ctx) };

  const prependBlock = stringFlag(ctx.flags, "prepend-block");
  if (prependBlock) return { kind: "prepend-block", name: prependBlock, ...blockOptions, content: await readInputContent(ctx) };

  if (booleanFlag(ctx.flags, "append")) return { kind: "append", content: await readInputContent(ctx) };
  if (booleanFlag(ctx.flags, "prepend")) return { kind: "prepend", content: await readInputContent(ctx) };
  if (booleanFlag(ctx.flags, "set-content")) return { kind: "set-content", content: await readInputContent(ctx) };

  throw new Error("Missing edit operation. Run `cld notebooks help` for supported edit flags.");
};

const runNotebooksCommand = async (ctx: CloudCliContext, command: string, args: string[]) => {
  const api = ctx.createApiClient<ApiType>("/api/notebooks");

  if (command === "list") {
    const query = paginationQuery(ctx.flags, { q: stringFlag(ctx.flags, "q", "query") });
    const response = await api.index.$get({ query });
    const payload = await ctx.readJson<Page<Notebook>>(response);
    printJsonOrTable(ctx, payload, notebookRows(payload.data), [
      { key: "id", label: "ID" },
      { key: "name", label: "NAME" },
      { key: "updatedAt", label: "UPDATED" },
    ]);
    return 0;
  }

  if (command === "use") {
    const notebookRef = requireArg(args, 0, "notebook");
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    await ctx.setDefault(NOTEBOOK_DEFAULT_KEY, notebook.id);
    if (!printStructured(ctx, { notebook, defaultNotebook: notebook.id })) ctx.print(`Using notebook ${notebook.name} (${notebook.id}).`);
    return 0;
  }

  if (command === "current") {
    const notebookRef = await ctx.getDefault(NOTEBOOK_DEFAULT_KEY);
    if (!notebookRef) throw new Error("No default notebook configured. Run `cld notebooks use <notebook>`.");
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    if (!printStructured(ctx, { notebook, defaultNotebook: notebook.id })) ctx.print(`${notebook.name} (${notebook.id})`);
    return 0;
  }

  if (command === "get") {
    const { notebookRef } = await resolveNotebookArg(ctx, args, 0);
    const payload = await resolveNotebookRef(ctx, api, notebookRef);
    if (!printStructured(ctx, payload)) {
      ctx.print(`${payload.name} (${payload.id})`);
      if (payload.description) ctx.print(payload.description);
      ctx.print(`id: ${payload.id}`);
      ctx.print(`updated: ${payload.updatedAt}`);
    }
    return 0;
  }

  if (command === "create") {
    const name = requireArg(args, 0, "notebook name");
    const response = await ctx.fetch("/api/notebooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        description: stringFlag(ctx.flags, "description"),
        icon: stringFlag(ctx.flags, "icon"),
      }),
    });
    const payload = await ctx.readJson<Notebook>(response);
    if (booleanFlag(ctx.flags, "use")) await ctx.setDefault(NOTEBOOK_DEFAULT_KEY, payload.id);
    if (!printStructured(ctx, payload))
      ctx.print(`Created ${payload.name} (${payload.id}).${booleanFlag(ctx.flags, "use") ? " Using it as default." : ""}`);
    return 0;
  }

  if (command === "update") {
    const { notebookRef } = await resolveNotebookArg(ctx, args, 0);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const body: Record<string, unknown> = {};
    const name = stringFlag(ctx.flags, "name");
    const description = stringFlag(ctx.flags, "description");
    const icon = stringFlag(ctx.flags, "icon");
    const homepageRef = stringFlag(ctx.flags, "homepage");
    const defaultNoteTitleTemplate = stringFlag(ctx.flags, "default-note-title-template");
    const defaultPresentationMode = stringFlag(ctx.flags, "default-presentation-mode");
    if (name !== undefined) body.name = name;
    if (description !== undefined || booleanFlag(ctx.flags, "clear-description")) body.description = description ?? null;
    if (icon !== undefined || booleanFlag(ctx.flags, "clear-icon")) body.icon = icon ?? null;
    if (homepageRef || booleanFlag(ctx.flags, "clear-homepage")) {
      body.homepageNoteId = homepageRef ? (await resolveNoteRef(ctx, api, notebook.id, homepageRef)).id : null;
    }
    if (defaultNoteTitleTemplate !== undefined) body.defaultNoteTitleTemplate = defaultNoteTitleTemplate;
    if (defaultPresentationMode !== undefined) body.defaultPresentationMode = defaultPresentationMode;
    if (Object.keys(body).length === 0) throw new Error("No notebook updates supplied.");
    const payload = await ctx.readJson<Notebook>(
      await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    if (!printStructured(ctx, payload)) ctx.print(`Updated ${payload.name} (${payload.id}).`);
    return 0;
  }

  if (command === "delete") {
    if (!booleanFlag(ctx.flags, "yes")) throw new Error("Refusing to delete a notebook without --yes.");
    const { notebookRef } = await resolveNotebookArg(ctx, args, 0);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const payload = await ctx.readJson<MessageResponse>(
      await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}`, { method: "DELETE" }),
    );
    if ((await ctx.getDefault(NOTEBOOK_DEFAULT_KEY)) === notebook.id) await ctx.setDefault(NOTEBOOK_DEFAULT_KEY, "");
    if (!printStructured(ctx, payload)) ctx.print(payload.message);
    return 0;
  }

  if (command === "templates") {
    const payload = await ctx.readJson<Template[]>(await ctx.fetch("/api/notebooks/templates"));
    printJsonOrTable(ctx, payload, payload, [
      { key: "id", label: "ID" },
      { key: "name", label: "NAME" },
      { key: "description", label: "DESCRIPTION" },
    ]);
    return 0;
  }

  if (command === "create-from-template") {
    const templateId = requireArg(args, 0, "template id");
    const payload = await ctx.readJson<Notebook>(
      await ctx.fetch(`/api/notebooks/templates/${encodeURIComponent(templateId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: stringFlag(ctx.flags, "name") }),
      }),
    );
    if (booleanFlag(ctx.flags, "use")) await ctx.setDefault(NOTEBOOK_DEFAULT_KEY, payload.id);
    if (!printStructured(ctx, payload)) ctx.print(`Created ${payload.name} (${payload.id}) from ${templateId}.`);
    return 0;
  }

  if (command === "tree") {
    const { notebookRef } = await resolveNotebookArg(ctx, args, 0);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const response = await api[":id"].tree.$get({ param: { id: notebook.id } });
    const payload = await ctx.readJson<NoteTreeNode[]>(response);
    if (!printStructured(ctx, payload)) printTree(ctx, payload);
    return 0;
  }

  if (command === "notes") {
    const { notebookRef } = await resolveNotebookArg(ctx, args, 0);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const parentRef = stringFlag(ctx.flags, "parent", "parent-id");
    const parent = parentRef ? await resolveNoteRef(ctx, api, notebook.id, parentRef) : null;
    const response = await api[":id"].notes.$get({
      param: { id: notebook.id },
      query: paginationQuery(ctx.flags, {
        q: stringFlag(ctx.flags, "q", "query"),
        parentId: parent?.id,
      }),
    });
    const payload = await ctx.readJson<Page<Note>>(response);
    printJsonOrTable(ctx, payload, noteRows(payload.data), [
      { key: "id", label: "ID" },
      { key: "title", label: "TITLE" },
      { key: "updatedAt", label: "UPDATED" },
    ]);
    return 0;
  }

  if (command === "search") {
    const all = booleanFlag(ctx.flags, "all");
    const commonFilters = {
      tags: stringFlag(ctx.flags, "tags", "tag"),
      created_after: stringFlag(ctx.flags, "created-after"),
      created_before: stringFlag(ctx.flags, "created-before"),
      updated_after: stringFlag(ctx.flags, "updated-after"),
      updated_before: stringFlag(ctx.flags, "updated-before"),
    };

    if (all) {
      const queryText = args.join(" ").trim() || stringFlag(ctx.flags, "q", "query") || "";
      const notebookFilter = stringFlag(ctx.flags, "notebook");
      const notebook = notebookFilter ? await resolveNotebookRef(ctx, api, notebookFilter) : null;
      const response = await api.search.$get({
        query: paginationQuery(ctx.flags, {
          q: queryText || undefined,
          notebook: notebook?.id,
          ...commonFilters,
        }),
      });
      const payload = await ctx.readJson<Page<NoteSearchHit>>(response);
      printJsonOrTable(
        ctx,
        payload,
        payload.data.map((hit) => ({
          id: hit.note.id,
          title: hit.note.title,
          notebook: hit.notebook.name,
          snippet: compactSearchSnippet(hit.snippet),
          updatedAt: hit.note.updatedAt,
        })),
        [
          { key: "id", label: "ID" },
          { key: "title", label: "TITLE" },
          { key: "notebook", label: "NOTEBOOK" },
          { key: "snippet", label: "MATCH" },
          { key: "updatedAt", label: "UPDATED" },
        ],
      );
      return 0;
    }

    const { notebookRef, rest } = await resolveNotebookArg(ctx, args, 1);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const queryText = rest.join(" ").trim() || stringFlag(ctx.flags, "q", "query") || "";
    const response = await api[":id"].search.$get({
      param: { id: notebook.id },
      query: paginationQuery(ctx.flags, { q: queryText || undefined, ...commonFilters }),
    });
    const payload = await ctx.readJson<Page<Note>>(response);
    printJsonOrTable(ctx, payload, noteRows(payload.data), [
      { key: "id", label: "ID" },
      { key: "title", label: "TITLE" },
      { key: "updatedAt", label: "UPDATED" },
    ]);
    return 0;
  }

  if (command === "read") {
    const { notebookRef, noteRef } = await resolveNoteCommandArgs(ctx, args);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const note = await resolveNoteRef(ctx, api, notebook.id, noteRef);
    const response = await api[":id"].notes[":noteId"].content.$get({ param: { id: notebook.id, noteId: note.id } });
    const payload = await ctx.readJson<NoteWithContent>(response);
    const content = payload.contentMd ?? "";
    const blocks = summarizeNoteEditBlocks(content);
    const result = {
      notebook,
      note: payload,
      content,
      contentHash: noteContentHash(content),
      lineCount: content.split("\n").length,
      blocks,
    };
    if (ctx.options.output === "json") {
      ctx.json(result);
      return 0;
    }
    ctx.print(`${payload.title} (${payload.id})`);
    ctx.print(`updated: ${payload.updatedAt}`);
    ctx.print(`hash: ${result.contentHash}`);
    if (booleanFlag(ctx.flags, "blocks")) printBlocks(ctx, blocks);
    ctx.print("");
    ctx.print(booleanFlag(ctx.flags, "number-lines", "numbered") ? formatNumberedLines(content) : content);
    return 0;
  }

  if (command === "block") {
    const { notebookRef, noteRef, rest } = await resolveNoteCommandArgs(ctx, args, 1);
    const name = requireArg(rest, 0, "block name").replace(/^@/, "");
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const note = await resolveNoteRef(ctx, api, notebook.id, noteRef);
    const payload = await ctx.readJson<NoteWithContent>(
      await api[":id"].notes[":noteId"].content.$get({ param: { id: notebook.id, noteId: note.id } }),
    );
    const content = payload.contentMd ?? "";
    const type = stringFlag(ctx.flags, "type") as NamedBlockType | undefined;
    const matches = findNamedBlocks(content, name, type);
    const index = numberFlag(ctx.flags, "index");
    if (matches.length === 0) throw new Error(`Named block @${name}${type ? ` (${type})` : ""} was not found.`);
    if (index === undefined && matches.length > 1) {
      throw new Error(`Named block @${name} is ambiguous (${matches.length} matches). Pass --index <n>.`);
    }
    const block = matches[index ?? 0];
    if (!block) throw new Error(`Named block @${name} index ${index} was not found.`);
    const body = namedBlockBody(content, block);
    const result = {
      notebook: { id: notebook.id, name: notebook.name },
      note: { id: note.id, title: note.title, updatedAt: note.updatedAt },
      block: {
        name: block.name,
        type: block.type,
        index: index ?? 0,
        startLine: block.startLine + 1,
        endLine: block.endLine + 1,
        hash: noteContentHash(body),
        content: body,
      },
    };
    if (!printStructured(ctx, result)) ctx.print(body);
    return 0;
  }

  if (command === "preview") {
    const hasDraft = stringFlag(ctx.flags, "content", "file", "f") !== undefined || booleanFlag(ctx.flags, "stdin");
    const markdown = hasDraft ? await readInputContent(ctx) : undefined;
    const { notebookRef, noteRef } = await resolveNoteCommandArgs(ctx, args);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const note = await resolveNoteRef(ctx, api, notebook.id, noteRef);
    const response = await api[":id"].notes[":noteId"]["block-preview"].$post({
      param: { id: notebook.id, noteId: note.id },
      json: markdown === undefined ? {} : { markdown },
    });
    const payload = await ctx.readJson<{
      markdown: string;
      blocks: { line: number; html: string }[];
      headings: { id: string; line: number }[];
      diagnostics: { line: number; message: string }[];
    }>(response);
    if (!printStructured(ctx, payload)) {
      ctx.print(`${payload.blocks.length} blocks, ${payload.headings.length} headings, ${payload.diagnostics.length} diagnostics.`);
      for (const diagnostic of payload.diagnostics) ctx.print(`Line ${diagnostic.line}: ${diagnostic.message}`);
    }
    return payload.diagnostics.length > 0 ? 1 : 0;
  }

  if (command === "edit") {
    const { notebookRef, noteRef } = await resolveNoteCommandArgs(ctx, args);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const note = await resolveNoteRef(ctx, api, notebook.id, noteRef);
    const operation = await buildEditOperation(ctx);
    const request = {
      operations: [operation],
      ifUpdatedAt: stringFlag(ctx.flags, "if-updated-at"),
      ifContentHash: stringFlag(ctx.flags, "if-content-hash"),
      ifBlockHash: stringFlag(ctx.flags, "if-block-hash"),
    };

    if (booleanFlag(ctx.flags, "dry-run")) {
      const response = await api[":id"].notes[":noteId"].content.$get({ param: { id: notebook.id, noteId: note.id } });
      const payload = await ctx.readJson<NoteWithContent>(response);
      if (request.ifUpdatedAt !== undefined && request.ifUpdatedAt !== payload.updatedAt) {
        throw new Error("Note updatedAt changed; read the note again before editing.");
      }
      const edit = applyNoteEdits(payload.contentMd ?? "", request.operations, {
        ifContentHash: request.ifContentHash,
        ifBlockHash: request.ifBlockHash,
      });
      if (!printStructured(ctx, { note: payload, ...edit })) {
        ctx.print(`Dry run for ${payload.title} (${payload.id})`);
        ctx.print(`${edit.beforeHash} -> ${edit.afterHash}`);
        printBlocks(ctx, edit.blocks);
      }
      return 0;
    }

    const response = await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/notes/${encodeURIComponent(note.id)}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    const payload = await ctx.readJson<NoteEditResponse>(response);
    if (!printStructured(ctx, payload)) {
      ctx.print(`${payload.changed ? "Edited" : "No changes"} ${payload.note.title} (${payload.note.id}).`);
      ctx.print(`${payload.beforeHash} -> ${payload.afterHash}`);
    }
    return 0;
  }

  if (command === "note") {
    const { notebookRef, noteRef } = await resolveNoteCommandArgs(ctx, args);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const note = await resolveNoteRef(ctx, api, notebook.id, noteRef);
    const response = booleanFlag(ctx.flags, "content")
      ? await api[":id"].notes[":noteId"].content.$get({ param: { id: notebook.id, noteId: note.id } })
      : await api[":id"].notes[":noteId"].$get({ param: { id: notebook.id, noteId: note.id } });
    const payload = await ctx.readJson<Note | NoteWithContent>(response);
    if (!printStructured(ctx, payload)) {
      ctx.print(`${payload.title} (${payload.id})`);
      ctx.print(`id: ${payload.id}`);
      if ("contentMd" in payload && payload.contentMd) {
        ctx.print("");
        ctx.print(payload.contentMd);
      }
    }
    return 0;
  }

  if (command === "content") {
    const { notebookRef, noteRef } = await resolveNoteCommandArgs(ctx, args);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const note = await resolveNoteRef(ctx, api, notebook.id, noteRef);
    const response = await api[":id"].notes[":noteId"].content.$get({ param: { id: notebook.id, noteId: note.id } });
    const payload = await ctx.readJson<NoteWithContent>(response);
    if (!printStructured(ctx, payload)) ctx.print(payload.contentMd ?? "");
    return 0;
  }

  if (command === "move-note") {
    const { notebookRef, noteRef } = await resolveNoteCommandArgs(ctx, args);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const note = await resolveNoteRef(ctx, api, notebook.id, noteRef);
    const parentRef = stringFlag(ctx.flags, "parent", "parent-id");
    const parent = parentRef ? await resolveNoteRef(ctx, api, notebook.id, parentRef) : null;
    const payload = await ctx.readJson<Note>(
      await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/notes/${encodeURIComponent(note.id)}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentId: parent?.id ?? null, position: numberFlag(ctx.flags, "position") ?? note.position }),
      }),
    );
    if (!printStructured(ctx, payload)) ctx.print(`Moved ${payload.title} (${payload.id}).`);
    return 0;
  }

  if (command === "copy-note") {
    const { notebookRef, noteRef } = await resolveNoteCommandArgs(ctx, args);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const note = await resolveNoteRef(ctx, api, notebook.id, noteRef);
    const targetRef = stringFlag(ctx.flags, "target-notebook");
    if (!targetRef) throw new Error("Missing --target-notebook.");
    const target = await resolveNotebookRef(ctx, api, targetRef);
    const parentRef = stringFlag(ctx.flags, "parent", "parent-id");
    const parent = parentRef ? await resolveNoteRef(ctx, api, target.id, parentRef) : null;
    const payload = await ctx.readJson<Note>(
      await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/notes/${encodeURIComponent(note.id)}/copy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetNotebookId: target.id, targetParentId: parent?.id ?? null }),
      }),
    );
    if (!printStructured(ctx, payload)) ctx.print(`Copied ${note.title} to ${target.name} as ${payload.id}.`);
    return 0;
  }

  if (command === "delete-note") {
    if (!booleanFlag(ctx.flags, "yes")) throw new Error("Refusing to delete a note and its children without --yes.");
    const { notebookRef, noteRef } = await resolveNoteCommandArgs(ctx, args);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const note = await resolveNoteRef(ctx, api, notebook.id, noteRef);
    const payload = await ctx.readJson<MessageResponse>(
      await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/notes/${encodeURIComponent(note.id)}`, {
        method: "DELETE",
      }),
    );
    if (!printStructured(ctx, payload)) ctx.print(payload.message);
    return 0;
  }

  if (command === "lock-note") {
    if (!booleanFlag(ctx.flags, "yes")) throw new Error("Refusing to permanently lock a note without --yes.");
    const { notebookRef, noteRef } = await resolveNoteCommandArgs(ctx, args);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const note = await resolveNoteRef(ctx, api, notebook.id, noteRef);
    const payload = await ctx.readJson<Note>(
      await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/notes/${encodeURIComponent(note.id)}/lock`, {
        method: "POST",
      }),
    );
    if (!printStructured(ctx, payload)) ctx.print(`Locked ${payload.title} (${payload.id}).`);
    return 0;
  }

  if (command === "favorite" || command === "unfavorite") {
    const { notebookRef, noteRef } = await resolveNoteCommandArgs(ctx, args);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const note = await resolveNoteRef(ctx, api, notebook.id, noteRef);
    const favorite = command === "favorite";
    const payload = await ctx.readJson<{ favorite: boolean }>(
      await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/notes/${encodeURIComponent(note.id)}/favorite`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ favorite }),
      }),
    );
    if (!printStructured(ctx, payload)) ctx.print(`${favorite ? "Favorited" : "Unfavorited"} ${note.title} (${note.id}).`);
    return 0;
  }

  if (command === "favorites") {
    const { notebookRef } = await resolveNotebookArg(ctx, args, 0);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const payload = await ctx.readJson<{ noteId: string; createdAt: string }[]>(
      await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/favorites`),
    );
    printJsonOrTable(ctx, payload, payload, [
      { key: "noteId", label: "NOTE ID" },
      { key: "createdAt", label: "CREATED" },
    ]);
    return 0;
  }

  if (command === "backlinks") {
    const { notebookRef, noteRef } = await resolveNoteCommandArgs(ctx, args);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const note = await resolveNoteRef(ctx, api, notebook.id, noteRef);
    const payload = await ctx.readJson<{ data: Array<Record<string, unknown>> }>(
      await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/notes/${encodeURIComponent(note.id)}/backlinks`),
    );
    if (ctx.options.output === "json") ctx.json(payload);
    else
      ctx.table(payload.data, [
        { key: "noteId", label: "ID" },
        { key: "title", label: "TITLE" },
        { key: "notebookName", label: "NOTEBOOK" },
        { key: "updatedAt", label: "UPDATED" },
      ]);
    return 0;
  }

  if (command === "comments") {
    const { notebookRef, noteRef } = await resolveNoteCommandArgs(ctx, args);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const note = await resolveNoteRef(ctx, api, notebook.id, noteRef);
    const query = paginationQuery(ctx.flags);
    const search = new URLSearchParams(query).toString();
    const payload = await ctx.readJson<NoteCommentPage>(
      await ctx.fetch(
        `/api/notebooks/${encodeURIComponent(notebook.id)}/notes/${encodeURIComponent(note.id)}/comments/page${search ? `?${search}` : ""}`,
      ),
    );
    printJsonOrTable(
      ctx,
      payload,
      payload.items.map((comment) => ({
        id: comment.id,
        author: comment.authorDisplayName,
        content: comment.content.replace(/\s+/g, " ").slice(0, 120),
        createdAt: comment.createdAt,
      })),
      [
        { key: "id", label: "ID" },
        { key: "author", label: "AUTHOR" },
        { key: "content", label: "COMMENT" },
        { key: "createdAt", label: "CREATED" },
      ],
    );
    return 0;
  }

  if (command === "add-comment") {
    const { notebookRef, noteRef } = await resolveNoteCommandArgs(ctx, args);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const note = await resolveNoteRef(ctx, api, notebook.id, noteRef);
    const content = await readInputContent(ctx);
    const payload = await ctx.readJson<NoteComment>(
      await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/notes/${encodeURIComponent(note.id)}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      }),
    );
    if (!printStructured(ctx, payload)) ctx.print(`Added comment ${payload.id} to ${note.title}.`);
    return 0;
  }

  if (command === "update-comment") {
    const { notebookRef, noteRef, rest } = await resolveNoteCommandArgs(ctx, args, 1);
    const commentId = requireArg(rest, 0, "comment");
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const note = await resolveNoteRef(ctx, api, notebook.id, noteRef);
    const content = await readInputContent(ctx);
    const payload = await ctx.readJson<NoteComment>(
      await ctx.fetch(
        `/api/notebooks/${encodeURIComponent(notebook.id)}/notes/${encodeURIComponent(note.id)}/comments/${encodeURIComponent(commentId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        },
      ),
    );
    if (!printStructured(ctx, payload)) ctx.print(`Updated comment ${payload.id}.`);
    return 0;
  }

  if (command === "delete-comment") {
    if (!booleanFlag(ctx.flags, "yes")) throw new Error("Refusing to delete a comment without --yes.");
    const { notebookRef, noteRef, rest } = await resolveNoteCommandArgs(ctx, args, 1);
    const commentId = requireArg(rest, 0, "comment");
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const note = await resolveNoteRef(ctx, api, notebook.id, noteRef);
    const payload = await ctx.readJson<MessageResponse>(
      await ctx.fetch(
        `/api/notebooks/${encodeURIComponent(notebook.id)}/notes/${encodeURIComponent(note.id)}/comments/${encodeURIComponent(commentId)}`,
        { method: "DELETE" },
      ),
    );
    if (!printStructured(ctx, payload)) ctx.print(payload.message);
    return 0;
  }

  if (command === "graph") {
    const { notebookRef } = await resolveNotebookArg(ctx, args, 0);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const payload = await ctx.readJson<unknown>(await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/graph`));
    ctx.json(payload);
    return 0;
  }

  if (command === "create-note") {
    const { notebookRef } = await resolveNotebookArg(ctx, args, 0);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const parentRef = stringFlag(ctx.flags, "parent", "parent-id");
    const parent = parentRef ? await resolveNoteRef(ctx, api, notebook.id, parentRef) : null;
    const content = await readInputContent(ctx, false);
    const response = await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parentId: parent?.id,
        contentMd: content || undefined,
      }),
    });
    const payload = await ctx.readJson<Note>(response);
    if (!printStructured(ctx, payload)) ctx.print(`Created ${payload.title} (${payload.id}).`);
    return 0;
  }

  if (command === "versions") {
    const { notebookRef, noteRef } = await resolveNoteCommandArgs(ctx, args);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const note = await resolveNoteRef(ctx, api, notebook.id, noteRef);
    const response = await api[":id"].notes[":noteId"].versions.$get({
      param: { id: notebook.id, noteId: note.id },
      query: paginationQuery(ctx.flags),
    });
    const payload = await ctx.readJson<Page<NoteVersion>>(response);
    printJsonOrTable(ctx, payload, payload.data, [
      { key: "createdAt", label: "CREATED" },
      { key: "id", label: "ID" },
    ]);
    return 0;
  }

  if (command === "version") {
    const { notebookRef, noteRef, rest } = await resolveNoteCommandArgs(ctx, args, 1);
    const versionId = requireArg(rest, 0, "version id");
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const note = await resolveNoteRef(ctx, api, notebook.id, noteRef);
    const response = booleanFlag(ctx.flags, "content")
      ? await api[":id"].notes[":noteId"].versions[":versionId"].content.$get({
          param: { id: notebook.id, noteId: note.id, versionId },
        })
      : await api[":id"].notes[":noteId"].versions[":versionId"].$get({
          param: { id: notebook.id, noteId: note.id, versionId },
        });
    const payload = await ctx.readJson<unknown>(response);
    ctx.json(payload);
    return 0;
  }

  if (command === "restore-version") {
    const { notebookRef, noteRef, rest } = await resolveNoteCommandArgs(ctx, args, 1);
    const versionId = requireArg(rest, 0, "version id");
    const targetRef = stringFlag(ctx.flags, "target");
    if (!targetRef) throw new Error("Missing --target <empty-note>.");
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const source = await resolveNoteRef(ctx, api, notebook.id, noteRef);
    const target = await resolveNoteRef(ctx, api, notebook.id, targetRef);
    const version = await ctx.readJson<{ yjsSnapshot: string; contentMd: string | null }>(
      await api[":id"].notes[":noteId"].versions[":versionId"].content.$get({
        param: { id: notebook.id, noteId: source.id, versionId },
      }),
    );
    const payload = await ctx.readJson<Note>(
      await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/notes/${encodeURIComponent(target.id)}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yjsSnapshot: version.yjsSnapshot }),
      }),
    );
    if (!printStructured(ctx, payload)) ctx.print(`Restored version ${versionId} from ${source.title} into ${target.title}.`);
    return 0;
  }

  if (command === "tags") {
    const { notebookRef } = await resolveNotebookArg(ctx, args, 0);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const payload = await ctx.readJson<{ tag: string; count: number }[]>(
      await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/tags`),
    );
    printJsonOrTable(ctx, payload, payload, [
      { key: "tag", label: "TAG" },
      { key: "count", label: "NOTES" },
    ]);
    return 0;
  }

  if (command === "tag-notes") {
    const { notebookRef, rest } = await resolveNotebookArg(ctx, args, 1);
    const tag = requireArg(rest, 0, "tag").replace(/^#/, "");
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const payload = await ctx.readJson<Page<Note>>(
      await api[":id"].search.$get({
        param: { id: notebook.id },
        query: paginationQuery(ctx.flags, { tags: tag }),
      }),
    );
    printJsonOrTable(ctx, payload, noteRows(payload.data), [
      { key: "id", label: "ID" },
      { key: "title", label: "TITLE" },
      { key: "updatedAt", label: "UPDATED" },
    ]);
    return 0;
  }

  if (command === "attachments") {
    const { notebookRef } = await resolveNotebookArg(ctx, args, 0);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const payload = await ctx.readJson<Attachment[]>(await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/attachments`));
    printJsonOrTable(ctx, payload, payload, [
      { key: "id", label: "ID" },
      { key: "filename", label: "FILE" },
      { key: "mimeType", label: "TYPE" },
      { key: "sizeBytes", label: "BYTES" },
      { key: "createdAt", label: "CREATED" },
    ]);
    return 0;
  }

  if (command === "attachment") {
    const { notebookRef, rest } = await resolveNotebookArg(ctx, args, 1);
    const attachmentRef = requireArg(rest, 0, "attachment");
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const payload = await ctx.readJson<Attachment>(
      await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/attachments/${encodeURIComponent(attachmentRef)}`),
    );
    if (!printStructured(ctx, payload)) {
      ctx.print(`${payload.filename} (${payload.id})`);
      ctx.print(`${payload.mimeType} · ${payload.sizeBytes} bytes · ${payload.createdAt}`);
    }
    return 0;
  }

  if (command === "upload-attachment") {
    const { notebookRef, rest } = await resolveNotebookArg(ctx, args, 1);
    const path = requireArg(rest, 0, "file path");
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const form = new FormData();
    form.append("file", Bun.file(path), basename(path));
    const payload = await ctx.readJson<Attachment>(
      await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/attachments`, { method: "POST", body: form }),
    );
    if (!printStructured(ctx, payload)) ctx.print(`Uploaded ${payload.filename} as attach://${payload.id}.`);
    return 0;
  }

  if (command === "download-attachment") {
    const { notebookRef, rest } = await resolveNotebookArg(ctx, args, 1);
    const attachmentRef = requireArg(rest, 0, "attachment");
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const metadata = await ctx.readJson<Attachment>(
      await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/attachments/${encodeURIComponent(attachmentRef)}`),
    );
    const output = stringFlag(ctx.flags, "output-file", "out") ?? metadata.filename;
    const response = await ctx.fetch(
      `/api/notebooks/${encodeURIComponent(notebook.id)}/attachments/${encodeURIComponent(metadata.id)}/content`,
    );
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    await Bun.write(output, response);
    if (!printStructured(ctx, { attachment: metadata, output })) ctx.print(`Saved ${metadata.filename} to ${output}.`);
    return 0;
  }

  if (command === "attachment-usage") {
    const { notebookRef, rest } = await resolveNotebookArg(ctx, args, 1);
    const attachmentRef = requireArg(rest, 0, "attachment");
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const payload = await ctx.readJson<{ count: number }>(
      await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/attachments/${encodeURIComponent(attachmentRef)}/usage`),
    );
    if (!printStructured(ctx, payload)) ctx.print(String(payload.count));
    return 0;
  }

  if (command === "delete-attachment") {
    if (!booleanFlag(ctx.flags, "yes")) throw new Error("Refusing to delete an attachment without --yes.");
    const { notebookRef, rest } = await resolveNotebookArg(ctx, args, 1);
    const attachmentRef = requireArg(rest, 0, "attachment");
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const payload = await ctx.readJson<MessageResponse>(
      await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/attachments/${encodeURIComponent(attachmentRef)}`, {
        method: "DELETE",
      }),
    );
    if (!printStructured(ctx, payload)) ctx.print(payload.message);
    return 0;
  }

  if (command === "export") {
    const { notebookRef } = await resolveNotebookArg(ctx, args, 0);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const output = stringFlag(ctx.flags, "output-file", "out") ?? `${notebook.name.replace(/[^a-zA-Z0-9._-]+/g, "-")}.zip`;
    const response = await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/export.zip`);
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    await Bun.write(output, response);
    if (!printStructured(ctx, { notebook, output })) ctx.print(`Exported ${notebook.name} to ${output}.`);
    return 0;
  }

  if (command === "api-keys") {
    const { notebookRef } = await resolveNotebookArg(ctx, args, 0);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const payload = await ctx.readJson<{ items: ApiKey[] }>(await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/api-keys`));
    printJsonOrTable(ctx, payload, payload.items, [
      { key: "id", label: "ID" },
      { key: "name", label: "NAME" },
      { key: "permission", label: "PERMISSION" },
      { key: "tokenPrefix", label: "PREFIX" },
      { key: "lastUsedAt", label: "LAST USED" },
    ]);
    return 0;
  }

  if (command === "create-api-key") {
    const { notebookRef, rest } = await resolveNotebookArg(ctx, args, 1);
    const name = requireArg(rest, 0, "API key name");
    const permission = stringFlag(ctx.flags, "permission") ?? "read";
    if (!new Set(["read", "write", "admin"]).has(permission)) throw new Error("--permission must be read, write, or admin.");
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const payload = await ctx.readJson<{ credential: ApiKey; token: string }>(
      await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/api-keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, permission, expiresAt: stringFlag(ctx.flags, "expires-at") ?? null }),
      }),
    );
    if (!printStructured(ctx, payload)) {
      ctx.print(`Created ${payload.credential.name} (${payload.credential.id}).`);
      ctx.print(payload.token);
    }
    return 0;
  }

  if (command === "revoke-api-key") {
    if (!booleanFlag(ctx.flags, "yes")) throw new Error("Refusing to revoke an API key without --yes.");
    const { notebookRef, rest } = await resolveNotebookArg(ctx, args, 1);
    const credentialId = requireArg(rest, 0, "credential id");
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const payload = await ctx.readJson<MessageResponse>(
      await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/api-keys/${encodeURIComponent(credentialId)}`, {
        method: "DELETE",
      }),
    );
    if (!printStructured(ctx, payload)) ctx.print(payload.message);
    return 0;
  }

  if (command === "snapshot") {
    const { notebookRef } = await resolveNotebookArg(ctx, args, 0);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const payload = await ctx.readJson<SnapshotConfig>(
      await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/snapshots/config`),
    );
    ctx.json(payload);
    return 0;
  }

  if (command === "update-snapshot") {
    const { notebookRef } = await resolveNotebookArg(ctx, args, 0);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const current = await ctx.readJson<SnapshotConfig>(
      await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/snapshots/config`),
    );
    const enabled = optionalBooleanFlag(ctx.flags, "enabled") ?? current.enabled;
    const payload = await ctx.readJson<SnapshotConfig>(
      await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/snapshots/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          endpoint: stringFlag(ctx.flags, "endpoint"),
          region: stringFlag(ctx.flags, "region"),
          bucket: stringFlag(ctx.flags, "bucket"),
          accessKeyId: stringFlag(ctx.flags, "access-key-id"),
          secretAccessKey: stringFlag(ctx.flags, "secret-access-key"),
        }),
      }),
    );
    ctx.json(payload);
    return 0;
  }

  if (command === "snapshot-logs") {
    const { notebookRef } = await resolveNotebookArg(ctx, args, 0);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const payload = await ctx.readJson<Array<Record<string, unknown>>>(
      await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/snapshots/logs`),
    );
    if (ctx.options.output === "json") ctx.json(payload);
    else
      ctx.table(payload, [
        { key: "createdAt", label: "TIME" },
        { key: "level", label: "LEVEL" },
        { key: "message", label: "MESSAGE" },
      ]);
    return 0;
  }

  if (command === "run-snapshot") {
    const { notebookRef } = await resolveNotebookArg(ctx, args, 0);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    const payload = await ctx.readJson<unknown>(
      await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/snapshots/run`, { method: "POST" }),
    );
    ctx.json(payload);
    return 0;
  }

  throw new Error(`Unknown notebooks command "${command}". Run \`cld notebooks help\`.`);
};

const paginationFlagSpecs = {
  page: flag.int({ min: 1, description: "Page number" }),
  perPage: flag.int({ name: "per-page", aliases: ["per_page"], min: 1, description: "Items per page" }),
};

const notebookFlag = {
  notebook: flag.string({ description: "Notebook short id or exact name" }),
};

const noteFlag = {
  note: flag.string({ description: "Note short id or exact title" }),
};

const notebookArgs = {
  args: arg.rest({ valueLabel: "notebook-or-args", description: "Optional leading notebook followed by command arguments." }),
};

const noteArgs = {
  args: arg.rest({ valueLabel: "notebook-note-args", description: "Optional leading notebook, note, and command-specific arguments." }),
};

const notebookAccessCommands = createAccessCommands({
  resourceLabel: "notebook",
  resourceArgLabel: "notebook",
  resourceArgDescription: "Optional notebook short id or exact name. If omitted, the default from `cld notebooks use` is used.",
  resolveResource: async (ctx, args) => {
    const api = ctx.createApiClient<ApiType>("/api/notebooks");
    const { notebookRef } = await resolveNotebookArg(ctx, args, 0);
    const notebook = await resolveNotebookRef(ctx, api, notebookRef);
    return {
      ...notebook,
      label: `${notebook.name} (${notebook.id})`,
    };
  },
  list: async (ctx, notebook) => ctx.readJson<AccessEntry[]>(await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/access`)),
  grant: async (ctx, notebook, principal: Principal, permission: PermissionLevel) =>
    ctx.readJson<AccessEntry>(
      await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ principal, permission }),
      }),
    ),
  update: async (ctx, notebook, accessId, permission) => {
    await ctx.readJson<MessageResponse>(
      await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/access/${encodeURIComponent(accessId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permission }),
      }),
    );
  },
  revoke: async (ctx, notebook, accessId) => {
    await ctx.readJson<MessageResponse>(
      await ctx.fetch(`/api/notebooks/${encodeURIComponent(notebook.id)}/access/${encodeURIComponent(accessId)}`, {
        method: "DELETE",
      }),
    );
  },
  examples: {
    list: ['cld notebooks access list "Product Notes"', "cld notebooks access list nhTHpc --include-service-accounts"],
    grant: [
      'cld notebooks access grant "Product Notes" --user valentin.kolb --permission read',
      'cld notebooks access grant "Product Notes" --group "Editors" --permission write',
      'cld notebooks access grant "Product Notes" --authenticated --permission read',
    ],
    set: [
      'cld notebooks access set "Product Notes" --user valentin.kolb --permission admin',
      "cld notebooks access set nhTHpc --access-id 00000000-0000-4000-8000-000000000000 --permission write",
    ],
    revoke: [
      'cld notebooks access revoke "Product Notes" --user valentin.kolb --yes',
      "cld notebooks access revoke nhTHpc --access-id 00000000-0000-4000-8000-000000000000 --yes",
    ],
    searchPrincipals: [
      "cld notebooks access search-principals val --kind user,group",
      'cld notebooks access search-principals "Editors" --kind group',
    ],
  },
});

const editFlags = {
  ...notebookFlag,
  ...noteFlag,
  content: flag.string({ description: "Markdown content" }),
  file: flag.string({ aliases: ["f"], description: "Read markdown content from file" }),
  stdin: flag.boolean({ description: "Read markdown content from stdin" }),
  replaceLines: flag.string({ name: "replace-lines", description: "Replace 1-based inclusive line range start:end" }),
  deleteLines: flag.string({ name: "delete-lines", description: "Delete 1-based inclusive line range start:end" }),
  insertBeforeLine: flag.string({ name: "insert-before-line", description: "Insert before a 1-based line" }),
  insertAfterLine: flag.string({ name: "insert-after-line", description: "Insert after a 1-based line" }),
  replaceBlock: flag.string({ name: "replace-block", description: "Replace a named block body" }),
  appendBlock: flag.string({ name: "append-block", description: "Append to a named block" }),
  prependBlock: flag.string({ name: "prepend-block", description: "Prepend to a named block" }),
  append: flag.boolean({ description: "Append markdown to the note" }),
  prepend: flag.boolean({ description: "Prepend markdown to the note" }),
  setContent: flag.boolean({ name: "set-content", description: "Replace the complete note body" }),
  type: flag.string({ description: "Restrict named block type" }),
  index: flag.int({ min: 0, description: "Select duplicate named block by 0-based index" }),
  includeHandle: flag.boolean({ name: "include-handle", description: "Replace the named block handle too" }),
  ifUpdatedAt: flag.string({ name: "if-updated-at", description: "Reject if note updatedAt changed" }),
  ifContentHash: flag.string({ name: "if-content-hash", description: "Reject if full content changed" }),
  ifBlockHash: flag.string({ name: "if-block-hash", description: "Reject if selected block body changed" }),
  dryRun: flag.boolean({ name: "dry-run", description: "Apply locally and print edit metadata" }),
};

export default defineCliCommands({
  name: "notebooks",
  summary: "Manage notebooks, notes, discussions, search, attachments, access, exports, and snapshots.",
  groupSummaries: {
    access: "Manage direct access to notebooks",
  },
  commands: [
    command("list", {
      summary: "List notebooks",
      flags: {
        q: flag.string({ aliases: ["query"], description: "Search query" }),
        ...paginationFlagSpecs,
      },
      run: ({ ctx }) => runNotebooksCommand(ctx, "list", []),
    }),
    command("use", {
      summary: "Set the default notebook",
      args: {
        notebook: arg.required({ description: "Notebook short id or exact name" }),
      },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "use", [args.notebook]),
    }),
    command("current", {
      summary: "Show the default notebook",
      run: ({ ctx }) => runNotebooksCommand(ctx, "current", []),
    }),
    command("get", {
      summary: "Show a notebook",
      args: notebookArgs,
      flags: notebookFlag,
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "get", args.args),
    }),
    command("create", {
      summary: "Create a notebook",
      args: {
        name: arg.required({ description: "Notebook name" }),
      },
      flags: {
        description: flag.string({ description: "Notebook description" }),
        icon: flag.string({ description: "Notebook icon" }),
        use: flag.boolean({ description: "Use the new notebook as default" }),
      },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "create", [args.name]),
    }),
    command("update", {
      summary: "Update notebook settings",
      args: notebookArgs,
      flags: {
        ...notebookFlag,
        name: flag.string({ description: "Notebook name" }),
        description: flag.string({ description: "Notebook description" }),
        clearDescription: flag.boolean({ name: "clear-description", description: "Clear the description" }),
        icon: flag.string({ description: "Notebook icon" }),
        clearIcon: flag.boolean({ name: "clear-icon", description: "Clear the icon" }),
        homepage: flag.string({ description: "Homepage note short id, exact title, or path" }),
        clearHomepage: flag.boolean({ name: "clear-homepage", description: "Clear the homepage note" }),
        defaultNoteTitleTemplate: flag.string({
          name: "default-note-title-template",
          description: "Liquid template used for the initial H1 of empty notes",
        }),
        defaultPresentationMode: flag.enum(PRESENTATION_MODES, {
          name: "default-presentation-mode",
          description: "Default view for editors and admins; readers always use Book",
        }),
      },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "update", args.args),
    }),
    command("delete", {
      summary: "Delete a notebook and all of its content",
      args: notebookArgs,
      flags: { ...notebookFlag, yes: confirmFlag("Delete this notebook") },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "delete", args.args),
    }),
    command("templates", {
      summary: "List built-in notebook templates",
      run: ({ ctx }) => runNotebooksCommand(ctx, "templates", []),
    }),
    command("create-from-template", {
      summary: "Create a notebook from a built-in template",
      args: { template: arg.required({ description: "Template id" }) },
      flags: {
        name: flag.string({ description: "Override the notebook name" }),
        use: flag.boolean({ description: "Use the new notebook as default" }),
      },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "create-from-template", [args.template]),
    }),
    ...notebookAccessCommands,
    command("tree", {
      summary: "Show a notebook note tree",
      args: notebookArgs,
      flags: notebookFlag,
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "tree", args.args),
    }),
    command("notes", {
      summary: "List notes in a notebook",
      args: notebookArgs,
      flags: {
        ...notebookFlag,
        q: flag.string({ aliases: ["query"], description: "Search query" }),
        parent: flag.string({ aliases: ["parent-id"], description: "Parent note short id" }),
        ...paginationFlagSpecs,
      },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "notes", args.args),
    }),
    command("search", {
      summary: "Search notes with full-text, tag, and timestamp filters",
      args: {
        args: arg.rest({ valueLabel: "notebook-query-args", description: "Optional leading notebook and search query." }),
      },
      flags: {
        ...notebookFlag,
        all: flag.boolean({ description: "Search every accessible notebook" }),
        q: flag.string({ aliases: ["query"], description: "Search query" }),
        tags: flag.string({ aliases: ["tag"], description: "Comma-separated tags; all must match" }),
        createdAfter: flag.string({ name: "created-after", description: "Created at or after this ISO timestamp" }),
        createdBefore: flag.string({ name: "created-before", description: "Created at or before this ISO timestamp" }),
        updatedAfter: flag.string({ name: "updated-after", description: "Updated at or after this ISO timestamp" }),
        updatedBefore: flag.string({ name: "updated-before", description: "Updated at or before this ISO timestamp" }),
        ...paginationFlagSpecs,
      },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "search", args.args),
    }),
    command("read", {
      summary: "Read note markdown content",
      args: noteArgs,
      flags: {
        ...notebookFlag,
        ...noteFlag,
        numberLines: flag.boolean({ name: "number-lines", aliases: ["numbered"], description: "Print line numbers" }),
        blocks: flag.boolean({ description: "Print named block summaries" }),
      },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "read", args.args),
    }),
    command("block", {
      summary: "Read one named Markdown block with stable hash metadata",
      args: {
        args: arg.rest({ valueLabel: "notebook-note-block", description: "Optional notebook, note, and required block name." }),
      },
      flags: {
        ...notebookFlag,
        ...noteFlag,
        type: flag.string({ description: "Restrict named block type" }),
        index: flag.int({ min: 0, description: "Select a duplicate block by 0-based index" }),
      },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "block", args.args),
    }),
    command("preview", {
      summary: "Preview query and TOC blocks without saving; diagnostics return exit code 1",
      args: noteArgs,
      flags: {
        ...notebookFlag,
        ...noteFlag,
        content: flag.string({ description: "Draft Markdown; requires write access and an unlocked note" }),
        file: flag.string({ aliases: ["f"], description: "Read draft Markdown from file" }),
        stdin: flag.boolean({ description: "Read draft Markdown from stdin; omit draft input to preview saved content" }),
      },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "preview", args.args),
    }),
    command("edit", {
      summary: "Edit note markdown content",
      args: noteArgs,
      flags: editFlags,
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "edit", args.args),
    }),
    command("note", {
      summary: "Show note metadata, optionally with content",
      args: noteArgs,
      flags: {
        ...notebookFlag,
        ...noteFlag,
        content: flag.boolean({ description: "Include note content" }),
      },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "note", args.args),
    }),
    command("content", {
      summary: "Print note markdown content",
      args: noteArgs,
      flags: {
        ...notebookFlag,
        ...noteFlag,
      },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "content", args.args),
    }),
    command("move-note", {
      summary: "Move a note to another parent or the notebook root",
      args: noteArgs,
      flags: {
        ...notebookFlag,
        ...noteFlag,
        parent: flag.string({ aliases: ["parent-id"], description: "Parent note short id, exact title, or path" }),
        position: flag.int({ min: 0, description: "0-based sibling position" }),
      },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "move-note", args.args),
    }),
    command("copy-note", {
      summary: "Copy a note to another notebook",
      args: noteArgs,
      flags: {
        ...notebookFlag,
        ...noteFlag,
        targetNotebook: flag.string({ name: "target-notebook", description: "Target notebook short id or exact name" }),
        parent: flag.string({ aliases: ["parent-id"], description: "Target parent note short id, exact title, or path" }),
      },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "copy-note", args.args),
    }),
    command("delete-note", {
      summary: "Delete a note and all of its children",
      args: noteArgs,
      flags: { ...notebookFlag, ...noteFlag, yes: confirmFlag("Delete this note and its children") },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "delete-note", args.args),
    }),
    command("lock-note", {
      summary: "Permanently lock a note",
      args: noteArgs,
      flags: { ...notebookFlag, ...noteFlag, yes: confirmFlag("Permanently lock this note") },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "lock-note", args.args),
    }),
    command("favorite", {
      summary: "Favorite a note for the current user",
      args: noteArgs,
      flags: { ...notebookFlag, ...noteFlag },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "favorite", args.args),
    }),
    command("unfavorite", {
      summary: "Remove a note from the current user's favorites",
      args: noteArgs,
      flags: { ...notebookFlag, ...noteFlag },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "unfavorite", args.args),
    }),
    command("favorites", {
      summary: "List favorite note ids",
      args: notebookArgs,
      flags: notebookFlag,
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "favorites", args.args),
    }),
    command("backlinks", {
      summary: "List notes linking to a note",
      args: noteArgs,
      flags: { ...notebookFlag, ...noteFlag },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "backlinks", args.args),
    }),
    command("comments", {
      summary: "List comments on a note",
      args: noteArgs,
      flags: { ...notebookFlag, ...noteFlag, ...paginationFlagSpecs },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "comments", args.args),
    }),
    command("add-comment", {
      summary: "Add a Markdown comment to a note",
      args: noteArgs,
      flags: {
        ...notebookFlag,
        ...noteFlag,
        content: flag.string({ description: "Comment Markdown" }),
        file: flag.string({ aliases: ["f"], description: "Read comment Markdown from file" }),
        stdin: flag.boolean({ description: "Read comment Markdown from stdin" }),
      },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "add-comment", args.args),
    }),
    command("update-comment", {
      summary: "Update your recent note comment",
      args: {
        args: arg.rest({ valueLabel: "notebook-note-comment", description: "Optional notebook, note, and required comment id." }),
      },
      flags: {
        ...notebookFlag,
        ...noteFlag,
        content: flag.string({ description: "Comment Markdown" }),
        file: flag.string({ aliases: ["f"], description: "Read comment Markdown from file" }),
        stdin: flag.boolean({ description: "Read comment Markdown from stdin" }),
      },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "update-comment", args.args),
    }),
    command("delete-comment", {
      summary: "Delete your recent note comment",
      args: {
        args: arg.rest({ valueLabel: "notebook-note-comment", description: "Optional notebook, note, and required comment id." }),
      },
      flags: { ...notebookFlag, ...noteFlag, yes: confirmFlag("Delete this comment") },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "delete-comment", args.args),
    }),
    command("graph", {
      summary: "Print the notebook note-link graph as JSON",
      args: notebookArgs,
      flags: notebookFlag,
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "graph", args.args),
    }),
    command("create-note", {
      summary: "Create a note",
      args: notebookArgs,
      flags: {
        ...notebookFlag,
        parent: flag.string({ aliases: ["parent-id"], description: "Parent note short id, exact title, or path" }),
        content: flag.string({ description: "Initial markdown content" }),
        file: flag.string({ aliases: ["f"], description: "Read initial markdown from file" }),
        stdin: flag.boolean({ description: "Read initial markdown from stdin" }),
      },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "create-note", args.args),
    }),
    command("versions", {
      summary: "List note versions",
      args: noteArgs,
      flags: {
        ...notebookFlag,
        ...noteFlag,
        ...paginationFlagSpecs,
      },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "versions", args.args),
    }),
    command("version", {
      summary: "Show a note version",
      args: noteArgs,
      flags: {
        ...notebookFlag,
        ...noteFlag,
        content: flag.boolean({ description: "Show version content" }),
      },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "version", args.args),
    }),
    command("restore-version", {
      summary: "Restore a version into an existing empty note",
      args: {
        args: arg.rest({ valueLabel: "notebook-note-version", description: "Optional notebook, source note, and version id." }),
      },
      flags: {
        ...notebookFlag,
        ...noteFlag,
        target: flag.string({ description: "Empty target note short id, exact title, or path" }),
      },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "restore-version", args.args),
    }),
    command("tags", {
      summary: "List notebook tags and usage counts",
      args: notebookArgs,
      flags: notebookFlag,
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "tags", args.args),
    }),
    command("tag-notes", {
      summary: "List notes carrying a tag",
      args: notebookArgs,
      flags: { ...notebookFlag, ...paginationFlagSpecs },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "tag-notes", args.args),
    }),
    command("attachments", {
      summary: "List notebook attachments",
      args: notebookArgs,
      flags: notebookFlag,
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "attachments", args.args),
    }),
    command("attachment", {
      summary: "Show attachment metadata",
      args: notebookArgs,
      flags: notebookFlag,
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "attachment", args.args),
    }),
    command("upload-attachment", {
      summary: "Upload a notebook attachment",
      args: notebookArgs,
      flags: notebookFlag,
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "upload-attachment", args.args),
    }),
    command("download-attachment", {
      summary: "Download an attachment to a local file",
      args: notebookArgs,
      flags: {
        ...notebookFlag,
        outputFile: flag.string({ name: "output-file", aliases: ["out"], description: "Destination file path" }),
      },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "download-attachment", args.args),
    }),
    command("attachment-usage", {
      summary: "Count notes referencing an attachment",
      args: notebookArgs,
      flags: notebookFlag,
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "attachment-usage", args.args),
    }),
    command("delete-attachment", {
      summary: "Delete a notebook attachment",
      args: notebookArgs,
      flags: { ...notebookFlag, yes: confirmFlag("Delete this attachment") },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "delete-attachment", args.args),
    }),
    command("export", {
      summary: "Export a notebook as a portable ZIP archive",
      args: notebookArgs,
      flags: {
        ...notebookFlag,
        outputFile: flag.string({ name: "output-file", aliases: ["out"], description: "Destination ZIP path" }),
      },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "export", args.args),
    }),
    command("api-keys", {
      summary: "List resource-bound notebook API keys",
      args: notebookArgs,
      flags: notebookFlag,
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "api-keys", args.args),
    }),
    command("create-api-key", {
      summary: "Create a resource-bound notebook API key",
      args: notebookArgs,
      flags: {
        ...notebookFlag,
        permission: flag.string({ description: "read, write, or admin" }),
        expiresAt: flag.string({ name: "expires-at", description: "Optional ISO expiry timestamp" }),
      },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "create-api-key", args.args),
    }),
    command("revoke-api-key", {
      summary: "Revoke a notebook API key",
      args: notebookArgs,
      flags: { ...notebookFlag, yes: confirmFlag("Revoke this notebook API key") },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "revoke-api-key", args.args),
    }),
    command("snapshot", {
      summary: "Show redacted S3 snapshot configuration",
      args: notebookArgs,
      flags: notebookFlag,
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "snapshot", args.args),
    }),
    command("update-snapshot", {
      summary: "Update S3 snapshot configuration",
      args: notebookArgs,
      flags: {
        ...notebookFlag,
        enabled: flag.string({ description: "Enable or disable snapshots: true|false" }),
        endpoint: flag.string({ description: "S3 endpoint" }),
        region: flag.string({ description: "S3 region" }),
        bucket: flag.string({ description: "S3 bucket" }),
        accessKeyId: flag.string({ name: "access-key-id", description: "S3 access key id" }),
        secretAccessKey: flag.string({ name: "secret-access-key", description: "S3 secret access key" }),
      },
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "update-snapshot", args.args),
    }),
    command("snapshot-logs", {
      summary: "List recent S3 snapshot logs",
      args: notebookArgs,
      flags: notebookFlag,
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "snapshot-logs", args.args),
    }),
    command("run-snapshot", {
      summary: "Run an S3 snapshot now",
      args: notebookArgs,
      flags: notebookFlag,
      run: ({ ctx, args }) => runNotebooksCommand(ctx, "run-snapshot", args.args),
    }),
  ],
});
