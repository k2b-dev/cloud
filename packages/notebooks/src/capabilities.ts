import { err, fail, ok, type Result } from "@k2b/stdlib";
import {
  type CapabilityExecutionContext,
  type CapabilityInvocationResult,
  type CloudResourceView,
  capabilityPage,
  defineCapabilities,
  type MutationResult,
  UniversalSearchDataSchema,
  type UniversalSearchInput,
  UniversalSearchInputSchema,
} from "@valentinkolb/cloud/contracts";
import { hasPermission, type PermissionLevel } from "@valentinkolb/cloud/server";
import { type AuditActor, audit } from "@valentinkolb/cloud/services";
import type { z } from "zod";
import {
  NotebookDataSchema,
  NotebookListDataSchema,
  NotebookListInputSchema,
  NotebookReadInputSchema,
  NoteCreateInputSchema,
  NoteDetailDataSchema,
  NoteEditDataSchema,
  NoteEditInputSchema,
  NoteLinksDataSchema,
  NoteLinksInputSchema,
  NoteMoveInputSchema,
  NoteReadInputSchema,
  NoteSummaryDataSchema,
  NoteTreeDataSchema,
  NoteTreeInputSchema,
  TagListDataSchema,
  TagListInputSchema,
  TagNotesDataSchema,
  TagNotesInputSchema,
} from "./capability-contracts";
import { noteContentHash, summarizeNoteEditBlocks } from "./lib/note-edit";
import { NOTEBOOK_RESOURCE_TYPE, NOTEBOOKS_APP_ID } from "./service/access";
import { resolveNotebookApiKeyPermission } from "./service/api-key-permissions";
import * as noteLinks from "./service/links";
import type { Notebook, NotebookWithPermission } from "./service/notebooks";
import * as notebookStore from "./service/notebooks";
import type { Note } from "./service/notes";
import * as noteStore from "./service/notes";
import * as noteSearch from "./service/search";
import * as noteTags from "./service/tags";

const encodePageCursor = (page: number): string => Buffer.from(JSON.stringify({ v: 1, page }), "utf8").toString("base64url");

export const decodeNotebookCapabilityCursor = (cursor: string | undefined): Result<number> => {
  if (!cursor) return ok(1);
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; page?: unknown };
    return value.v === 1 && Number.isSafeInteger(value.page) && Number(value.page) >= 1
      ? ok(Number(value.page))
      : fail(err.badInput("Invalid cursor"));
  } catch {
    return fail(err.badInput("Invalid cursor"));
  }
};

const encodeTreeCursor = (afterId: string): string => Buffer.from(JSON.stringify({ v: 1, afterId }), "utf8").toString("base64url");

export const decodeNotebookTreeCursor = (cursor: string | undefined): Result<string | undefined> => {
  if (!cursor) return ok(undefined);
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; afterId?: unknown };
    return value.v === 1 && typeof value.afterId === "string" && zUuid(value.afterId)
      ? ok(value.afterId)
      : fail(err.badInput("Invalid tree cursor"));
  } catch {
    return fail(err.badInput("Invalid tree cursor"));
  }
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const zUuid = (value: string | null | undefined): value is string => Boolean(value && UUID_PATTERN.test(value));

const permissionFromScopes = (scopes: string[]): PermissionLevel => resolveNotebookApiKeyPermission("admin", scopes);

const effectivePermission = (permission: Exclude<PermissionLevel, "none">, context: CapabilityExecutionContext) =>
  context.actor.kind === "service_account" && context.actor.serviceAccount.kind === "resource_bound"
    ? resolveNotebookApiKeyPermission(permission, context.actor.scopes)
    : permission;

const scopedNotebookId = (context: CapabilityExecutionContext, required: PermissionLevel): Result<string | null> => {
  if (context.actor.kind === "user") {
    return context.accessSubject.type === "user" ? ok(null) : fail(err.forbidden("Access denied"));
  }
  const account = context.actor.serviceAccount;
  if (account.kind === "user_delegated") {
    return context.accessSubject.type === "user" && context.user ? ok(null) : fail(err.forbidden("Access denied"));
  }
  if (
    account.appId !== NOTEBOOKS_APP_ID ||
    account.resourceType !== NOTEBOOK_RESOURCE_TYPE ||
    !zUuid(account.resourceId) ||
    context.accessSubject.type !== "service_account" ||
    !hasPermission(permissionFromScopes(context.actor.scopes), required)
  ) {
    return fail(err.forbidden("Access denied"));
  }
  return ok(account.resourceId);
};

const principalIds = (context: CapabilityExecutionContext) => ({
  userId: context.accessSubject.type === "user" ? context.accessSubject.userId : null,
  serviceAccountId: context.accessSubject.type === "service_account" ? context.accessSubject.serviceAccountId : null,
});

const activityActor = (context: CapabilityExecutionContext) =>
  context.actor.kind === "user"
    ? ({ kind: "user", id: context.actor.user.id } as const)
    : ({ kind: "service_account", id: context.actor.serviceAccount.id } as const);

const authorizeNotebook = async (notebook: Notebook, context: CapabilityExecutionContext, required: PermissionLevel = "read") => {
  const scope = scopedNotebookId(context, required);
  if (!scope.ok) return scope;
  if (scope.data && scope.data !== notebook.id) return fail(err.notFound("Notebook"));
  const ids = principalIds(context);
  const granted = await notebookStore.getPermission({ notebookId: notebook.id, ...ids });
  const permission = granted === "none" ? "none" : effectivePermission(granted, context);
  return hasPermission(permission, required) ? ok({ notebook, permission }) : fail(err.notFound("Notebook"));
};

const requireNotebook = async (notebookId: string, context: CapabilityExecutionContext, required: PermissionLevel = "read") => {
  const scope = scopedNotebookId(context, required);
  if (!scope.ok) return scope;
  if (scope.data && scope.data !== notebookId) return fail(err.notFound("Notebook"));
  const notebook = await notebookStore.get({ id: notebookId });
  return notebook ? authorizeNotebook(notebook, context, required) : fail(err.notFound("Notebook"));
};

const requireNotebookByShortId = async (shortId: string, context: CapabilityExecutionContext, required: PermissionLevel = "read") => {
  const notebook = await notebookStore.getByShortId({ shortId });
  return notebook ? authorizeNotebook(notebook, context, required) : fail(err.notFound("Notebook"));
};

const requireNoteByShortId = async (shortId: string, context: CapabilityExecutionContext, required: PermissionLevel = "read") => {
  const note = await noteStore.getByShortId({ shortId });
  if (!note) return fail(err.notFound("Note"));
  const access = await requireNotebook(note.notebookId, context, required);
  return access.ok ? ok({ note, notebook: access.data.notebook, permission: access.data.permission }) : fail(err.notFound("Note"));
};

const mapNotebook = (notebook: Notebook, permission: Exclude<PermissionLevel, "none">) => ({
  id: notebook.shortId,
  name: notebook.name,
  description: notebook.description,
  icon: notebook.icon,
  homepageNoteId: notebook.homepageNoteShortId,
  permission,
  createdAt: notebook.createdAt,
  updatedAt: notebook.updatedAt,
});

const mapNote = (note: Note, notebookShortId: string, parentShortId: string | null) => ({
  id: note.shortId,
  notebookId: notebookShortId,
  parentId: parentShortId,
  title: note.title,
  position: note.position,
  hasChildren: note.hasChildren,
  locked: note.lockedAt !== null,
  createdAt: note.createdAt,
  updatedAt: note.updatedAt,
});

const notebookHref = (notebook: Pick<Notebook, "shortId">) => `/app/notebooks/${notebook.shortId}`;
const noteHref = (notebook: Pick<Notebook, "shortId">, note: Pick<Note, "shortId">) =>
  `/app/notebooks/${notebook.shortId}/notes/${note.shortId}`;
const notebookRef = (notebook: Pick<Notebook, "shortId" | "name" | "description" | "icon">) => ({
  type: "notebooks.notebook" as const,
  id: notebook.shortId,
  title: notebook.name,
  ...(notebook.description ? { preview: notebook.description } : {}),
  icon: notebook.icon ?? "ti ti-notebook",
});
const noteRef = (note: Pick<Note, "shortId" | "title">, notebookName?: string) => ({
  type: "notebooks.note" as const,
  id: note.shortId,
  title: note.title,
  ...(notebookName ? { preview: notebookName } : {}),
  icon: "ti ti-file-text",
});
const notebookApprovalScope = (notebook: Pick<Notebook, "shortId">): string => `notebook:${notebook.shortId}`;

const resolveParentShortId = async (note: Note): Promise<string | null> => {
  if (!note.parentId) return null;
  return (await noteStore.resolveIdsToShortIds({ ids: [note.parentId] })).get(note.parentId) ?? null;
};

const cleanSearchSnippet = (value: string | null): string | undefined =>
  value ? value.replaceAll("\uE000", "").replaceAll("\uE001", "").trim() || undefined : undefined;

const compactSnippet = (content: string | null): string | undefined => {
  const value = content?.replace(/\s+/g, " ").trim();
  return value ? value.slice(0, 240) : undefined;
};

type NoteEditOperation = z.infer<typeof NoteEditInputSchema>["operations"][number];

const noteEditOperationReview = (operation: NoteEditOperation): string => {
  let target = "";
  if ("name" in operation) {
    target = ` block @${operation.name}${operation.type ? ` (${operation.type})` : ""}${
      operation.index === undefined ? "" : ` at index ${operation.index}`
    }`;
  } else if ("line" in operation) {
    target = ` line ${operation.line}`;
  } else if ("startLine" in operation) {
    target = ` lines ${operation.startLine}–${operation.endLine}`;
  }

  let effect: string;
  switch (operation.kind) {
    case "set-content":
      effect = "Replace the complete note";
      break;
    case "append":
      effect = "Append to the note";
      break;
    case "prepend":
      effect = "Prepend to the note";
      break;
    case "insert-before-line":
      effect = `Insert before${target}`;
      break;
    case "insert-after-line":
      effect = `Insert after${target}`;
      break;
    case "replace-lines":
      effect = `Replace${target}`;
      break;
    case "delete-lines":
      effect = `Delete${target}`;
      break;
    case "replace-block":
      effect = `Replace${target}${operation.includeHandle ? " including its handle" : ""}`;
      break;
    case "append-block":
      effect = `Append to${target}`;
      break;
    case "prepend-block":
      effect = `Prepend to${target}`;
      break;
  }
  return effect;
};

const noteEditOperationDetails = (operation: NoteEditOperation, index: number) => {
  const effect = noteEditOperationReview(operation);
  if (!("content" in operation)) return { label: `Operation ${index + 1}`, value: effect };
  const limit = 9_000;
  const truncated = operation.content.length > limit;
  const preview = truncated ? `${operation.content.slice(0, limit - 1)}…` : operation.content;
  return {
    label: `Operation ${index + 1}`,
    value: `${effect} with ${operation.content.length} character${operation.content.length === 1 ? "" : "s"}.${
      truncated ? ` Showing the first ${limit.toLocaleString("en")} characters.` : ""
    }\n\n${preview}`,
    display: "block" as const,
  };
};

const noteTitle = (title: string): string => `“${title}”`;
const lineCount = (content: string): number => (content.length === 0 ? 0 : content.split(/\r?\n/).length);
const lines = (count: number): string => `${count} ${count === 1 ? "line" : "lines"}`;

export const noteEditCapabilitySummary = (operations: NoteEditOperation[], title: string, changed: boolean): string => {
  const target = noteTitle(title);
  if (!changed) return `${target} was already up to date.`;
  if (operations.length !== 1) return `Made ${operations.length} changes to ${target}.`;
  const operation = operations[0]!;
  switch (operation.kind) {
    case "append":
    case "prepend":
      return `Added ${lines(lineCount(operation.content))} to ${target}.`;
    case "insert-before-line":
    case "insert-after-line":
      return `Inserted ${lines(lineCount(operation.content))} in ${target}.`;
    case "replace-lines":
      return `Replaced ${lines(operation.endLine - operation.startLine + 1)} in ${target}.`;
    case "delete-lines":
      return `Deleted ${lines(operation.endLine - operation.startLine + 1)} from ${target}.`;
    case "replace-block":
    case "append-block":
    case "prepend-block":
      return `Updated @${operation.name} in ${target}.`;
    case "set-content":
      return `Replaced the content of ${target}.`;
  }
};

const runNotebookSearch = async (input: UniversalSearchInput, context: CapabilityExecutionContext) => {
  const scope = scopedNotebookId(context, "read");
  if (!scope.ok) return ok({ data: [] });
  const page = await notebookStore.listWithPermission({
    ...principalIds(context),
    boundNotebookId: scope.data,
    requiredLevel: "read",
    pagination: { limit: input.limit, offset: 0 },
    query: input.query,
  });
  const data: CloudResourceView[] = page.items.map((notebook) => ({
    ref: { type: "notebooks.notebook", id: notebook.shortId },
    title: notebook.name,
    preview: notebook.description ?? undefined,
    icon: notebook.icon ?? "ti ti-notebook",
    priority: 7,
    metadata: [{ label: "Type", value: "Notebook" }],
    links: [{ rel: "open", href: notebookHref(notebook) }],
  }));
  return ok({ data });
};

const runNoteSearch = async (input: UniversalSearchInput, context: CapabilityExecutionContext) => {
  const scope = scopedNotebookId(context, "read");
  if (!scope.ok) return ok({ data: [] });
  const hits = await noteSearch.searchAcross({
    ...principalIds(context),
    boundNotebookId: scope.data,
    filters: { query: input.query },
    pagination: { page: 1, perPage: input.limit, offset: 0 },
  });
  const data: CloudResourceView[] = hits.hits.map(({ note, notebook, snippet }) => ({
    ref: { type: "notebooks.note", id: note.shortId },
    title: note.title,
    preview: cleanSearchSnippet(snippet) ?? compactSnippet(note.contentMd),
    icon: "ti ti-file-text",
    priority: 8,
    metadata: [
      { label: "Type", value: "Note" },
      { label: "Notebook", value: notebook.name },
    ],
    links: [{ rel: "open", href: `/app/notebooks/${notebook.shortId}/notes/${note.shortId}` }],
  }));
  return ok({ data });
};

const runNotebookList = async (input: z.infer<typeof NotebookListInputSchema>, context: CapabilityExecutionContext) => {
  const cursor = decodeNotebookCapabilityCursor(input.cursor);
  if (!cursor.ok) return cursor;
  const scope = scopedNotebookId(context, input.minimumPermission);
  if (!scope.ok) return scope;
  const page = await notebookStore.listWithPermission({
    ...principalIds(context),
    boundNotebookId: scope.data,
    requiredLevel: input.minimumPermission,
    pagination: { limit: input.limit, offset: (cursor.data - 1) * input.limit },
    query: input.query,
  });
  const data = page.items.map((notebook: NotebookWithPermission) => ({
    ...mapNotebook(notebook, effectivePermission(notebook.permission, context) as Exclude<PermissionLevel, "none">),
    ref: { type: "notebooks.notebook" as const, id: notebook.shortId },
    links: [{ rel: "open" as const, href: notebookHref(notebook) }],
  }));
  return ok({
    data,
    page: capabilityPage(cursor.data * input.limit < page.total ? encodePageCursor(cursor.data + 1) : undefined),
    refs: page.items.map(notebookRef),
  });
};

const runNotebookRead = async (input: z.infer<typeof NotebookReadInputSchema>, context: CapabilityExecutionContext) => {
  const access = await requireNotebookByShortId(input.id, context);
  if (!access.ok) return access;
  return ok({
    data: mapNotebook(access.data.notebook, access.data.permission as Exclude<PermissionLevel, "none">),
    summary: `Read notebook “${access.data.notebook.name}”.`,
    refs: [notebookRef(access.data.notebook)],
    links: [{ rel: "open" as const, href: notebookHref(access.data.notebook) }],
  });
};

const runNoteTree = async (input: z.infer<typeof NoteTreeInputSchema>, context: CapabilityExecutionContext) => {
  const cursor = decodeNotebookTreeCursor(input.cursor);
  if (!cursor.ok) return cursor;
  const access = await requireNotebookByShortId(input.notebookId, context);
  if (!access.ok) return access;
  const rows = await noteStore.listTreePage({
    notebookId: access.data.notebook.id,
    afterId: cursor.data,
    limit: input.limit + 1,
  });
  const hasMore = rows.length > input.limit;
  const pageRows = rows.slice(0, input.limit);
  const shortIds = await noteStore.resolveIdsToShortIds({
    ids: pageRows.flatMap((note) => [note.id, ...(note.parentId ? [note.parentId] : [])]),
  });
  const data = pageRows.map((note) => ({
    id: note.shortId,
    ref: { type: "notebooks.note" as const, id: note.shortId },
    parentId: note.parentId ? (shortIds.get(note.parentId) ?? null) : null,
    title: note.title,
    position: note.position,
    hasChildren: note.hasChildren,
    links: [{ rel: "open" as const, href: noteHref(access.data.notebook, note) }],
  }));
  const last = pageRows.at(-1);
  return ok({
    data,
    page: capabilityPage(hasMore && last ? encodeTreeCursor(last.id) : undefined),
    refs: pageRows.map((note) => noteRef(note, access.data.notebook.name)),
  });
};

const runNoteRead = async (input: z.infer<typeof NoteReadInputSchema>, context: CapabilityExecutionContext) => {
  const resolved = await requireNoteByShortId(input.id, context);
  if (!resolved.ok) return resolved;
  const note = await noteStore.getWithContent({ id: resolved.data.note.id });
  if (!note) return fail(err.notFound("Note"));
  const content = note.contentMd ?? "";
  if (input.contentOffset > content.length) return fail(err.badInput("contentOffset is outside the note"));
  const end = Math.min(content.length, input.contentOffset + input.contentLimit);
  const blocks = summarizeNoteEditBlocks(content);
  const tags = noteTags.extractTags(content);
  return ok({
    data: {
      ...mapNote(note, resolved.data.notebook.shortId, await resolveParentShortId(note)),
      content: content.slice(input.contentOffset, end),
      contentOffset: input.contentOffset,
      contentLength: content.length,
      contentHash: noteContentHash(content),
      contentComplete: end >= content.length,
      nextContentOffset: end < content.length ? end : null,
      lineCount: content.split("\n").length,
      tags: tags.slice(0, 500),
      tagsTruncated: tags.length > 500,
      blocks: blocks.slice(0, 500),
      blocksTruncated: blocks.length > 500,
    },
    summary: `Read note “${note.title}”.`,
    refs: [noteRef(note, resolved.data.notebook.name), notebookRef(resolved.data.notebook)],
    links: [{ rel: "open" as const, href: noteHref(resolved.data.notebook, note) }],
  });
};

const runNoteLinks = async (input: z.infer<typeof NoteLinksInputSchema>, context: CapabilityExecutionContext) => {
  const cursor = decodeNotebookCapabilityCursor(input.cursor);
  if (!cursor.ok) return cursor;
  const resolved = await requireNoteByShortId(input.noteId, context);
  if (!resolved.ok) return resolved;
  const scope = scopedNotebookId(context, "read");
  if (!scope.ok) return scope;
  const rows = await noteLinks.listNoteRelations({
    noteId: resolved.data.note.id,
    ...principalIds(context),
    boundNotebookId: scope.data,
    direction: input.direction,
    pagination: { limit: input.limit + 1, offset: (cursor.data - 1) * input.limit },
  });
  const hasMore = rows.length > input.limit;
  const data = rows.slice(0, input.limit).map((entry) => ({
    direction: entry.direction,
    ref: { type: "notebooks.note" as const, id: entry.noteId },
    noteId: entry.noteId,
    title: entry.title,
    notebookId: entry.notebookId,
    notebookName: entry.notebookName,
    updatedAt: entry.updatedAt,
    links: [
      {
        rel: "open" as const,
        href: `/app/notebooks/${entry.notebookId}/notes/${entry.noteId}`,
      },
    ],
  }));
  return ok({
    data,
    page: capabilityPage(hasMore ? encodePageCursor(cursor.data + 1) : undefined),
    refs: data.map((entry) => ({
      type: "notebooks.note",
      id: entry.noteId,
      title: entry.title,
      preview: entry.notebookName,
      icon: "ti ti-file-text",
    })),
  });
};

const runTagList = async (input: z.infer<typeof TagListInputSchema>, context: CapabilityExecutionContext) => {
  const cursor = decodeNotebookCapabilityCursor(input.cursor);
  if (!cursor.ok) return cursor;
  const access = await requireNotebookByShortId(input.notebookId, context);
  if (!access.ok) return access;
  const rows = await noteTags.listForNotebook({
    notebookId: access.data.notebook.id,
    pagination: { limit: input.limit + 1, offset: (cursor.data - 1) * input.limit },
  });
  const hasMore = rows.length > input.limit;
  return ok({
    data: rows.slice(0, input.limit).map((entry) => ({
      ...entry,
      links: [{ rel: "open" as const, href: `/app/notebooks/${access.data.notebook.shortId}/tags/${encodeURIComponent(entry.tag)}` }],
    })),
    page: capabilityPage(hasMore ? encodePageCursor(cursor.data + 1) : undefined),
  });
};

const runTagNotes = async (input: z.infer<typeof TagNotesInputSchema>, context: CapabilityExecutionContext) => {
  const cursor = decodeNotebookCapabilityCursor(input.cursor);
  if (!cursor.ok) return cursor;
  const access = await requireNotebookByShortId(input.notebookId, context);
  if (!access.ok) return access;
  const result = await noteTags.listNotesForTag({
    notebookId: access.data.notebook.id,
    tag: input.tag,
    search: input.query,
    pagination: { limit: input.limit, offset: (cursor.data - 1) * input.limit },
  });
  const hasMore = cursor.data * input.limit < result.total;
  const data = result.items.map((item) => {
    const updatedAt = item.updatedAt as string | Date;
    return {
      id: item.shortId,
      ref: { type: "notebooks.note" as const, id: item.shortId },
      title: item.title,
      preview: item.preview,
      updatedAt: updatedAt instanceof Date ? updatedAt.toISOString() : updatedAt,
      links: [{ rel: "open" as const, href: noteHref(access.data.notebook, item) }],
    };
  });
  return ok({
    data,
    page: capabilityPage(hasMore ? encodePageCursor(cursor.data + 1) : undefined),
    refs: data.map((note) => ({
      type: "notebooks.note",
      id: note.id,
      title: note.title,
      ...(note.preview ? { preview: note.preview } : {}),
      icon: "ti ti-file-text",
    })),
  });
};

const capabilityAuditActor = (context: CapabilityExecutionContext): AuditActor =>
  context.actor.kind === "user"
    ? {
        userId: context.actor.user.id,
        uid: context.actor.user.uid,
        provider: context.actor.user.provider,
        roles: context.actor.user.roles,
      }
    : {
        uid: `service-account:${context.actor.serviceAccount.id}`,
        provider: "service_account",
        roles: context.actor.scopes,
      };

const actionAudit = (context: CapabilityExecutionContext, actionId: string, targetType: string, targetId: string) => ({
  action: `notebooks.capability.${actionId}`,
  actor: capabilityAuditActor(context),
  target: { type: targetType, id: targetId },
  metadata: { capability: `notebooks.${actionId}` },
});

const audited = async <T>(
  params: ReturnType<typeof actionAudit>,
  operation: () => Promise<CapabilityInvocationResult<T>>,
): Promise<CapabilityInvocationResult<T>> => {
  const result = await operation();
  return result.ok ? audit.recordResultAfterSideEffect({ ...params, result }) : audit.recordResult({ ...params, result });
};

const mutationError = <T>(result: Exclude<MutationResult<T>, { ok: true }>) => {
  if (result.status === 403) return fail(err.forbidden(result.error));
  if (result.status === 404) return fail(err.notFound(result.error.replace(/ not found.*$/i, "")));
  if (result.status === 409) return fail(err.conflict(result.error));
  if (result.status === 500) return fail(err.internal(result.error));
  return fail(err.badInput(result.error));
};

const noteMutationResult = async (result: MutationResult<Note>, notebook: Notebook, summary: (note: Note) => string) => {
  if (!result.ok) return mutationError(result);
  return ok({
    data: mapNote(result.data, notebook.shortId, await resolveParentShortId(result.data)),
    summary: summary(result.data),
    refs: [noteRef(result.data, notebook.name), notebookRef(notebook)],
    links: [{ rel: "open" as const, href: noteHref(notebook, result.data) }],
  });
};

const runNoteCreate = async (input: z.infer<typeof NoteCreateInputSchema>, context: CapabilityExecutionContext) => {
  const access = await requireNotebookByShortId(input.notebookId, context, "write");
  if (!access.ok) return access;
  let parentId: string | undefined;
  if (input.parentId) {
    const parent = await requireNoteByShortId(input.parentId, context, "write");
    if (!parent.ok || parent.data.note.notebookId !== access.data.notebook.id) return fail(err.notFound("Parent note"));
    parentId = parent.data.note.id;
  }
  return audited(actionAudit(context, "note.create", "notebook", access.data.notebook.id), async () =>
    noteMutationResult(
      await noteStore.create({
        data: {
          notebookId: access.data.notebook.id,
          parentId,
          position: input.position,
          contentMd: input.content,
        },
        creatorId: context.user?.id ?? null,
        actor: activityActor(context),
      }),
      access.data.notebook,
      (note) =>
        note.title === "Untitled"
          ? `Created a new note in ${access.data.notebook.name}.`
          : `Created ${noteTitle(note.title)} in ${access.data.notebook.name}.`,
    ),
  );
};

const runNoteEdit = async (input: z.infer<typeof NoteEditInputSchema>, context: CapabilityExecutionContext) => {
  const resolved = await requireNoteByShortId(input.noteId, context, "write");
  if (!resolved.ok) return resolved;
  return audited(actionAudit(context, "note.edit", "note", resolved.data.note.id), async () => {
    const { noteId, ...data } = input;
    const result = await noteStore.editContent({
      noteId: resolved.data.note.id,
      data,
      createdBy: context.user?.id ?? null,
      actor: activityActor(context),
    });
    if (!result.ok) return mutationError(result);
    return ok({
      data: {
        note: mapNote(result.data.note, resolved.data.notebook.shortId, await resolveParentShortId(result.data.note)),
        changed: result.data.changed,
        beforeHash: result.data.beforeHash,
        afterHash: result.data.afterHash,
        blocks: result.data.blocks.slice(0, 500),
        blocksTruncated: result.data.blocks.length > 500,
      },
      summary: noteEditCapabilitySummary(input.operations, result.data.note.title, result.data.changed),
      refs: [noteRef(result.data.note, resolved.data.notebook.name), notebookRef(resolved.data.notebook)],
      links: [{ rel: "open" as const, href: noteHref(resolved.data.notebook, result.data.note) }],
    });
  });
};

const runNoteMove = async (input: z.infer<typeof NoteMoveInputSchema>, context: CapabilityExecutionContext) => {
  const resolved = await requireNoteByShortId(input.noteId, context, "write");
  if (!resolved.ok) return resolved;
  let parentId: string | null = null;
  let parentTitle: string | null = null;
  if (input.parentId) {
    const parent = await requireNoteByShortId(input.parentId, context, "write");
    if (!parent.ok || parent.data.note.notebookId !== resolved.data.note.notebookId) return fail(err.notFound("Parent note"));
    parentId = parent.data.note.id;
    parentTitle = parent.data.note.title;
  }
  return audited(actionAudit(context, "note.move", "note", resolved.data.note.id), async () =>
    noteMutationResult(
      await noteStore.move({ id: resolved.data.note.id, parentId, position: input.position }),
      resolved.data.notebook,
      (note) =>
        parentTitle
          ? `Moved ${noteTitle(note.title)} under ${noteTitle(parentTitle)}.`
          : `Moved ${noteTitle(note.title)} to the notebook root.`,
    ),
  );
};

export const notebooksCapabilities = defineCapabilities({
  protocolVersion: 1,
  types: {
    notebook: {
      title: "Notebook",
      description: "A permission-scoped collection of Markdown notes.",
      icon: "ti ti-notebook",
      reader: "notebook.read",
    },
    note: { title: "Note", description: "A Markdown note in an accessible notebook.", icon: "ti ti-file-text", reader: "note.read" },
  },
  queries: {
    "notebook.search": {
      title: "Search notebooks",
      description:
        "Find accessible notebooks by name or description when no notebook is known. Use returned notebooks.notebook refs with notebook.read or their IDs with note.tree and tag.list.",
      input: UniversalSearchInputSchema,
      data: UniversalSearchDataSchema,
      openWorld: false,
      universalSearch: {
        tags: [{ tag: "notebook", title: "Notebooks", description: "Show notebooks only.", aliases: ["notebooks"] }],
      },
      run: runNotebookSearch,
    },
    "note.search": {
      title: "Search notes",
      description:
        "Direct cross-notebook entry for finding Markdown notes by title or content. Use returned notebooks.note refs with note.read; use note.tree to browse one known notebook without full-text search.",
      input: UniversalSearchInputSchema,
      data: UniversalSearchDataSchema,
      openWorld: false,
      universalSearch: {
        tags: [{ tag: "note", title: "Notes", description: "Show notes only.", aliases: ["notes", "markdown"] }],
      },
      run: runNoteSearch,
    },
    "notebook.list": {
      title: "List notebooks",
      description:
        "Normal entry for notebook-scoped work. List accessible notebooks with effective permission; use returned notebooks.notebook refs or IDs with notebook.read, note.tree, tag.list, or note.create.",
      input: NotebookListInputSchema,
      data: NotebookListDataSchema,
      openWorld: false,
      run: runNotebookList,
    },
    "notebook.read": {
      title: "Read notebook",
      description: "Read one notebooks.notebook ref returned by notebook.list or notebook.search, including its homepage note ID.",
      input: NotebookReadInputSchema,
      data: NotebookDataSchema,
      openWorld: false,
      run: runNotebookRead,
    },
    "note.tree": {
      title: "List note tree",
      description:
        "Browse the hierarchy of one known notebook without loading Markdown. Get notebookId from notebook.list or notebook.search; use returned notebooks.note refs with note.read.",
      input: NoteTreeInputSchema,
      data: NoteTreeDataSchema,
      openWorld: false,
      run: runNoteTree,
    },
    "note.read": {
      title: "Read note",
      description:
        "Read one notebooks.note ref returned by note.search, note.tree, note.links, or tag.notes as a bounded Markdown window with hashes, tags, and named-block summaries.",
      input: NoteReadInputSchema,
      data: NoteDetailDataSchema,
      openWorld: false,
      run: runNoteRead,
    },
    "note.links": {
      title: "List note links and backlinks",
      description:
        "List incoming or outgoing links after one note is known. Get noteId from a notebooks.note ref; inaccessible targets are omitted and returned note refs can be opened with note.read.",
      input: NoteLinksInputSchema,
      data: NoteLinksDataSchema,
      openWorld: false,
      run: runNoteLinks,
    },
    "tag.list": {
      title: "List notebook tags",
      description:
        "List tags and note counts in one known notebook. Get notebookId from notebook.list or notebook.search; use a returned tag value with tag.notes.",
      input: TagListInputSchema,
      data: TagListDataSchema,
      openWorld: false,
      run: runTagList,
    },
    "tag.notes": {
      title: "List notes by tag",
      description:
        "List notes carrying one tag in a known notebook. Get notebookId from notebook.list and tag from tag.list; use returned notebooks.note refs with note.read.",
      input: TagNotesInputSchema,
      data: TagNotesDataSchema,
      openWorld: false,
      run: runTagNotes,
    },
  },
  actions: {
    "note.create": {
      title: "Create note",
      description: "Create one Markdown note in an explicitly selected writable notebook.",
      input: NoteCreateInputSchema,
      data: NoteSummaryDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      approval: "rememberable",
      review: async (input, context) => {
        const access = await requireNotebookByShortId(input.notebookId, context, "write");
        if (!access.ok) return access;
        let parentTitle = "Notebook root";
        if (input.parentId) {
          const parent = await requireNoteByShortId(input.parentId, context, "write");
          if (!parent.ok || parent.data.note.notebookId !== access.data.notebook.id) return fail(err.notFound("Parent note"));
          parentTitle = parent.data.note.title;
        }
        const content = input.content ?? "";
        const previewLimit = 9_000;
        const truncated = content.length > previewLimit;
        return ok({
          message: `Create a note in ${access.data.notebook.name}.`,
          details: [
            { label: "Notebook", value: access.data.notebook.name },
            { label: "Parent", value: parentTitle },
            ...(input.position === undefined ? [] : [{ label: "Position", value: String(input.position) }]),
            ...(input.content === undefined
              ? []
              : [
                  {
                    label: "Initial Markdown",
                    value: `${content.length} character${content.length === 1 ? "" : "s"}.${
                      truncated ? ` Showing the first ${previewLimit.toLocaleString("en")} characters.` : ""
                    }\n\n${truncated ? `${content.slice(0, previewLimit - 1)}…` : content}`,
                    display: "block" as const,
                  },
                ]),
          ],
          links: [{ rel: "open" as const, href: notebookHref(access.data.notebook) }],
          approvalScope: notebookApprovalScope(access.data.notebook),
        });
      },
      run: runNoteCreate,
    },
    "note.edit": {
      title: "Edit note",
      description: "Apply conflict-aware structural Markdown edits through the collaborative note service.",
      input: NoteEditInputSchema,
      data: NoteEditDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "none",
      approval: "rememberable",
      review: async (input, context) => {
        const resolved = await requireNoteByShortId(input.noteId, context, "write");
        if (!resolved.ok) return resolved;
        return ok({
          message: `Edit ${resolved.data.note.title}.`,
          details: input.operations.map(noteEditOperationDetails),
          links: [{ rel: "open" as const, href: noteHref(resolved.data.notebook, resolved.data.note) }],
          approvalScope: notebookApprovalScope(resolved.data.notebook),
        });
      },
      run: runNoteEdit,
    },
    "note.move": {
      title: "Move note",
      description: "Move one note inside its notebook while rejecting invalid parents and cycles.",
      input: NoteMoveInputSchema,
      data: NoteSummaryDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "none",
      approval: "rememberable",
      review: async (input, context) => {
        const resolved = await requireNoteByShortId(input.noteId, context, "write");
        if (!resolved.ok) return resolved;
        let parentTitle = "Notebook root";
        if (input.parentId) {
          const parent = await requireNoteByShortId(input.parentId, context, "write");
          if (!parent.ok || parent.data.note.notebookId !== resolved.data.note.notebookId) return fail(err.notFound("Parent note"));
          parentTitle = parent.data.note.title;
        }
        return ok({
          message: `Move ${resolved.data.note.title} to ${parentTitle}.`,
          details: [
            { label: "Note", value: resolved.data.note.title },
            { label: "New parent", value: parentTitle },
            { label: "New position", value: String(input.position) },
          ],
          links: [{ rel: "open" as const, href: noteHref(resolved.data.notebook, resolved.data.note) }],
          approvalScope: notebookApprovalScope(resolved.data.notebook),
        });
      },
      run: runNoteMove,
    },
  },
});
