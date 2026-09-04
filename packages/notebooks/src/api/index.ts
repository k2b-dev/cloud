import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { MutationResult, PermissionLevel, User } from "@valentinkolb/cloud/contracts";
import {
  AccessEntrySchema,
  createPagination,
  ErrorResponseSchema,
  GrantAccessSchema,
  hasRole,
  MessageResponseSchema,
  PaginationQuerySchema,
  PaginationResponseSchema,
  parsePagination,
  ServiceAccountCredentialSchema,
  UpdateAccessSchema,
} from "@valentinkolb/cloud/contracts";
import {
  type AuthContext,
  auth,
  getDateConfig,
  getLocale,
  hasPermission,
  jsonResponse,
  rateLimit,
  requiresAuth,
  respond,
} from "@valentinkolb/cloud/server";
import { settings, settingsService } from "@valentinkolb/cloud/services";
import {
  GotenbergRenderError,
  MARKDOWN_PDF_MAX_CUSTOM_CSS_BYTES,
  MARKDOWN_PDF_MAX_MARKDOWN_BYTES,
  MARKDOWN_PDF_TEMPLATE_IDS,
  MarkdownPdfError,
  renderMarkdownToPdf,
} from "@valentinkolb/cloud/services/pdf";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { PRESENTATION_MODES } from "@/lib/presentation-mode";
import { notebooksService, reindexRuntime } from "../service";
import { NOTEBOOK_RESOURCE_TYPE, NOTEBOOKS_APP_ID } from "../service/access";
import { InvalidActivityCursorError } from "../service/activity";
import { loadBookBlockPreview } from "../service/book";
import { loadBookRoute } from "../service/book-route";
import { localizeNotebookSnapshotField, notebookServiceMessages } from "../service/messages";
import { loadEditableNoteRouteData } from "../service/route-state";
import { notebookApiMessages } from "./messages";
import {
  ResourceShortIdSchema,
  toPublicAttachment,
  toPublicNote,
  toPublicNotebook,
  toPublicNoteComment,
  toPublicSnapshotLog,
} from "./public-resources";
import { notebookV as v } from "./validator";

// ==========================
// Zod Schemas
// ==========================

const NotebookSchema = z.object({
  id: ResourceShortIdSchema,
  name: z.string(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  homepageNoteId: ResourceShortIdSchema.nullable(),
  defaultNoteTitleTemplate: z.string().describe("Liquid template used to initialize the H1 of new notes"),
  defaultPresentationMode: z.enum(PRESENTATION_MODES).describe("Default view for notebook editors and admins; readers always use Book"),
  createdBy: z.uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const CreateNotebookSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  icon: z.string().max(50).optional(),
});

const UpdateNotebookSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).nullable().optional(),
    icon: z.string().max(50).nullable().optional(),
    homepageNoteId: ResourceShortIdSchema.nullable().optional().describe("Homepage note ID"),
    defaultNoteTitleTemplate: z.string().min(1).max(2_000).optional(),
    defaultPresentationMode: z.enum(PRESENTATION_MODES).optional(),
  })
  .strict();

const NotebookApiKeySchema = ServiceAccountCredentialSchema.extend({
  permission: z.enum(["none", "read", "write", "admin"]),
});

const CreateNotebookApiKeySchema = z.object({
  name: z.string().trim().min(1).max(120),
  expiresAt: z.string().datetime().nullable().optional(),
  permission: z.enum(["read", "write", "admin"]).default("read"),
});

const CreateNotebookApiKeyResponseSchema = z.object({
  credential: NotebookApiKeySchema,
  token: z.string(),
});

const NoteSchema = z.object({
  id: ResourceShortIdSchema,
  notebookId: ResourceShortIdSchema,
  parentId: ResourceShortIdSchema.nullable(),
  title: z.string().describe("Read-only title derived from note Markdown"),
  position: z.number().int(),
  hasChildren: z.boolean(),
  yjsSnapshotAt: z.string().nullable(),
  contentMd: z.string().nullable(),
  createdBy: z.uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lockedAt: z.string().nullable(),
});

const NoteWithContentSchema = NoteSchema.extend({
  yjsSnapshot: z.string().nullable().describe("Base64-encoded Yjs snapshot"),
});

const NoteCommentSchema = z.object({
  id: ResourceShortIdSchema,
  notebookId: ResourceShortIdSchema,
  noteId: ResourceShortIdSchema,
  authorUserId: z.uuid().nullable(),
  authorDisplayName: z.string(),
  authorAvatarHash: z.string().nullable(),
  content: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  canEdit: z.boolean(),
  canDelete: z.boolean(),
});

const NoteCommentInputSchema = z.object({
  content: z.string().trim().min(1).max(5_000),
});

const NoteCommentPageSchema = z.object({
  items: z.array(NoteCommentSchema),
  page: z.number().int().positive(),
  perPage: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  hasNext: z.boolean(),
});

const NotePdfRequestSchema = z
  .object({
    markdown: z.string().min(1),
    templateId: z.enum(MARKDOWN_PDF_TEMPLATE_IDS).optional(),
    customCss: z.string().optional(),
  })
  .strict();

const NOTE_PDF_MAX_REQUEST_BYTES = 300 * 1024;
const NOTE_PDF_MAX_ACTIVE_CONVERSIONS = 2;
let activeNotePdfConversions = 0;

const NoteSearchSummarySchema = NoteSchema.omit({ contentMd: true });

const NoteSearchHitSchema = z.object({
  note: NoteSearchSummarySchema,
  notebook: z.object({
    id: ResourceShortIdSchema,
    name: z.string(),
    icon: z.string().nullable(),
  }),
  snippet: z.string().nullable().describe("Plain text excerpt with U+E000/U+E001 match markers"),
});

const NamedBlockTypeSchema = z.enum(["table", "list", "data", "section", "unknown"]);

const NoteEditBlockFields = {
  name: z.string().min(1),
  type: NamedBlockTypeSchema.optional(),
  index: z.number().int().nonnegative().optional(),
};

const NoteEditOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set-content"), content: z.string() }),
  z.object({ kind: z.literal("append"), content: z.string() }),
  z.object({ kind: z.literal("prepend"), content: z.string() }),
  z.object({ kind: z.literal("insert-before-line"), line: z.number().int().positive(), content: z.string() }),
  z.object({ kind: z.literal("insert-after-line"), line: z.number().int().positive(), content: z.string() }),
  z.object({
    kind: z.literal("replace-lines"),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    content: z.string(),
  }),
  z.object({ kind: z.literal("delete-lines"), startLine: z.number().int().positive(), endLine: z.number().int().positive() }),
  z.object({ kind: z.literal("replace-block"), ...NoteEditBlockFields, includeHandle: z.boolean().optional(), content: z.string() }),
  z.object({ kind: z.literal("append-block"), ...NoteEditBlockFields, content: z.string() }),
  z.object({ kind: z.literal("prepend-block"), ...NoteEditBlockFields, content: z.string() }),
]);

const EditNoteContentSchema = z.object({
  operations: z.array(NoteEditOperationSchema).min(1).max(20),
  ifUpdatedAt: z.string().optional(),
  ifContentHash: z.string().optional(),
  ifBlockHash: z.string().optional(),
});

const NoteEditBlockSummarySchema = z.object({
  name: z.string(),
  type: NamedBlockTypeSchema,
  line: z.number().int().positive(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  hash: z.string(),
});

const EditNoteContentResponseSchema = z.object({
  note: NoteSchema,
  content: z.string(),
  changed: z.boolean(),
  beforeHash: z.string(),
  afterHash: z.string(),
  blocks: z.array(NoteEditBlockSummarySchema),
});

const NoteTreeNodeSchema: z.ZodType<unknown> = NoteSchema.extend({
  children: z.lazy(() => z.array(NoteTreeNodeSchema)),
});

const TagSummarySchema = z.object({
  tag: z.string(),
  count: z.number().int(),
});

const WorkspaceStateSchema = z.object({
  notebook: NotebookSchema,
  tree: z.array(NoteTreeNodeSchema),
  favoriteNoteIds: z.array(ResourceShortIdSchema),
  tags: z.array(TagSummarySchema),
  attachmentCount: z.number().int().nonnegative(),
});

const CreateNoteSchema = z.object({
  parentId: ResourceShortIdSchema.optional().describe("Parent note ID"),
  position: z.number().int().min(0).optional(),
  contentMd: z.string().optional(),
});

const UpdateNoteSchema = z.object({
  parentId: ResourceShortIdSchema.nullable().optional(),
  position: z.number().int().min(0).optional(),
});

const MoveNoteSchema = z.object({
  parentId: ResourceShortIdSchema.nullable(),
  position: z.number().int().min(0),
});

const CopyNoteSchema = z.object({
  targetNotebookId: ResourceShortIdSchema,
  targetParentId: ResourceShortIdSchema.nullable().optional(),
});

const NoteVersionSchema = z.object({
  id: z.uuid(),
  noteId: ResourceShortIdSchema,
  createdBy: z.uuid().nullable(),
  createdAt: z.string(),
  contributors: z.array(
    z.object({
      kind: z.enum(["user", "service_account"]),
      id: z.uuid(),
      displayName: z.string(),
      avatarHash: z.string().nullable(),
    }),
  ),
});

const NotebookActivitySchema = z.object({
  id: z.string(),
  notebook: z.object({
    id: ResourceShortIdSchema,
    name: z.string(),
    icon: z.string().nullable(),
  }),
  note: z
    .object({
      id: ResourceShortIdSchema,
      title: z.string(),
    })
    .nullable(),
  noteVersionId: z.uuid().nullable(),
  actor: z.object({
    kind: z.enum(["user", "service_account", "system"]),
    id: z.uuid().nullable(),
    displayName: z.string(),
    avatarHash: z.string().nullable(),
  }),
  action: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  occurrenceCount: z.number().int().positive(),
  createdAt: z.string(),
  lastOccurredAt: z.string(),
});

const BacklinkSchema = z.object({
  noteId: ResourceShortIdSchema,
  title: z.string(),
  notebookId: ResourceShortIdSchema,
  notebookName: z.string(),
  updatedAt: z.string(),
});

const GraphNodeSchema = z.object({
  id: ResourceShortIdSchema,
  title: z.string(),
  inDegree: z.number().int().min(0),
});

const GraphEdgeSchema = z.object({
  source: ResourceShortIdSchema,
  target: ResourceShortIdSchema,
});

const NoteGraphSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
});

const FavoriteNoteSchema = z.object({
  noteId: ResourceShortIdSchema,
  createdAt: z.string(),
});

const SetFavoriteSchema = z.object({
  favorite: z.boolean(),
});

const FavoriteStateSchema = z.object({
  favorite: z.boolean(),
});

const SnapshotLogsQuerySchema = z.object({
  _: z.string().optional().describe("Client cache-buster"),
});

const AttachmentSchema = z.object({
  id: ResourceShortIdSchema,
  notebookId: ResourceShortIdSchema,
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  kind: z.enum(["image", "file"]),
  createdBy: z.uuid().nullable(),
  createdAt: z.string(),
});

const AttachmentUsageSchema = z.object({ count: z.number().int() });

const NotebookSnapshotConfigSchema = z.object({
  enabled: z.boolean(),
  endpoint: z.string(),
  region: z.string(),
  bucket: z.string(),
  scheduleCron: z.string(),
  accessKeyIdSet: z.boolean(),
  secretAccessKeySet: z.boolean(),
  configured: z.boolean(),
  missing: z.array(z.string()),
  target: z.string().nullable(),
});

const UpdateNotebookSnapshotConfigSchema = z.object({
  enabled: z.boolean(),
  endpoint: z.string().max(500).optional(),
  region: z.string().min(1).max(100).optional(),
  bucket: z.string().min(1).max(255).optional(),
  accessKeyId: z.string().max(500).optional(),
  secretAccessKey: z.string().max(1000).optional(),
});

const LogEntrySchema = z.object({
  id: z.union([z.number(), z.string()]),
  level: z.string(),
  source: z.string(),
  message: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
});

const NotebookBackupRunSchema = z.object({
  message: z.string(),
  exportedAt: z.string(),
  filename: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
  paths: z.object({
    latestZip: z.string(),
    snapshotZip: z.string(),
    manifest: z.string(),
  }),
  uploaded: z.array(
    z.object({
      path: z.string(),
      bytes: z.number().int().nonnegative(),
    }),
  ),
});

const TocItemSchema = z.object({
  level: z.number().int(),
  text: z.string(),
  id: z.string(),
});

const TaskProgressSchema = z.object({
  done: z.number().int(),
  total: z.number().int(),
});

const NamedBlockSummarySchema = z.object({
  name: z.string(),
  type: z.enum(["table", "list", "data", "section", "unknown"]),
  line: z.number().int(),
});

const EditableNoteRouteStateSchema = z.object({
  href: z.string(),
  note: z.object({
    id: ResourceShortIdSchema,
    title: z.string(),
    yjsSnapshot: z.string().nullable(),
    contentMd: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    lockedAt: z.string().nullable(),
    parentId: ResourceShortIdSchema.nullable(),
  }),
  detail: z.object({
    noteId: ResourceShortIdSchema,
    noteTitle: z.string(),
    contentMd: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    lockedAt: z.string().nullable(),
    isLocked: z.boolean(),
    tocItems: z.array(TocItemSchema),
    taskProgress: TaskProgressSchema,
    attachments: z.array(AttachmentSchema),
    backlinks: z.array(BacklinkSchema),
    namedBlocks: z.array(NamedBlockSummarySchema),
  }),
});

const RouteStateQuerySchema = z.object({
  href: z.string().min(1).max(500),
});

const BookTreeSchema: z.ZodType<{ id: string; title: string; children: z.infer<typeof BookTreeSchema>[] }> = z.lazy(() =>
  z.object({ id: ResourceShortIdSchema, title: z.string(), children: z.array(BookTreeSchema) }),
);
const BookSnapshotSchema = z.object({
  href: z.string(),
  html: z.string().nullable(),
  title: z.string().nullable(),
  notebookName: z.string(),
  selectedNoteId: ResourceShortIdSchema.nullable(),
  tree: z.array(BookTreeSchema),
  tags: z.array(TagSummarySchema),
  activeTag: z.string().optional(),
  canWrite: z.boolean(),
  locked: z.boolean(),
  cursor: z.string().nullable(),
});
// Same request envelope budget as a collaboration sync payload. Preview never
// persists the draft; query block/row work is further bounded by its parser.
const BLOCK_PREVIEW_MAX_REQUEST_BYTES = 8_000_000;
const BlockPreviewInputSchema = z.object({ markdown: z.string().max(BLOCK_PREVIEW_MAX_REQUEST_BYTES).optional() }).strict();
const BlockPreviewSchema = z.object({
  markdown: z.string(),
  blocks: z.array(z.object({ line: z.number().int().positive(), html: z.string() })),
  headings: z.array(z.object({ id: z.string(), line: z.number().int().positive() })),
  diagnostics: z.array(z.object({ line: z.number().int().positive(), message: z.string() })),
});

const RouteStateResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ok"),
    state: EditableNoteRouteStateSchema,
  }),
  z.object({
    kind: z.literal("fallback"),
    reason: z.enum(["invalid-target", "not-found", "readonly"]),
  }),
]);

/** Per-file upload cap. Default 10 MB, configurable at runtime via
 *  `notebooks.max_attachment_size_mb` (admin settings modal). The
 *  default mirrors the frontend's hardcoded `MAX_ATTACHMENT_SIZE_BYTES`
 *  in attachments-client.ts so a fresh install matches client-side
 *  expectations. Larger files → 413. */
const DEFAULT_MAX_ATTACHMENT_SIZE_MB = 10;
const DEFAULT_MAX_IMAGE_DIMENSION_PX = 2048;

const getMaxAttachmentSizeMb = async (): Promise<number> => {
  const mb = await settings.get<number>("notebooks.max_attachment_size_mb");
  return typeof mb === "number" && Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_ATTACHMENT_SIZE_MB;
};

const getMaxImageDimensionPx = async (): Promise<number> => {
  const px = await settings.get<number>("notebooks.max_image_dimension_px");
  return typeof px === "number" && Number.isFinite(px) && px > 0 ? px : DEFAULT_MAX_IMAGE_DIMENSION_PX;
};

const getMaxAttachmentSizeBytes = async (): Promise<number> => {
  return (await getMaxAttachmentSizeMb()) * 1024 * 1024;
};

const ListNotebooksQuerySchema = z.object({
  ...PaginationQuerySchema.shape,
  q: z.string().optional(),
});

const ListNotesQuerySchema = z.object({
  ...PaginationQuerySchema.shape,
  q: z.string().optional(),
  parentId: ResourceShortIdSchema.optional(),
});

const NoteSearchQuerySchema = z.object({
  ...PaginationQuerySchema.shape,
  q: z.string().max(500).optional(),
  tags: z.string().max(1000).optional().describe("Comma-separated tags; every tag must match"),
  created_after: z.string().datetime({ offset: true }).optional(),
  created_before: z.string().datetime({ offset: true }).optional(),
  updated_after: z.string().datetime({ offset: true }).optional(),
  updated_before: z.string().datetime({ offset: true }).optional(),
});

const GlobalNoteSearchQuerySchema = NoteSearchQuerySchema.extend({
  notebook: ResourceShortIdSchema.optional().describe("Notebook ID"),
});

const NotebookActivityQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  notebook: ResourceShortIdSchema.optional(),
  note: ResourceShortIdSchema.optional(),
});

const parseSearchFilters = (query: z.infer<typeof NoteSearchQuerySchema>) => ({
  query: query.q,
  tags: query.tags?.split(","),
  createdAfter: query.created_after,
  createdBefore: query.created_before,
  updatedAfter: query.updated_after,
  updatedBefore: query.updated_before,
});

// ==========================
// Helpers
// ==========================

const getUserBackedActor = (c: Context<AuthContext>): User | null => {
  const actor = c.get("actor");
  return actor.kind === "user" ? actor.user : actor.delegatedUser;
};
const messages = (c: Context<AuthContext>) => notebookApiMessages.resolve([getLocale(c)]).t;
const notFoundMessage = (message: string) => ({ code: "NOT_FOUND" as const, message, status: 404 as const });

const fallbackServiceMessage = (locale: string, status: number, current: string): string => {
  if (!locale.toLowerCase().startsWith("de")) return current;
  const { t } = notebookApiMessages.resolve([locale]);
  switch (status) {
    case 400:
      return t.requestInvalid;
    case 401:
      return t.authenticationRequired;
    case 403:
      return t.accessDenied;
    case 404:
      return t.resourceNotFound;
    case 409:
      return t.conflict;
    case 429:
      return t.rateLimited;
    default:
      return t.operationFailed;
  }
};

const localizeResult = <T>(result: Result<T>, locale: string): Result<T> => {
  if (result.ok) return result;
  return fail({ ...result.error, message: fallbackServiceMessage(locale, result.error.status, result.error.message) });
};

const localizeMutationResult = <T>(result: MutationResult<T>, locale: string): MutationResult<T> => {
  if (result.ok) return result;
  return { ...result, error: fallbackServiceMessage(locale, result.status, result.error) };
};

const localizeMessageResult = <T extends { message: string }>(
  result: Result<T>,
  locale: string,
  messageKey: "apiKeyRevoked" | "snapshotUploaded",
): Result<T> => {
  const localized = localizeResult(result, locale);
  return localized.ok ? ok({ ...localized.data, message: notebookServiceMessages.resolve([locale]).t[messageKey] }) : localized;
};

const localizeSnapshotConfig = <T extends { missing: string[] }>(config: T, locale: string): T => ({
  ...config,
  missing: config.missing.map((field) => localizeNotebookSnapshotField(field, locale)),
});

const getNotebookActivityActor = (c: Context<AuthContext>) => {
  const actor = c.get("actor");
  return actor.kind === "user"
    ? ({ kind: "user", id: actor.user.id } as const)
    : ({ kind: "service_account", id: actor.serviceAccount.id } as const);
};

const requireUserBackedActor = (c: Context<AuthContext>): Result<User> => {
  const user = getUserBackedActor(c);
  if (!user) {
    return fail(err.forbidden(messages(c).userRequired));
  }
  return ok(user);
};

const PERMISSION_RANK: Record<PermissionLevel, number> = {
  none: 0,
  read: 1,
  write: 2,
  admin: 3,
};

const permissionFromScopes = (scopes: string[]): PermissionLevel => {
  if (scopes.includes("admin")) return "admin";
  if (scopes.includes("write")) return "write";
  if (scopes.includes("read")) return "read";
  return "none";
};

const minPermission = (a: PermissionLevel, b: PermissionLevel): PermissionLevel => (PERMISSION_RANK[a] <= PERMISSION_RANK[b] ? a : b);

const getNotebookAccessSubject = (c: Context<AuthContext>) => {
  const user = getUserBackedActor(c);
  const accessSubject = c.get("accessSubject");
  const actor = c.get("actor");
  const serviceAccount = actor.kind === "service_account" ? actor.serviceAccount : null;
  return {
    user,
    userId: accessSubject.type === "user" ? accessSubject.userId : null,
    serviceAccountId: accessSubject.type === "service_account" ? accessSubject.serviceAccountId : null,
    serviceAccount,
    serviceAccountScopes: actor.kind === "service_account" ? actor.scopes : [],
  };
};

const getCollectionNotebookBinding = (subject: ReturnType<typeof getNotebookAccessSubject>, locale?: string): Result<string | null> => {
  if (!subject.serviceAccountId) return ok(null);
  if (
    subject.serviceAccount?.kind !== "resource_bound" ||
    subject.serviceAccount.appId !== NOTEBOOKS_APP_ID ||
    subject.serviceAccount.resourceType !== NOTEBOOK_RESOURCE_TYPE ||
    !subject.serviceAccount.resourceId ||
    !z.uuid().safeParse(subject.serviceAccount.resourceId).success ||
    !hasPermission(permissionFromScopes(subject.serviceAccountScopes), "read")
  ) {
    return fail(err.forbidden(notebookApiMessages.resolve(locale ? [locale] : []).t.accessDenied));
  }
  return ok(subject.serviceAccount.resourceId);
};

/** Resolve the public notebook ID once, then authorize and operate on its UUID. */
const checkNotebookAccess = async (c: Context<AuthContext>, shortId: string, requiredLevel: PermissionLevel = "read") => {
  const subject = getNotebookAccessSubject(c);
  const notebook = await notebooksService.notebook.getByShortId({ shortId });

  if (!notebook) {
    return {
      notebook: null,
      permission: "none" as PermissionLevel,
      error: await respond(c, fail(notFoundMessage(messages(c).notebookNotFound))),
    };
  }

  if (subject.user && hasRole(subject.user, "admin")) {
    return { notebook, permission: "admin" as PermissionLevel, user: subject.user };
  }

  if (
    subject.serviceAccount?.kind === "resource_bound" &&
    (subject.serviceAccount.appId !== NOTEBOOKS_APP_ID ||
      subject.serviceAccount.resourceType !== NOTEBOOK_RESOURCE_TYPE ||
      subject.serviceAccount.resourceId !== notebook.id)
  ) {
    return {
      notebook: null,
      permission: "none" as PermissionLevel,
      error: await respond(c, fail(err.forbidden(messages(c).accessDenied))),
    };
  }

  let permission = await notebooksService.notebook.permission.get({
    notebookId: notebook.id,
    userId: subject.userId,
    serviceAccountId: subject.serviceAccountId,
  });

  if (subject.serviceAccount?.kind === "resource_bound") {
    permission = minPermission(permission, permissionFromScopes(subject.serviceAccountScopes));
  }

  if (!hasPermission(permission, requiredLevel)) {
    return {
      notebook: null,
      permission: "none" as PermissionLevel,
      error: await respond(c, fail(err.forbidden(messages(c).accessDenied))),
    };
  }

  return { notebook, permission, user: subject.user };
};

/**
 * Wraps mutation results and returns a standardized message payload for API handlers.
 */
const respondMessage = async (c: Context, resultPromise: Promise<Result<void> | MutationResult<void>>, message: string) => {
  return respond(c, async () => {
    const result = await resultPromise;
    if (!result.ok) {
      return "status" in result ? localizeMutationResult(result, getLocale(c)) : localizeResult(result, getLocale(c));
    }
    return ok({ message });
  });
};

/** Resolve a public note ID and enforce notebook ownership before using its UUID. */
const requireNoteInNotebook = async (notebookId: string, noteShortId: string, locale?: string) => {
  const note = await notebooksService.note.getByShortId({ shortId: noteShortId });
  if (!note || note.notebookId !== notebookId) {
    const { t } = notebookApiMessages.resolve(locale ? [locale] : []);
    return fail(notFoundMessage(t.noteNotFound));
  }
  return ok(note);
};

const resolveParentShortIds = async (notes: Array<{ parentId: string | null }>) =>
  notebooksService.note.resolveIdsToShortIds({ ids: notes.flatMap((note) => (note.parentId ? [note.parentId] : [])) });

const toPublicNotes = async (notes: Parameters<typeof toPublicNote>[0][], notebookShortId: string) => {
  const parentShortIds = await resolveParentShortIds(notes);
  return notes.map((note) => toPublicNote(note, notebookShortId, note.parentId ? (parentShortIds.get(note.parentId) ?? null) : null));
};

const toPublicNoteResult = async (
  resultPromise: Promise<MutationResult<Parameters<typeof toPublicNote>[0]>>,
  notebookShortId: string,
  locale?: string,
) => {
  const result = localizeMutationResult(await resultPromise, locale ?? "en");
  if (!result.ok) return result;
  const [note] = await toPublicNotes([result.data], notebookShortId);
  return { ...result, data: note! };
};

const toPublicNotebookResult = async (resultPromise: Promise<MutationResult<Parameters<typeof toPublicNotebook>[0]>>, locale?: string) => {
  const result = localizeMutationResult(await resultPromise, locale ?? "en");
  return result.ok ? { ...result, data: toPublicNotebook(result.data) } : result;
};

type InternalNoteTreeNode = Parameters<typeof toPublicNote>[0] & { children: InternalNoteTreeNode[] };
type PublicNoteTreeNode = ReturnType<typeof toPublicNote> & { children: PublicNoteTreeNode[] };

const flattenNoteTree = (nodes: InternalNoteTreeNode[]): InternalNoteTreeNode[] =>
  nodes.flatMap((node) => [node, ...flattenNoteTree(node.children)]);

const toPublicNoteTree = async (nodes: InternalNoteTreeNode[], notebookShortId: string) => {
  const parentShortIds = await resolveParentShortIds(flattenNoteTree(nodes));
  const project = (node: InternalNoteTreeNode): PublicNoteTreeNode => ({
    ...toPublicNote(node, notebookShortId, node.parentId ? (parentShortIds.get(node.parentId) ?? null) : null),
    children: node.children.map(project),
  });
  return nodes.map(project);
};

const fileTooLarge = (c: Context, maxBytes: number) =>
  respond(c, {
    ok: false,
    error: notebookApiMessages.resolve([getLocale(c)]).t.fileTooLarge({ max: Math.round(maxBytes / 1024 / 1024) }),
    status: 413,
  });

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

const notePdfFilename = (title: string): string => {
  const cleaned =
    title
      .replace(/[\r\n/:*?"<>|\\]/gu, "-")
      .replace(/\s+/gu, " ")
      .trim() || "note";
  return `${cleaned.slice(0, 251)}.pdf`;
};

const notePdfDisposition = (filename: string): string => {
  const fallback =
    filename
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/gu, "")
      .replace(/[^\x20-\x7e]/gu, "_")
      .replace(/["\\]/gu, "_") || "note.pdf";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename).replace(
    /['()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )}`;
};

const notePdfError = (error: unknown, locale?: string): { message: string; status: 413 | 422 | 502 | 503 | 504 } => {
  const { t } = notebookApiMessages.resolve(locale ? [locale] : []);
  if (error instanceof MarkdownPdfError) {
    const message =
      error.reason === "css_too_large"
        ? t.cssTooLarge
        : error.reason === "markdown_empty"
          ? t.pdfMarkdownEmpty
          : error.reason === "unknown_template"
            ? t.pdfTemplateUnknown
            : error.code === "invalid_css"
              ? t.pdfCssInvalid
              : error.code === "external_asset_unsupported"
                ? t.pdfExternalAsset
                : t.pdfMarkdownInvalid;
    return { message, status: 422 };
  }
  if (error instanceof GotenbergRenderError) {
    switch (error.code) {
      case "html_too_large":
      case "pdf_too_large":
        return { message: t.pdfFailed, status: 413 };
      case "not_configured":
        return { message: t.pdfNotConfigured, status: 503 };
      case "timeout":
        return { message: t.pdfTimeout, status: 504 };
      default:
        return { message: t.pdfFailed, status: 502 };
    }
  }
  return { message: t.pdfFailed, status: 502 };
};

// ==========================
// Routes
// ==========================
//
// This Hono is mounted at `/api/notebooks`, so its sub-routes become:
//   /api/notebooks/widget/*  — dashboard widget endpoints (own auth)
//   /api/notebooks/ws/*      — Yjs realtime collab WebSocket (own auth)
//   /api/notebooks/...       — CRUD endpoints (auth.requireRole("authenticated"))
//
// Widget + WS mount BEFORE the auth middleware so they keep their own
// permission gating instead of inheriting `requireRole("authenticated")`.

import wsRoutes from "../ws";
import templatesRoutes from "./templates";
import widgetRoutes from "./widgets";

const app = new Hono<AuthContext>()
  .route("/widget", widgetRoutes)
  .route("/ws", wsRoutes)
  .use(rateLimit())
  .use(auth.requireRole("authenticated"))
  .route("/templates", templatesRoutes)

  // ==========================
  // NOTEBOOKS
  // ==========================

  // List Notebooks
  .get(
    "/",
    describeRoute({
      tags: ["Notebooks"],
      summary: "List notebooks",
      description: "List all notebooks accessible to the current user.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(
          z.object({
            data: z.array(NotebookSchema),
            pagination: PaginationResponseSchema,
          }),
          "Paginated list of notebooks",
        ),
      },
    }),
    v("query", ListNotebooksQuerySchema),
    async (c) => {
      const subject = getNotebookAccessSubject(c);
      const binding = getCollectionNotebookBinding(subject, getLocale(c));
      if (!binding.ok) return respond(c, binding);
      const query = c.req.valid("query");
      const pagination = parsePagination(query);
      const result = await notebooksService.notebook.list({
        userId: subject.userId,
        serviceAccountId: subject.serviceAccountId,
        boundNotebookId: binding.data,
        pagination,
        filter: { query: query.q },
      });
      return respond(
        c,
        ok({
          data: result.items.map(toPublicNotebook),
          pagination: createPagination(pagination, result.total),
        }),
      );
    },
  )

  // Create Notebook
  .post(
    "/",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Create notebook",
      description: "Create a new notebook. Creator automatically gets admin access.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(NotebookSchema, "Created notebook"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
      },
    }),
    v("json", CreateNotebookSchema),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const user = userResult.data;
      const data = c.req.valid("json");
      return respond(c, toPublicNotebookResult(notebooksService.notebook.create({ data, creatorId: user.id }), getLocale(c)));
    },
  )

  // Search accessible notes across notebooks. This static route must stay
  // before `/:id` so Hono does not interpret "search" as a notebook id.
  .get(
    "/search",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Search accessible notes",
      description: "Full-text search across accessible notebooks with optional notebook, tag, and timestamp filters.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(z.object({ data: z.array(NoteSearchHitSchema), pagination: PaginationResponseSchema }), "Search results"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
      },
    }),
    v("query", GlobalNoteSearchQuerySchema),
    async (c) => {
      const subject = getNotebookAccessSubject(c);
      const binding = getCollectionNotebookBinding(subject, getLocale(c));
      if (!binding.ok) return respond(c, binding);
      const query = c.req.valid("query");
      const pagination = parsePagination(query);

      let notebookId: string | undefined = binding.data ?? undefined;
      if (query.notebook) {
        const checked = await checkNotebookAccess(c, query.notebook);
        if (checked.error) return checked.error;
        notebookId = checked.notebook!.id;
      }

      const result = await notebooksService.note.searchAcross({
        userId: subject.userId,
        serviceAccountId: subject.serviceAccountId,
        boundNotebookId: binding.data,
        notebookId,
        filters: parseSearchFilters(query),
        pagination,
      });
      const parentShortIds = await resolveParentShortIds(result.hits.map((hit) => hit.note));
      return respond(
        c,
        ok({
          data: result.hits.map(({ note, ...hit }) => {
            const projected = toPublicNote(note, hit.notebook.shortId, note.parentId ? (parentShortIds.get(note.parentId) ?? null) : null);
            const { contentMd: _contentMd, ...summary } = projected;
            return {
              ...hit,
              note: summary,
              notebook: { id: hit.notebook.shortId, name: hit.notebook.name, icon: hit.notebook.icon },
            };
          }),
          pagination: createPagination(pagination, result.total),
        }),
      );
    },
  )

  .get(
    "/overview/activity",
    describeRoute({
      tags: ["Notebooks"],
      summary: "List notebook activity",
      description: "List durable activity across accessible notebooks, optionally filtered to one notebook or note.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(z.object({ data: z.array(NotebookActivitySchema), nextCursor: z.string().nullable() }), "Notebook activity"),
        400: jsonResponse(ErrorResponseSchema, "Invalid cursor or filter"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Notebook or note not found"),
      },
    }),
    v("query", NotebookActivityQuerySchema),
    async (c) => {
      const subject = getNotebookAccessSubject(c);
      const binding = getCollectionNotebookBinding(subject, getLocale(c));
      if (!binding.ok) return respond(c, binding);
      const query = c.req.valid("query");
      let notebookId: string | null = binding.data;
      let noteId: string | null = null;

      if (query.notebook) {
        const checked = await checkNotebookAccess(c, query.notebook);
        if (checked.error) return checked.error;
        notebookId = checked.notebook!.id;
      }

      if (query.note) {
        const note = await notebooksService.note.getByShortId({ shortId: query.note });
        if (!note) return respond(c, fail(notFoundMessage(messages(c).noteNotFound)));
        const notebook = await notebooksService.notebook.get({ id: note.notebookId });
        if (!notebook) return respond(c, fail(notFoundMessage(messages(c).notebookNotFound)));
        const checked = await checkNotebookAccess(c, notebook.shortId);
        if (checked.error) return checked.error;
        if (notebookId && notebookId !== note.notebookId) {
          return respond(c, fail(err.badInput(messages(c).noteNotebookMismatch)));
        }
        notebookId = note.notebookId;
        noteId = note.id;
      }

      try {
        const page = await notebooksService.activity.list({
          userId: subject.userId,
          serviceAccountId: subject.serviceAccountId,
          bypassAccess: Boolean(subject.user && hasRole(subject.user, "admin")),
          notebookId,
          noteId,
          cursor: query.cursor,
          limit: query.limit,
        });
        return respond(
          c,
          ok({
            data: page.items.map((item) => ({
              ...item,
              notebook: {
                id: item.notebook.shortId,
                name: item.notebook.name,
                icon: item.notebook.icon,
              },
              note: item.note ? { id: item.note.shortId, title: item.note.title } : null,
            })),
            nextCursor: page.nextCursor,
          }),
        );
      } catch (error) {
        if (error instanceof InvalidActivityCursorError) {
          return respond(c, fail(err.badInput(messages(c).invalidActivityCursor)));
        }
        throw error;
      }
    },
  )

  // Get Notebook
  .get(
    "/:id",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Get notebook",
      description: "Get notebook details.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(NotebookSchema, "Notebook details"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Notebook not found"),
      },
    }),
    async (c) => {
      const id = c.req.param("id")!;

      const { notebook, error } = await checkNotebookAccess(c, id);
      if (error) return error;

      return respond(c, ok(toPublicNotebook(notebook!)));
    },
  )

  // Update Notebook
  .patch(
    "/:id",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Update notebook",
      description:
        "Update notebook settings. Requires write permission; scripting and the default presentation mode require admin permission.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(NotebookSchema, "Updated notebook"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Notebook not found"),
      },
    }),
    v("json", UpdateNotebookSchema),
    async (c) => {
      const data = c.req.valid("json");

      const requiredLevel = data.defaultPresentationMode !== undefined ? "admin" : "write";
      const { notebook, error } = await checkNotebookAccess(c, c.req.param("id")!, requiredLevel);
      if (error) return error;

      let homepageNoteId = data.homepageNoteId;
      if (homepageNoteId) {
        const homepage = await requireNoteInNotebook(notebook!.id, homepageNoteId, getLocale(c));
        if (!homepage.ok) return respond(c, homepage);
        homepageNoteId = homepage.data.id;
      }

      return respond(
        c,
        toPublicNotebookResult(
          notebooksService.notebook.update({
            id: notebook!.id,
            data: { ...data, homepageNoteId },
            dateConfig: getDateConfig(c),
          }),
          getLocale(c),
        ),
      );
    },
  )

  // Delete Notebook
  .delete(
    "/:id",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Delete notebook",
      description: "Delete a notebook and all its notes. Requires admin permission.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Notebook deleted"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Notebook not found"),
      },
    }),
    async (c) => {
      const { notebook, error } = await checkNotebookAccess(c, c.req.param("id")!, "admin");
      if (error) return error;
      return respondMessage(c, notebooksService.notebook.remove({ id: notebook!.id }), messages(c).notebookDeleted);
    },
  )

  // ==========================
  // NOTES
  // ==========================

  // Get Note Tree
  .get(
    "/:id/tree",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Get note tree",
      description: "Get the complete hierarchical tree of notes in a notebook.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(z.array(NoteTreeNodeSchema), "Note tree"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Notebook not found"),
      },
    }),
    async (c) => {
      let notebookId = c.req.param("id")!;

      const { notebook, error } = await checkNotebookAccess(c, notebookId);
      if (error) return error;
      notebookId = notebook!.id;

      const tree = await notebooksService.note.getTree({ notebookId });
      return respond(c, ok(await toPublicNoteTree(tree, notebook!.shortId)));
    },
  )

  // Canonical browser snapshot for the mounted notebook workspace
  .get(
    "/:id/workspace-state",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Get notebook workspace state",
      description: "Returns the authorized durable state rendered by the mounted notebook workspace.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(WorkspaceStateSchema, "Notebook workspace state"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Notebook not found"),
      },
    }),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const { notebook, error } = await checkNotebookAccess(c, c.req.param("id")!);
      if (error) return error;

      const [tree, favoriteRows, tags, attachmentCount] = await Promise.all([
        notebooksService.note.getTree({ notebookId: notebook!.id }),
        notebooksService.note.favorites.listIds({ notebookId: notebook!.id, userId: userResult.data.id }),
        notebooksService.tag.listForNotebook({ notebookId: notebook!.id }),
        notebooksService.attachment.count({ notebookId: notebook!.id }),
      ]);
      return respond(
        c,
        ok({
          notebook: toPublicNotebook(notebook!),
          tree: await toPublicNoteTree(tree, notebook!.shortId),
          favoriteNoteIds: favoriteRows.map((row) => row.noteId),
          tags,
          attachmentCount,
        }),
      );
    },
  )

  // Server-computed route state for enhanced note navigation
  .get(
    "/:id/book",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Load a Book page",
      ...requiresAuth,
      description:
        "Returns server-rendered Book content and reading navigation for a note or tag in this notebook. Never includes collaboration state.",
      responses: {
        200: jsonResponse(BookSnapshotSchema, "Book page"),
        400: jsonResponse(ErrorResponseSchema, "Invalid Book target"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Page not found"),
      },
    }),
    v("query", RouteStateQuerySchema),
    async (c) => {
      const actor = requireUserBackedActor(c);
      if (!actor.ok) return respond(c, actor);
      const { notebook, error } = await checkNotebookAccess(c, c.req.param("id")!);
      if (error) return error;
      const result = await loadBookRoute({
        notebookId: notebook!.id,
        notebookShortId: notebook!.shortId,
        userId: actor.data.id,
        bypassAccess: hasRole(actor.data, "admin"),
        locale: getLocale(c),
        origin: new URL(c.req.url).origin,
        href: c.req.valid("query").href,
      });
      c.header("Cache-Control", "private, no-store");
      if (result.kind === "denied") return respond(c, fail(err.forbidden(messages(c).accessDenied)));
      if (result.kind === "not_found") return respond(c, fail(notFoundMessage(messages(c).noteNotFound)));
      if (result.kind === "invalid") return respond(c, fail(err.badInput(messages(c).invalidBookTarget)));
      return respond(c, ok(result.snapshot));
    },
  )
  .post(
    "/:id/notes/:noteId/block-preview",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Preview query and contents blocks",
      ...requiresAuth,
      description:
        "Omit markdown to preview the saved note with read access. Supplying a draft requires write access and an unlocked note; nothing is saved.",
      responses: {
        200: jsonResponse(BlockPreviewSchema, "Rendered blocks and source diagnostics"),
        403: jsonResponse(ErrorResponseSchema, "Access denied or note locked"),
        404: jsonResponse(ErrorResponseSchema, "Note not found"),
        413: jsonResponse(ErrorResponseSchema, "Preview request too large"),
      },
    }),
    bodyLimit({ maxSize: BLOCK_PREVIEW_MAX_REQUEST_BYTES }),
    v("json", BlockPreviewInputSchema),
    async (c) => {
      const actor = requireUserBackedActor(c);
      if (!actor.ok) return respond(c, actor);
      const { markdown } = c.req.valid("json");
      const { notebook, error } = await checkNotebookAccess(c, c.req.param("id")!, markdown === undefined ? "read" : "write");
      if (error) return error;
      const result = await loadBookBlockPreview({
        notebookId: notebook!.id,
        notebookShortId: notebook!.shortId,
        noteShortId: c.req.param("noteId")!,
        userId: actor.data.id,
        bypassAccess: hasRole(actor.data, "admin"),
        locale: getLocale(c),
        ...(markdown === undefined ? {} : { markdown }),
      });
      c.header("Cache-Control", "private, no-store");
      if (result.kind === "denied") return respond(c, fail(err.forbidden(messages(c).accessDenied)));
      if (result.kind === "not_found") return respond(c, fail(notFoundMessage(messages(c).noteNotFound)));
      return respond(c, ok(result.preview));
    },
  )
  .get(
    "/:id/route-state",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Resolve notebook route state",
      description:
        "Returns server-computed route state for enhanced navigation inside a mounted notebook workspace. Non-handleable targets return kind=fallback.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(RouteStateResponseSchema, "Route state"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Notebook not found"),
      },
    }),
    v("query", RouteStateQuerySchema),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const user = userResult.data;
      const { notebook, permission, error } = await checkNotebookAccess(c, c.req.param("id")!);
      if (error) return error;

      const data = await loadEditableNoteRouteData({
        notebookId: notebook!.id,
        notebookShortId: notebook!.shortId,
        href: c.req.valid("query").href,
        origin: new URL(c.req.url).origin,
        canWrite: permission === "write" || permission === "admin",
        defaultPresentationMode: notebook!.defaultPresentationMode,
        userId: user.id,
        bypassAccess: hasRole(user, "admin"),
      });

      return respond(c, ok(data));
    },
  )

  // List current user's favorite note ids
  .get(
    "/:id/favorites",
    describeRoute({
      tags: ["Notebooks"],
      summary: "List favorite notes",
      description: "List the current user's favorite notes in a notebook.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(z.array(FavoriteNoteSchema), "Favorite note ids"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Notebook not found"),
      },
    }),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const user = userResult.data;
      let notebookId = c.req.param("id")!;
      const { notebook, error } = await checkNotebookAccess(c, notebookId);
      if (error) return error;
      notebookId = notebook!.id;
      const favorites = await notebooksService.note.favorites.listIds({ notebookId, userId: user.id });
      return respond(c, ok(favorites));
    },
  )

  // List Notes (flat)
  .get(
    "/:id/notes",
    describeRoute({
      tags: ["Notebooks"],
      summary: "List notes",
      description: "List all notes in a notebook (flat list).",
      ...requiresAuth,
      responses: {
        200: jsonResponse(
          z.object({
            data: z.array(NoteSchema),
            pagination: PaginationResponseSchema,
          }),
          "Paginated list of notes",
        ),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Notebook not found"),
      },
    }),
    v("query", ListNotesQuerySchema),
    async (c) => {
      let notebookId = c.req.param("id")!;
      const query = c.req.valid("query");
      const pagination = parsePagination(query);

      const { notebook, error } = await checkNotebookAccess(c, notebookId);
      if (error) return error;
      notebookId = notebook!.id;

      let parentId: string | undefined;
      if (query.parentId) {
        const parent = await requireNoteInNotebook(notebookId, query.parentId, getLocale(c));
        if (!parent.ok) return respond(c, parent);
        parentId = parent.data.id;
      }

      const result = await notebooksService.note.list({
        notebookId,
        pagination,
        filter: {
          query: query.q,
          parentId,
        },
      });
      return respond(
        c,
        ok({
          data: await toPublicNotes(result.items, notebook!.shortId),
          pagination: createPagination(pagination, result.total),
        }),
      );
    },
  )

  // Create Note
  .post(
    "/:id/notes",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Create note",
      description: "Create a new note in a notebook.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(NoteSchema, "Created note"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Notebook not found"),
      },
    }),
    v("json", CreateNoteSchema),
    async (c) => {
      let notebookId = c.req.param("id")!;
      const data = c.req.valid("json");

      const { notebook, user, error } = await checkNotebookAccess(c, notebookId, "write");
      if (error) return error;
      notebookId = notebook!.id;
      let parentId = data.parentId;
      if (parentId) {
        const parentResult = await requireNoteInNotebook(notebookId, parentId, getLocale(c));
        if (!parentResult.ok) return respond(c, parentResult);
        parentId = parentResult.data.id;
      }
      return respond(
        c,
        toPublicNoteResult(
          notebooksService.note.create({
            data: { ...data, notebookId, parentId },
            creatorId: user?.id ?? null,
            actor: getNotebookActivityActor(c),
            dateConfig: getDateConfig(c),
          }),
          notebook!.shortId,
          getLocale(c),
        ),
      );
    },
  )

  // Get Note
  .get(
    "/:id/notes/:noteId",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Get note",
      description: "Get note details without content.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(NoteSchema, "Note details"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Note not found"),
      },
    }),
    async (c) => {
      let notebookId = c.req.param("id")!;
      let noteId = c.req.param("noteId")!;

      const { notebook, error } = await checkNotebookAccess(c, notebookId);
      if (error) return error;
      notebookId = notebook!.id;

      const note = await requireNoteInNotebook(notebookId, noteId, getLocale(c));
      if (!note.ok) return respond(c, note);
      const [data] = await toPublicNotes([note.data], notebook!.shortId);
      return respond(c, ok(data!));
    },
  )

  .get(
    "/:id/notes/:noteId/comments/page",
    describeRoute({
      tags: ["Notebooks"],
      summary: "List note comments",
      description: "List one bounded page of comments attached to a note, newest first.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(NoteCommentPageSchema, "Paginated note discussion"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Note not found"),
      },
    }),
    v("query", PaginationQuerySchema),
    async (c) => {
      let notebookId = c.req.param("id")!;
      const noteShortId = c.req.param("noteId")!;
      const { notebook, user, error } = await checkNotebookAccess(c, notebookId);
      if (error) return error;
      notebookId = notebook!.id;
      const note = await requireNoteInNotebook(notebookId, noteShortId, getLocale(c));
      if (!note.ok) return respond(c, note);

      const page = await notebooksService.note.comments.listPage({
        notebookId,
        noteId: note.data.id,
        viewerUserId: user?.id ?? null,
        pagination: parsePagination(c.req.valid("query")),
      });
      return respond(
        c,
        ok({ ...page, items: page.items.map((comment) => toPublicNoteComment(comment, notebook!.shortId, note.data.shortId)) }),
      );
    },
  )

  .post(
    "/:id/notes/:noteId/comments",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Add a note comment",
      description: "Add Markdown discussion context to one note. Requires notebook write permission and a user-backed actor.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(NoteCommentSchema, "Created comment"),
        400: jsonResponse(ErrorResponseSchema, "Invalid comment"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Note not found"),
      },
    }),
    v("json", NoteCommentInputSchema),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const user = userResult.data;
      let notebookId = c.req.param("id")!;
      const noteShortId = c.req.param("noteId")!;
      const { notebook, error } = await checkNotebookAccess(c, notebookId, "write");
      if (error) return error;
      notebookId = notebook!.id;
      const note = await requireNoteInNotebook(notebookId, noteShortId, getLocale(c));
      if (!note.ok) return respond(c, note);

      const result = localizeResult(
        await notebooksService.note.comments.create({
          notebookId,
          noteId: note.data.id,
          authorUserId: user.id,
          authorDisplayName: user.displayName ?? user.uid,
          content: c.req.valid("json").content,
        }),
        getLocale(c),
      );
      return respond(c, result.ok ? ok(toPublicNoteComment(result.data, notebook!.shortId, note.data.shortId)) : result);
    },
  )

  .patch(
    "/:id/notes/:noteId/comments/:commentId",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Update a note comment",
      description: "Only the original author may edit a comment within 10 minutes. Requires notebook write permission.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(NoteCommentSchema, "Updated comment"),
        403: jsonResponse(ErrorResponseSchema, "Not authorized"),
        404: jsonResponse(ErrorResponseSchema, "Comment not found"),
      },
    }),
    v("json", NoteCommentInputSchema),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const user = userResult.data;
      let notebookId = c.req.param("id")!;
      const noteShortId = c.req.param("noteId")!;
      const { notebook, error } = await checkNotebookAccess(c, notebookId, "write");
      if (error) return error;
      notebookId = notebook!.id;
      const note = await requireNoteInNotebook(notebookId, noteShortId, getLocale(c));
      if (!note.ok) return respond(c, note);

      const result = localizeResult(
        await notebooksService.note.comments.update({
          notebookId,
          noteId: note.data.id,
          commentId: c.req.param("commentId")!,
          authorUserId: user.id,
          content: c.req.valid("json").content,
        }),
        getLocale(c),
      );
      return respond(c, result.ok ? ok(toPublicNoteComment(result.data, notebook!.shortId, note.data.shortId)) : result);
    },
  )

  .delete(
    "/:id/notes/:noteId/comments/:commentId",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Delete a note comment",
      description: "Only the original author may delete a comment within 10 minutes. Requires notebook write permission.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Comment deleted"),
        403: jsonResponse(ErrorResponseSchema, "Not authorized"),
        404: jsonResponse(ErrorResponseSchema, "Comment not found"),
      },
    }),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const user = userResult.data;
      let notebookId = c.req.param("id")!;
      const noteShortId = c.req.param("noteId")!;
      const { notebook, error } = await checkNotebookAccess(c, notebookId, "write");
      if (error) return error;
      notebookId = notebook!.id;
      const note = await requireNoteInNotebook(notebookId, noteShortId, getLocale(c));
      if (!note.ok) return respond(c, note);

      return respondMessage(
        c,
        notebooksService.note.comments.remove({
          notebookId,
          noteId: note.data.id,
          commentId: c.req.param("commentId")!,
          authorUserId: user.id,
        }),
        messages(c).commentDeleted,
      );
    },
  )

  // Set current user's favorite state for one note
  .put(
    "/:id/notes/:noteId/favorite",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Set note favorite",
      description: "Set whether the current user has favorited a note.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(FavoriteStateSchema, "Favorite state"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Note not found"),
      },
    }),
    v("json", SetFavoriteSchema),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const user = userResult.data;
      let notebookId = c.req.param("id")!;
      let noteId = c.req.param("noteId")!;
      const data = c.req.valid("json");

      const { notebook, error } = await checkNotebookAccess(c, notebookId);
      if (error) return error;
      notebookId = notebook!.id;
      const noteCheck = await requireNoteInNotebook(notebookId, noteId, getLocale(c));
      if (!noteCheck.ok) return respond(c, noteCheck);
      noteId = noteCheck.data.id;

      return respond(
        c,
        localizeMutationResult(
          await notebooksService.note.favorites.set({ notebookId, noteId, userId: user.id, favorite: data.favorite }),
          getLocale(c),
        ),
      );
    },
  )

  // Get Note with Content
  .get(
    "/:id/notes/:noteId/content",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Get note with content",
      description: "Get note details with Yjs snapshot (base64 encoded).",
      ...requiresAuth,
      responses: {
        200: jsonResponse(NoteWithContentSchema, "Note with content"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Note not found"),
      },
    }),
    async (c) => {
      let notebookId = c.req.param("id")!;
      let noteId = c.req.param("noteId")!;

      const { notebook, error } = await checkNotebookAccess(c, notebookId);
      if (error) return error;
      notebookId = notebook!.id;

      const note = await notebooksService.note.getWithContentByShortId({ shortId: noteId });
      if (!note || note.notebookId !== notebookId) {
        return respond(c, fail(notFoundMessage(messages(c).noteNotFound)));
      }
      const [data] = await toPublicNotes([note], notebook!.shortId);
      return respond(c, ok({ ...data!, yjsSnapshot: note.yjsSnapshot }));
    },
  )

  // Render the current browser-side Markdown snapshot without persisting it.
  .post(
    "/:id/notes/:noteId/pdf",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Download note as PDF",
      description: "Render a bounded Markdown snapshot as PDF without storing the input or generated file.",
      ...requiresAuth,
      responses: {
        200: {
          description: "Generated PDF",
          content: { "application/pdf": { schema: { type: "string", format: "binary" } } },
        },
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Note not found"),
        413: jsonResponse(ErrorResponseSchema, "Input or output too large"),
        422: jsonResponse(ErrorResponseSchema, "Markdown or CSS could not be rendered"),
        502: jsonResponse(ErrorResponseSchema, "PDF renderer failed"),
        503: jsonResponse(ErrorResponseSchema, "PDF renderer unavailable or busy"),
        504: jsonResponse(ErrorResponseSchema, "PDF renderer timed out"),
      },
    }),
    bodyLimit({
      maxSize: NOTE_PDF_MAX_REQUEST_BYTES,
      onError: (c) => respond(c, { ok: false, error: messages(c).requestTooLarge, status: 413 }),
    }),
    v("json", NotePdfRequestSchema),
    async (c) => {
      let notebookId = c.req.param("id")!;
      const noteId = c.req.param("noteId")!;
      const input = c.req.valid("json");

      const { notebook, error } = await checkNotebookAccess(c, notebookId);
      if (error) return error;
      notebookId = notebook!.id;
      const note = await requireNoteInNotebook(notebookId, noteId, getLocale(c));
      if (!note.ok) return respond(c, note);

      if (byteLength(input.markdown) > MARKDOWN_PDF_MAX_MARKDOWN_BYTES) {
        return respond(c, { ok: false, error: messages(c).markdownTooLarge, status: 413 });
      }
      if (input.customCss && byteLength(input.customCss) > MARKDOWN_PDF_MAX_CUSTOM_CSS_BYTES) {
        return respond(c, { ok: false, error: messages(c).cssTooLarge, status: 413 });
      }
      if (activeNotePdfConversions >= NOTE_PDF_MAX_ACTIVE_CONVERSIONS) {
        return respond(c, { ok: false, error: messages(c).pdfBusy, status: 503 });
      }

      activeNotePdfConversions += 1;
      try {
        const rendered = await renderMarkdownToPdf({
          markdown: input.markdown,
          templateId: input.templateId,
          customCss: input.customCss,
        });
        const filename = notePdfFilename(note.data.title);
        const buffer = rendered.pdf.buffer.slice(rendered.pdf.byteOffset, rendered.pdf.byteOffset + rendered.pdf.byteLength) as ArrayBuffer;
        return new Response(new Blob([buffer], { type: "application/pdf" }), {
          headers: {
            "Cache-Control": "private, no-store",
            "Content-Disposition": notePdfDisposition(filename),
            "Content-Type": "application/pdf",
            "X-Content-Type-Options": "nosniff",
          },
        });
      } catch (cause) {
        const projected = notePdfError(cause, getLocale(c));
        return respond(c, { ok: false, error: projected.message, status: projected.status });
      } finally {
        activeNotePdfConversions -= 1;
      }
    },
  )

  // Edit Note Content
  .patch(
    "/:id/notes/:noteId/content",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Edit note content",
      description: "Apply structured line or named-block markdown edits to a note.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(EditNoteContentResponseSchema, "Edited note content"),
        400: jsonResponse(ErrorResponseSchema, "Invalid edit"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Note not found"),
        409: jsonResponse(ErrorResponseSchema, "Edit conflict"),
      },
    }),
    v("json", EditNoteContentSchema),
    async (c) => {
      let notebookId = c.req.param("id")!;
      let noteId = c.req.param("noteId")!;
      const data = c.req.valid("json");

      const { notebook, user, error } = await checkNotebookAccess(c, notebookId, "write");
      if (error) return error;
      notebookId = notebook!.id;
      const noteCheck = await requireNoteInNotebook(notebookId, noteId, getLocale(c));
      if (!noteCheck.ok) return respond(c, noteCheck);
      noteId = noteCheck.data.id;

      const result = await notebooksService.note.editContent({
        noteId,
        data,
        createdBy: user?.id ?? null,
        actor: getNotebookActivityActor(c),
      });
      if (!result.ok) return respond(c, localizeMutationResult(result, getLocale(c)));
      const [note] = await toPublicNotes([result.data.note], notebook!.shortId);
      return respond(c, ok({ ...result.data, note: note! }));
    },
  )

  // Update Note
  .patch(
    "/:id/notes/:noteId",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Update note",
      description: "Update note position or parent. The title is derived from Markdown content.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(NoteSchema, "Updated note"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Note not found"),
      },
    }),
    v("json", UpdateNoteSchema),
    async (c) => {
      let notebookId = c.req.param("id")!;
      let noteId = c.req.param("noteId")!;
      const data = c.req.valid("json");

      const { notebook, error } = await checkNotebookAccess(c, notebookId, "write");
      if (error) return error;
      notebookId = notebook!.id;
      const noteCheck = await requireNoteInNotebook(notebookId, noteId, getLocale(c));
      if (!noteCheck.ok) return respond(c, noteCheck);
      noteId = noteCheck.data.id;
      let parentId = data.parentId;
      if (parentId) {
        const parent = await requireNoteInNotebook(notebookId, parentId, getLocale(c));
        if (!parent.ok) return respond(c, parent);
        parentId = parent.data.id;
      }
      return respond(
        c,
        toPublicNoteResult(notebooksService.note.update({ id: noteId, data: { ...data, parentId } }), notebook!.shortId, getLocale(c)),
      );
    },
  )

  // Move Note
  .post(
    "/:id/notes/:noteId/move",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Move note",
      description: "Move note to a new parent and/or position.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(NoteSchema, "Moved note"),
        400: jsonResponse(ErrorResponseSchema, "Invalid move (e.g., to own descendant)"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Note not found"),
      },
    }),
    v("json", MoveNoteSchema),
    async (c) => {
      let notebookId = c.req.param("id")!;
      let noteId = c.req.param("noteId")!;
      const { parentId, position } = c.req.valid("json");

      const { notebook, error } = await checkNotebookAccess(c, notebookId, "write");
      if (error) return error;
      notebookId = notebook!.id;
      const noteCheck = await requireNoteInNotebook(notebookId, noteId, getLocale(c));
      if (!noteCheck.ok) return respond(c, noteCheck);
      noteId = noteCheck.data.id;
      let resolvedParentId: string | null = null;
      if (parentId) {
        const parent = await requireNoteInNotebook(notebookId, parentId, getLocale(c));
        if (!parent.ok) return respond(c, parent);
        resolvedParentId = parent.data.id;
      }
      return respond(
        c,
        toPublicNoteResult(
          notebooksService.note.move({ id: noteId, parentId: resolvedParentId, position }),
          notebook!.shortId,
          getLocale(c),
        ),
      );
    },
  )

  // Delete Note
  .delete(
    "/:id/notes/:noteId",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Delete note",
      description: "Delete a note and all its children.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Note deleted"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Note not found"),
      },
    }),
    async (c) => {
      let notebookId = c.req.param("id")!;
      let noteId = c.req.param("noteId")!;

      const { notebook, error } = await checkNotebookAccess(c, notebookId, "write");
      if (error) return error;
      notebookId = notebook!.id;
      const noteCheck = await requireNoteInNotebook(notebookId, noteId, getLocale(c));
      if (!noteCheck.ok) return respond(c, noteCheck);
      noteId = noteCheck.data.id;
      return respondMessage(c, notebooksService.note.remove({ id: noteId }), messages(c).noteDeleted);
    },
  )

  // Lock Note
  .post(
    "/:id/notes/:noteId/lock",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Lock note",
      description: "Lock a note permanently. Locked notes cannot be edited or restored from versions. This action cannot be undone.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(NoteSchema, "Locked note"),
        400: jsonResponse(ErrorResponseSchema, "Note already locked"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Note not found"),
      },
    }),
    async (c) => {
      let notebookId = c.req.param("id")!;
      let noteId = c.req.param("noteId")!;

      const { notebook, error } = await checkNotebookAccess(c, notebookId, "write");
      if (error) return error;
      notebookId = notebook!.id;
      const noteCheck = await requireNoteInNotebook(notebookId, noteId, getLocale(c));
      if (!noteCheck.ok) return respond(c, noteCheck);
      noteId = noteCheck.data.id;
      return respond(c, toPublicNoteResult(notebooksService.note.lock({ id: noteId }), notebook!.shortId, getLocale(c)));
    },
  )

  // Copy Note to Another Notebook
  .post(
    "/:id/notes/:noteId/copy",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Copy note",
      description: "Copy a note to another notebook.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(NoteSchema, "Copied note"),
        403: jsonResponse(ErrorResponseSchema, "Access denied to source or target"),
        404: jsonResponse(ErrorResponseSchema, "Note or target notebook not found"),
      },
    }),
    v("json", CopyNoteSchema),
    async (c) => {
      let notebookId = c.req.param("id")!;
      let noteId = c.req.param("noteId")!;
      const { targetNotebookId, targetParentId } = c.req.valid("json");

      // Check source notebook access (read)
      const { notebook: sourceNotebook, user, error: sourceError } = await checkNotebookAccess(c, notebookId);
      if (sourceError) return sourceError;
      notebookId = sourceNotebook!.id;

      // Check target notebook access (write)
      const { notebook: targetNotebook, error: targetError } = await checkNotebookAccess(c, targetNotebookId, "write");
      if (targetError) return targetError;

      let resolvedTargetParentId: string | null | undefined = targetParentId;
      if (targetParentId) {
        const targetParent = await requireNoteInNotebook(targetNotebook!.id, targetParentId, getLocale(c));
        if (!targetParent.ok) return respond(c, targetParent);
        resolvedTargetParentId = targetParent.data.id;
      }

      const noteCheck = await requireNoteInNotebook(notebookId, noteId, getLocale(c));
      if (!noteCheck.ok) return respond(c, noteCheck);
      noteId = noteCheck.data.id;
      return respond(
        c,
        toPublicNoteResult(
          notebooksService.note.copyToNotebook({
            noteId,
            targetNotebookId: targetNotebook!.id,
            targetParentId: resolvedTargetParentId,
            creatorId: user?.id ?? null,
          }),
          targetNotebook!.shortId,
          getLocale(c),
        ),
      );
    },
  )

  // ==========================
  // VERSIONS
  // ==========================

  // List Note Versions
  .get(
    "/:id/notes/:noteId/versions",
    describeRoute({
      tags: ["Notebooks"],
      summary: "List note versions",
      description: "List version history of a note with pagination.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(
          z.object({
            data: z.array(NoteVersionSchema),
            pagination: PaginationResponseSchema,
          }),
          "Version history",
        ),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Note not found"),
      },
    }),
    v("query", PaginationQuerySchema),
    async (c) => {
      let notebookId = c.req.param("id")!;
      let noteId = c.req.param("noteId")!;
      const pagination = parsePagination(c.req.valid("query"));

      const { notebook, error } = await checkNotebookAccess(c, notebookId);
      if (error) return error;
      notebookId = notebook!.id;
      const noteCheck = await requireNoteInNotebook(notebookId, noteId, getLocale(c));
      if (!noteCheck.ok) return respond(c, noteCheck);
      noteId = noteCheck.data.id;

      const { versions, total } = await notebooksService.note.versions.list({
        noteId,
        pagination,
      });
      return respond(
        c,
        ok({
          data: versions.map((version) => ({ ...version, noteId: noteCheck.data.shortId })),
          pagination: createPagination(pagination, total),
        }),
      );
    },
  )

  // Get Version Snapshot
  .get(
    "/:id/notes/:noteId/versions/:versionId",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Get version snapshot",
      description: "Get the Yjs snapshot for a specific version (base64 encoded).",
      ...requiresAuth,
      responses: {
        200: jsonResponse(z.object({ yjsSnapshot: z.string() }), "Version snapshot"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Version not found"),
      },
    }),
    async (c) => {
      let notebookId = c.req.param("id")!;
      let noteId = c.req.param("noteId")!;
      const versionId = c.req.param("versionId")!;

      const { notebook, error } = await checkNotebookAccess(c, notebookId);
      if (error) return error;
      notebookId = notebook!.id;
      const noteCheck = await requireNoteInNotebook(notebookId, noteId, getLocale(c));
      if (!noteCheck.ok) return respond(c, noteCheck);
      noteId = noteCheck.data.id;

      const snapshot = await notebooksService.note.versions.getSnapshot({
        noteId,
        versionId,
      });
      if (!snapshot) {
        return respond(c, fail(notFoundMessage(messages(c).versionNotFound)));
      }

      return respond(c, ok({ yjsSnapshot: Buffer.from(snapshot).toString("base64") }));
    },
  )

  // ==========================
  // RESTORE & SEARCH
  // ==========================

  // Restore Note from Snapshot
  .post(
    "/:id/notes/:noteId/restore",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Restore note from snapshot",
      description: "Restore snapshot data into an empty target note (used by Restore as New Note).",
      ...requiresAuth,
      responses: {
        200: jsonResponse(NoteSchema, "Restored note"),
        400: jsonResponse(ErrorResponseSchema, "Target note must be empty"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Note not found"),
      },
    }),
    v("json", z.object({ yjsSnapshot: z.string() })),
    async (c) => {
      let notebookId = c.req.param("id")!;
      let noteId = c.req.param("noteId")!;
      const { yjsSnapshot } = c.req.valid("json");

      const { notebook, user, error } = await checkNotebookAccess(c, notebookId, "write");
      if (error) return error;
      notebookId = notebook!.id;
      const noteCheck = await requireNoteInNotebook(notebookId, noteId, getLocale(c));
      if (!noteCheck.ok) return respond(c, noteCheck);
      noteId = noteCheck.data.id;
      return respond(
        c,
        toPublicNoteResult(
          notebooksService.note.versions.restore({ noteId, yjsSnapshot, createdBy: user?.id ?? null }),
          notebook!.shortId,
          getLocale(c),
        ),
      );
    },
  )

  // Search Notes
  .get(
    "/:id/search",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Search notes",
      description: "Full-text search within a notebook with optional tag and timestamp filters.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(
          z.object({
            data: z.array(NoteSchema),
            pagination: PaginationResponseSchema,
          }),
          "Search results",
        ),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Notebook not found"),
      },
    }),
    v("query", NoteSearchQuerySchema),
    async (c) => {
      let notebookId = c.req.param("id")!;
      const query = c.req.valid("query");
      const pagination = parsePagination(query);

      const { notebook, error } = await checkNotebookAccess(c, notebookId);
      if (error) return error;
      notebookId = notebook!.id;

      const result = await notebooksService.note.search({
        notebookId,
        filters: parseSearchFilters(query),
        pagination,
      });
      const notes = result.hits.map((hit) => hit.note);
      return respond(
        c,
        ok({
          // Keep the long-standing scoped response compatible. Consumers that
          // need snippets and notebook identity use the global `/search` route.
          data: await toPublicNotes(notes, notebook!.shortId),
          pagination: createPagination(pagination, result.total),
        }),
      );
    },
  )

  // Get Version with Content
  .get(
    "/:id/notes/:noteId/versions/:versionId/content",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Get version with content",
      description: "Get the Yjs snapshot and markdown content for a specific version.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(
          z.object({
            yjsSnapshot: z.string(),
            contentMd: z.string().nullable(),
          }),
          "Version with content",
        ),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Version not found"),
      },
    }),
    async (c) => {
      let notebookId = c.req.param("id")!;
      let noteId = c.req.param("noteId")!;
      const versionId = c.req.param("versionId")!;

      const { notebook, error } = await checkNotebookAccess(c, notebookId);
      if (error) return error;
      notebookId = notebook!.id;
      const noteCheck = await requireNoteInNotebook(notebookId, noteId, getLocale(c));
      if (!noteCheck.ok) return respond(c, noteCheck);
      noteId = noteCheck.data.id;

      const version = await notebooksService.note.versions.getWithContent({
        noteId,
        versionId,
      });
      if (!version) {
        return respond(c, fail(notFoundMessage(messages(c).versionNotFound)));
      }

      return respond(
        c,
        ok({
          yjsSnapshot: Buffer.from(version.yjsSnapshot).toString("base64"),
          contentMd: version.contentMd,
        }),
      );
    },
  )

  // ==========================
  // BACKLINKS
  // ==========================

  // List Backlinks
  .get(
    "/:id/notes/:noteId/backlinks",
    describeRoute({
      tags: ["Notebooks"],
      summary: "List backlinks",
      description: "List notes that link to this note. Filtered by access on the source notebook.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(z.object({ data: z.array(BacklinkSchema) }), "Backlinks"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Note or notebook not found"),
      },
    }),
    async (c) => {
      let notebookId = c.req.param("id")!;
      let noteId = c.req.param("noteId")!;

      const { notebook, error } = await checkNotebookAccess(c, notebookId);
      if (error) return error;
      notebookId = notebook!.id;
      const noteCheck = await requireNoteInNotebook(notebookId, noteId, getLocale(c));
      if (!noteCheck.ok) return respond(c, noteCheck);
      noteId = noteCheck.data.id;

      const subject = getNotebookAccessSubject(c);
      const binding = getCollectionNotebookBinding(subject, getLocale(c));
      if (!binding.ok) return respond(c, binding);
      const items = await notebooksService.note.backlinks.list({
        noteId,
        userId: subject.userId,
        serviceAccountId: subject.serviceAccountId,
        boundNotebookId: binding.data,
        bypassAccess: Boolean(subject.user && hasRole(subject.user, "admin")),
      });

      return respond(c, ok({ data: items }));
    },
  )

  // ==========================
  // GRAPH
  // ==========================

  // Get notebook link graph
  .get(
    "/:id/graph",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Get link graph",
      description: "Return all notes (nodes) and all internal note-links (edges) for the notebook.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(z.object({ data: NoteGraphSchema }), "Graph data"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Notebook not found"),
      },
    }),
    async (c) => {
      let notebookId = c.req.param("id")!;
      const { notebook, error } = await checkNotebookAccess(c, notebookId);
      if (error) return error;
      notebookId = notebook!.id;
      const graph = await notebooksService.notebook.graph({ notebookId });
      return respond(c, ok({ data: graph }));
    },
  )

  // ==========================
  // RESOURCE API KEYS
  // ==========================

  .get(
    "/:id/api-keys",
    describeRoute({
      tags: ["Notebooks"],
      summary: "List notebook API keys",
      description: "List active resource-bound API keys for this notebook. Requires admin permission.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(z.object({ items: z.array(NotebookApiKeySchema) }), "Notebook API keys"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Notebook not found"),
      },
    }),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);

      const { notebook, error } = await checkNotebookAccess(c, c.req.param("id")!, "admin");
      if (error) return error;

      return respond(c, async () => ok({ items: await notebooksService.notebook.access.apiKeys.list({ notebookId: notebook!.id }) }));
    },
  )

  .post(
    "/:id/api-keys",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Create notebook API key",
      description: "Create a resource-bound API key for this notebook. The raw token is returned once. Requires admin permission.",
      ...requiresAuth,
      responses: {
        201: jsonResponse(CreateNotebookApiKeyResponseSchema, "Notebook API key created"),
        400: jsonResponse(ErrorResponseSchema, "Failed to create API key"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Notebook not found"),
      },
    }),
    v("json", CreateNotebookApiKeySchema),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const user = userResult.data;
      const data = c.req.valid("json");
      const { notebook, error } = await checkNotebookAccess(c, c.req.param("id")!, "admin");
      if (error) return error;

      return respond(
        c,
        localizeResult(
          await notebooksService.notebook.access.apiKeys.create({
            notebookId: notebook!.id,
            actor: user,
            notebookName: notebook!.name,
            data: {
              name: data.name,
              expiresAt: data.expiresAt,
              permission: data.permission,
            },
          }),
          getLocale(c),
        ),
        201,
      );
    },
  )

  .delete(
    "/:id/api-keys/:credentialId",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Revoke notebook API key",
      description: "Revoke a resource-bound API key for this notebook. Requires admin permission.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Notebook API key revoked"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "API key not found"),
      },
    }),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const user = userResult.data;
      const credentialId = c.req.param("credentialId")!;
      const { notebook, error } = await checkNotebookAccess(c, c.req.param("id")!, "admin");
      if (error) return error;

      const result = localizeMessageResult(
        await notebooksService.notebook.access.apiKeys.revoke({ notebookId: notebook!.id, credentialId, actor: user }),
        getLocale(c),
        "apiKeyRevoked",
      );
      return respond(c, result);
    },
  )

  // ==========================
  // ACCESS CONTROL
  // ==========================

  // List Access Entries
  .get(
    "/:id/access",
    describeRoute({
      tags: ["Notebooks"],
      summary: "List access entries",
      description: "List all access entries for a notebook. Requires admin permission.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(z.array(AccessEntrySchema), "Access entries"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Notebook not found"),
      },
    }),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      let notebookId = c.req.param("id")!;

      const { notebook, error } = await checkNotebookAccess(c, notebookId, "admin");
      if (error) return error;
      notebookId = notebook!.id;

      const entries = await notebooksService.notebook.access.list({ notebookId });
      return respond(c, ok(entries.items));
    },
  )

  // Grant Access
  .post(
    "/:id/access",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Grant access",
      description: "Grant access to a user, group, or public. Requires admin permission.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(AccessEntrySchema, "Created access entry"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Notebook, user, or group not found"),
        409: jsonResponse(ErrorResponseSchema, "Principal already has access"),
      },
    }),
    v("json", GrantAccessSchema),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      let notebookId = c.req.param("id")!;
      const { principal, permission } = c.req.valid("json");

      const { notebook, error } = await checkNotebookAccess(c, notebookId, "admin");
      if (error) return error;
      notebookId = notebook!.id;
      return respond(
        c,
        localizeResult(
          await notebooksService.notebook.access.grant({
            notebookId,
            principal,
            permission,
          }),
          getLocale(c),
        ),
      );
    },
  )

  // Update Access
  .patch(
    "/:id/access/:accessId",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Update access permission",
      description: "Update the permission level for an access entry. Requires admin permission.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Access updated"),
        400: jsonResponse(ErrorResponseSchema, "Cannot remove last admin"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Access entry not found"),
      },
    }),
    v("json", UpdateAccessSchema),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      let notebookId = c.req.param("id")!;
      const accessId = c.req.param("accessId")!;
      const { permission } = c.req.valid("json");

      const { notebook, error } = await checkNotebookAccess(c, notebookId, "admin");
      if (error) return error;
      notebookId = notebook!.id;

      const guard = await notebooksService.notebook.access.guard({
        notebookId,
        accessId,
      });
      if (!guard.currentPermission) {
        return respond(c, fail(notFoundMessage(messages(c).accessEntryNotFound)));
      }

      if (guard.currentPermission === "admin" && permission !== "admin" && guard.otherAdmins <= 0) {
        return respond(c, fail(err.badInput(messages(c).lastAdmin)));
      }
      return respondMessage(c, notebooksService.notebook.access.update({ notebookId, accessId, permission }), messages(c).accessUpdated);
    },
  )

  // Revoke Access
  .delete(
    "/:id/access/:accessId",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Revoke access",
      description: "Remove an access entry. Cannot remove the last admin. Requires admin permission.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Access revoked"),
        400: jsonResponse(ErrorResponseSchema, "Cannot remove last access entry or admin"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Access entry not found"),
      },
    }),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      let notebookId = c.req.param("id")!;
      const accessId = c.req.param("accessId")!;

      const { notebook, error } = await checkNotebookAccess(c, notebookId, "admin");
      if (error) return error;
      notebookId = notebook!.id;

      const guard = await notebooksService.notebook.access.guard({
        notebookId,
        accessId,
      });
      if (!guard.currentPermission) {
        return respond(c, fail(notFoundMessage(messages(c).accessEntryNotFound)));
      }

      if (guard.total <= 1) {
        return respond(c, fail(err.badInput(messages(c).lastAccess)));
      }

      if (guard.currentPermission === "admin" && guard.otherAdmins <= 0) {
        return respond(c, fail(err.badInput(messages(c).lastAdmin)));
      }
      return respondMessage(
        c,
        notebooksService.notebook.access.remove({
          notebookId,
          accessId,
        }),
        messages(c).accessRevoked,
      );
    },
  );

// =============================================================================
// Attachments — file/image blobs stored as bytea, FK to notebook (CASCADE)
// =============================================================================

const appWithAttachments = app
  // Upload — multipart with `file` field
  .post(
    "/:id/attachments",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Upload attachment",
      description: `Upload a file blob (image or any other type) to a notebook. Max size is configurable via the \`notebooks.max_attachment_size_mb\` admin setting (default ${DEFAULT_MAX_ATTACHMENT_SIZE_MB} MB).`,
      ...requiresAuth,
      responses: {
        200: jsonResponse(AttachmentSchema, "Uploaded attachment metadata"),
        400: jsonResponse(ErrorResponseSchema, "No file or invalid form"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        413: jsonResponse(ErrorResponseSchema, "File too large"),
      },
    }),
    async (c) => {
      let notebookId = c.req.param("id")!;

      const { notebook, user, error } = await checkNotebookAccess(c, notebookId, "write");
      if (error) return error;
      notebookId = notebook!.id;

      const maxBytes = await getMaxAttachmentSizeBytes();
      const contentLength = Number(c.req.header("content-length") ?? 0);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        return fileTooLarge(c, maxBytes);
      }

      const form = await c.req.formData().catch(() => null);
      const file = form?.get("file");
      if (!(file instanceof File)) return respond(c, fail(err.badInput(messages(c).missingFile)));
      if (file.size > maxBytes) {
        return fileTooLarge(c, maxBytes);
      }

      const content = new Uint8Array(await file.arrayBuffer());
      const attachment = await notebooksService.attachment.upload({
        notebookId,
        filename: file.name || "untitled",
        mimeType: file.type || "application/octet-stream",
        content,
        userId: user?.id ?? null,
      });
      return respond(c, ok(toPublicAttachment(attachment, notebook!.shortId)));
    },
  )

  // List
  .get(
    "/:id/attachments",
    describeRoute({
      tags: ["Notebooks"],
      summary: "List attachments",
      ...requiresAuth,
      responses: {
        200: jsonResponse(z.array(AttachmentSchema), "All attachments in this notebook"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
      },
    }),
    async (c) => {
      let notebookId = c.req.param("id")!;
      const { notebook, error } = await checkNotebookAccess(c, notebookId);
      if (error) return error;
      notebookId = notebook!.id;
      const attachments = await notebooksService.attachment.list({ notebookId });
      return respond(c, ok(attachments.map((attachment) => toPublicAttachment(attachment, notebook!.shortId))));
    },
  )

  // Stream content — used by image widgets, file downloads, read-mode renderer
  .get(
    "/:id/attachments/:attId/content",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Download attachment content",
      ...requiresAuth,
      responses: {
        200: { description: "File content stream" },
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Attachment not found"),
      },
    }),
    async (c) => {
      let notebookId = c.req.param("id")!;
      const attId = c.req.param("attId")!;

      const { notebook, error } = await checkNotebookAccess(c, notebookId);
      if (error) return error;
      notebookId = notebook!.id;

      const att = await notebooksService.attachment.getContentByShortId({ shortId: attId });
      if (!att || att.notebookId !== notebookId) return respond(c, fail(notFoundMessage(messages(c).attachmentNotFound)));

      const isSafeInline =
        att.mimeType === "application/pdf" ||
        att.mimeType === "text/plain" ||
        (att.mimeType.startsWith("image/") && att.mimeType !== "image/svg+xml");
      // `inline` query → render-in-browser only for inert media; else download.
      const inline = isSafeInline && (c.req.query("inline") === "true" || att.kind === "image");
      const disposition = `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(att.filename)}"`;
      // Wrap bytea in a fresh ArrayBuffer slice — Postgres' returned
      // Uint8Array is typed `<ArrayBufferLike>` which TS rejects for `BlobPart`.
      const buffer = att.content.buffer.slice(att.content.byteOffset, att.content.byteOffset + att.content.byteLength) as ArrayBuffer;
      const contentType = inline ? att.mimeType : "application/octet-stream";
      return new Response(new Blob([buffer], { type: contentType }), {
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": disposition,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        },
      });
    },
  )

  // Usage count — used by destructive-delete confirmation
  .get(
    "/:id/attachments/:attId/usage",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Count notes referencing an attachment",
      ...requiresAuth,
      responses: {
        200: jsonResponse(AttachmentUsageSchema, "Usage count"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
      },
    }),
    async (c) => {
      let notebookId = c.req.param("id")!;
      const attachmentShortId = c.req.param("attId")!;
      const { notebook, error } = await checkNotebookAccess(c, notebookId);
      if (error) return error;
      notebookId = notebook!.id;
      const att = await notebooksService.attachment.getByShortId({ shortId: attachmentShortId });
      if (!att || att.notebookId !== notebookId) return respond(c, ok({ count: 0 }));
      const count = await notebooksService.attachment.usageCount({ notebookId, attachmentId: att.id });
      return respond(c, ok({ count }));
    },
  )

  // Single-attachment metadata also serves CLI inspect/download.
  // Keep the specific `/content` and `/usage` routes ahead of this route.
  .get(
    "/:id/attachments/:attId",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Get attachment metadata",
      ...requiresAuth,
      responses: {
        200: jsonResponse(AttachmentSchema, "Attachment metadata"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Attachment not found"),
      },
    }),
    async (c) => {
      let notebookId = c.req.param("id")!;
      const attachmentShortId = c.req.param("attId")!;
      const { notebook, error } = await checkNotebookAccess(c, notebookId);
      if (error) return error;
      notebookId = notebook!.id;
      const att = await notebooksService.attachment.getByShortId({ shortId: attachmentShortId });
      if (!att || att.notebookId !== notebookId) return respond(c, fail(notFoundMessage(messages(c).attachmentNotFound)));
      return respond(c, ok(toPublicAttachment(att, notebook!.shortId)));
    },
  )

  // Delete
  .delete(
    "/:id/attachments/:attId",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Delete attachment",
      description: "Removes the blob. Markdown links pointing to it become broken — by design (KISS, no auto-cleanup).",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Deleted"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Attachment not found"),
      },
    }),
    async (c) => {
      let notebookId = c.req.param("id")!;
      const attachmentShortId = c.req.param("attId")!;
      const { notebook, error } = await checkNotebookAccess(c, notebookId, "write");
      if (error) return error;
      notebookId = notebook!.id;
      const att = await notebooksService.attachment.getByShortId({ shortId: attachmentShortId });
      if (!att || att.notebookId !== notebookId) return respond(c, fail(notFoundMessage(messages(c).attachmentNotFound)));
      await notebooksService.attachment.remove({ id: att.id });
      return respond(c, ok({ message: messages(c).attachmentDeleted }));
    },
  );

// =============================================================================
// Export — portable ZIP archive for lock-in-free backups
// =============================================================================

const appWithExport = appWithAttachments
  .get(
    "/:id/export.zip",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Export notebook",
      description: "Download a portable ZIP archive with Markdown notes, raw attachments, and JSON metadata.",
      ...requiresAuth,
      responses: {
        200: { description: "Notebook ZIP archive" },
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Notebook not found"),
      },
    }),
    async (c) => {
      let notebookId = c.req.param("id")!;
      const { notebook, error } = await checkNotebookAccess(c, notebookId, "admin");
      if (error) return error;
      notebookId = notebook!.id;

      const exported = await notebooksService.exporter.exportNotebookZip({ notebookId });
      if (!exported) return respond(c, fail(notFoundMessage(messages(c).notebookNotFound)));

      const buffer = exported.zip.buffer.slice(exported.zip.byteOffset, exported.zip.byteOffset + exported.zip.byteLength) as ArrayBuffer;
      return new Response(new Blob([buffer], { type: "application/zip" }), {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${encodeURIComponent(exported.filename)}"`,
          "Cache-Control": "no-store",
        },
      });
    },
  )
  .get(
    "/:id/snapshots/config",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Get notebook S3 snapshot config",
      description: "Returns redacted S3 snapshot configuration for this notebook. Admin access is required.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(NotebookSnapshotConfigSchema, "Snapshot config"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Notebook not found"),
      },
    }),
    async (c) => {
      const { notebook, error } = await checkNotebookAccess(c, c.req.param("id")!, "admin");
      if (error) return error;
      return respond(c, ok(localizeSnapshotConfig(await notebooksService.backup.getConfig({ notebookId: notebook!.id }), getLocale(c))));
    },
  )
  .put(
    "/:id/snapshots/config",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Update notebook S3 snapshot config",
      description: "Update this notebook's S3 snapshot configuration. Secrets are encrypted and never returned. Admin access is required.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(NotebookSnapshotConfigSchema, "Snapshot config"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Notebook not found"),
      },
    }),
    v("json", UpdateNotebookSnapshotConfigSchema),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const user = userResult.data;
      const { notebook, error } = await checkNotebookAccess(c, c.req.param("id")!, "admin");
      if (error) return error;
      const result = localizeResult(
        await notebooksService.backup.updateConfig({
          notebookId: notebook!.id,
          userId: user.id,
          data: c.req.valid("json"),
        }),
        getLocale(c),
      );
      return respond(c, result.ok ? ok(localizeSnapshotConfig(result.data, getLocale(c))) : result);
    },
  )
  .get(
    "/:id/snapshots/logs",
    describeRoute({
      tags: ["Notebooks"],
      summary: "List notebook S3 snapshot logs",
      description: "Returns recent core logging entries for this notebook's S3 snapshot runs.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(z.array(LogEntrySchema), "Snapshot logs"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Notebook not found"),
      },
    }),
    v("query", SnapshotLogsQuerySchema),
    async (c) => {
      const { notebook, error } = await checkNotebookAccess(c, c.req.param("id")!, "admin");
      if (error) return error;
      c.header("Cache-Control", "no-store");
      return respond(
        c,
        ok(
          (await notebooksService.backup.listLogs({ notebookId: notebook!.id })).map((entry) =>
            toPublicSnapshotLog(entry, notebook!.shortId),
          ),
        ),
      );
    },
  )
  .post(
    "/:id/snapshots/run",
    describeRoute({
      tags: ["Notebooks"],
      summary: "Run notebook S3 snapshot",
      description: "Uploads latest.zip, a timestamped snapshot ZIP, and latest-manifest.json to the configured S3 bucket.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(NotebookBackupRunSchema, "Backup uploaded"),
        400: jsonResponse(ErrorResponseSchema, "Backup disabled or incomplete"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Notebook not found"),
      },
    }),
    async (c) => {
      let notebookId = c.req.param("id")!;
      const { notebook, error } = await checkNotebookAccess(c, notebookId, "admin");
      if (error) return error;
      notebookId = notebook!.id;
      return respond(c, localizeMessageResult(await notebooksService.backup.runS3({ notebookId }), getLocale(c), "snapshotUploaded"));
    },
  );

// =============================================================================
// Tags — list endpoint used by the `/tag` slash-command picker
// =============================================================================

const appWithTags = appWithExport.get(
  "/:id/tags",
  describeRoute({
    tags: ["Notebooks"],
    summary: "List notebook tags with usage counts",
    ...requiresAuth,
    responses: {
      200: jsonResponse(z.array(TagSummarySchema), "Tags"),
      403: jsonResponse(ErrorResponseSchema, "Access denied"),
    },
  }),
  async (c) => {
    let notebookId = c.req.param("id")!;
    // Resolve the public ID once before the UUID-backed tag query.
    const { notebook, error } = await checkNotebookAccess(c, notebookId);
    if (error) return error;
    notebookId = notebook!.id;
    return respond(c, ok(await notebooksService.tag.listForNotebook({ notebookId })));
  },
);

// =============================================================================
// Client-facing limits — read-only echo of the user-visible parts of the
// settings so the Help modal / editor frontend can render the current
// numbers instead of hardcoding mirrors of the defaults. Authenticated
// but not admin-gated: these numbers are non-sensitive and visible to
// every user the moment they try an upload anyway.
// =============================================================================

const LimitsSchema = z.object({
  maxAttachmentSizeMb: z.number().int().positive(),
  maxImageDimensionPx: z.number().int().positive(),
});

const appWithLimits = appWithTags.get(
  "/limits",
  describeRoute({
    tags: ["Notebooks"],
    summary: "Current user-facing limits",
    description:
      "Live values of `notebooks.max_attachment_size_mb` and `notebooks.max_image_dimension_px`. Used by the Help modal and the client-side image shrink pipeline so they stay in sync when an admin tweaks the settings.",
    ...requiresAuth,
    responses: {
      200: jsonResponse(LimitsSchema, "Limits"),
    },
  }),
  async (c) => {
    const [maxAttachmentSizeMb, maxImageDimensionPx] = await Promise.all([getMaxAttachmentSizeMb(), getMaxImageDimensionPx()]);
    return respond(c, ok({ maxAttachmentSizeMb, maxImageDimensionPx }));
  },
);

// =============================================================================
// Admin — notebooks-app-level settings (extensible: any setting whose key
// is in the `notebooks` group is exposed here, so future settings just
// need a `defaults.ts` entry to show up in the admin UI without API
// changes). Scheduled maintenance is controlled from Gateway Ops Jobs.
// =============================================================================

const NOTEBOOKS_SETTING_GROUP = "notebooks";
const NOTEBOOKS_SETTING_PREFIX = "notebooks.";

const SettingEntrySchema = z.object({
  key: z.string(),
  label: z.string(),
  kind: z.string(),
  description: z.string(),
  default: z.unknown(),
  value: z.unknown(),
  isCustom: z.boolean(),
});

const UpdateSettingSchema = z.object({
  value: z.unknown(),
});

const requireAdmin = (c: Context<AuthContext>) => {
  const user = getUserBackedActor(c);
  if (!user || !hasRole(user, "admin")) {
    return respond(c, fail(err.forbidden(messages(c).adminRequired)));
  }
  return null;
};

const appWithAdmin = appWithLimits
  // List all notebooks-namespaced settings
  .get(
    "/admin/settings",
    describeRoute({
      tags: ["Notebooks", "Admin"],
      summary: "List notebooks-app settings",
      description: "Returns every setting whose key starts with `notebooks.` Admins can update any of them via PUT /admin/settings/:key.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(z.array(SettingEntrySchema), "Notebook settings"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
      },
    }),
    async (c) => {
      const denied = requireAdmin(c);
      if (denied) return denied;
      const result = await settingsService.entry.list({ filter: { group: NOTEBOOKS_SETTING_GROUP }, locale: getLocale(c) });
      return respond(c, ok(result.items));
    },
  )

  // Update one setting — key validated to belong to the notebooks namespace
  .put(
    "/admin/settings/:key",
    describeRoute({
      tags: ["Notebooks", "Admin"],
      summary: "Update a notebooks-app setting",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Updated"),
        400: jsonResponse(ErrorResponseSchema, "Invalid key or value"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
      },
    }),
    v("json", UpdateSettingSchema),
    async (c) => {
      const denied = requireAdmin(c);
      if (denied) return denied;
      const key = c.req.param("key")!;
      if (!key.startsWith(NOTEBOOKS_SETTING_PREFIX)) {
        return respond(c, fail(err.badInput(messages(c).settingOutsideNamespace({ key }))));
      }
      const { value } = c.req.valid("json");
      const result =
        key === "notebooks.snapshot_cron" && typeof value === "string"
          ? await notebooksService.backup.updateCron(value)
          : await settingsService.entry.update({ key, value });
      if (!result.ok) {
        const message =
          key === "notebooks.snapshot_cron"
            ? fallbackServiceMessage(getLocale(c), result.error.status, result.error.message)
            : messages(c).settingUpdateFailed;
        return respond(c, fail({ ...result.error, message }));
      }
      // If the user changed the reindex cron, reschedule live (no restart
      // needed). Logs go to `notebooks:reindex` for observability.
      if (key === "notebooks.reindex_cron" && typeof value === "string") {
        try {
          await reindexRuntime.updateCron(value);
        } catch {
          return respond(c, fail(err.badInput(messages(c).settingRescheduleFailed)));
        }
      }
      return respond(c, ok({ message: messages(c).settingUpdated }));
    },
  );

export default appWithAdmin;
export type ApiType = typeof appWithAdmin;
