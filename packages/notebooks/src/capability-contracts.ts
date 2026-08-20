import { CapabilitySemanticLinkSchema } from "@valentinkolb/cloud/contracts";
import { z } from "zod";

const TimestampSchema = z.string().datetime({ offset: true });
const PermissionSchema = z.enum(["read", "write", "admin"]);
const CursorSchema = z.string().min(1).max(256).optional().describe("Opaque cursor returned by the previous page.");
const LimitSchema = z.number().int().min(1).max(100).default(25).describe("Maximum number of results to return.");
const QuerySchema = z.string().trim().max(500).optional().describe("Optional text search.");
const ContentHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ResourceShortIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9]{6}$/)
  .describe("Stable 6-character resource ID.");
const NamedBlockTypeSchema = z.enum(["table", "list", "data", "section", "script", "unknown"]);
const ResourceLinksSchema = z.array(CapabilitySemanticLinkSchema).min(1).max(10).optional();
const resourceRef = <Type extends string>(type: Type) =>
  z.object({ type: z.literal(type), id: ResourceShortIdSchema }).strict();

const NotebookDataShape = {
  id: ResourceShortIdSchema,
  name: z.string().min(1),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  homepageNoteId: ResourceShortIdSchema.nullable(),
  permission: PermissionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  links: ResourceLinksSchema,
};

export const NotebookDataSchema = z.object(NotebookDataShape).strict();
const NotebookListItemDataSchema = NotebookDataSchema.extend({ ref: resourceRef("notebooks.notebook") }).strict();
export const NotebookListDataSchema = z.array(NotebookListItemDataSchema).max(100);
export const NotebookListInputSchema = z
  .object({
    query: QuerySchema,
    minimumPermission: PermissionSchema.default("read").describe("Minimum effective permission required for returned notebooks."),
    cursor: CursorSchema,
    limit: LimitSchema,
  })
  .strict();
export const NotebookReadInputSchema = z
  .object({ id: ResourceShortIdSchema.describe("Notebook ID returned by notebook search/list or a notebooks.notebook ref.") })
  .strict();

export const NoteSummaryDataSchema = z
  .object({
    id: ResourceShortIdSchema,
    notebookId: ResourceShortIdSchema,
    parentId: ResourceShortIdSchema.nullable(),
    title: z.string(),
    position: z.number().int().nonnegative(),
    hasChildren: z.boolean(),
    locked: z.boolean(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const NoteTreeInputSchema = z
  .object({
    notebookId: ResourceShortIdSchema.describe("Notebook ID returned by notebook search/list/read or a notebooks.notebook ref."),
    cursor: CursorSchema,
    limit: z.number().int().min(1).max(2000).default(500).describe("Maximum lightweight tree entries to return."),
  })
  .strict();
export const NoteTreeDataSchema = z
  .array(
    z
      .object({
        id: ResourceShortIdSchema,
        ref: resourceRef("notebooks.note"),
        parentId: ResourceShortIdSchema.nullable(),
        title: z.string(),
        position: z.number().int().nonnegative(),
        hasChildren: z.boolean(),
        links: ResourceLinksSchema,
      })
      .strict(),
  )
  .max(2000);

export const NoteReadInputSchema = z
  .object({
    id: ResourceShortIdSchema.describe("Note ID returned by note search/tree/link/tag results or a notebooks.note ref."),
    contentOffset: z.number().int().nonnegative().default(0).describe("Zero-based character offset into the Markdown source."),
    contentLimit: z.number().int().min(1).max(50_000).default(20_000).describe("Maximum Markdown characters to return."),
  })
  .strict();

export const NamedBlockSummaryDataSchema = z
  .object({
    name: z.string(),
    type: NamedBlockTypeSchema,
    line: z.number().int().positive(),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    hash: ContentHashSchema,
  })
  .strict();

export const NoteDetailDataSchema = NoteSummaryDataSchema.extend({
  content: z.string().max(50_000),
  contentOffset: z.number().int().nonnegative(),
  contentLength: z.number().int().nonnegative(),
  contentHash: ContentHashSchema,
  contentComplete: z.boolean(),
  nextContentOffset: z.number().int().positive().nullable(),
  lineCount: z.number().int().positive(),
  tags: z.array(z.string().min(1)).max(500),
  tagsTruncated: z.boolean(),
  blocks: z.array(NamedBlockSummaryDataSchema).max(500),
  blocksTruncated: z.boolean(),
}).strict();

export const NoteLinksInputSchema = z
  .object({
    noteId: ResourceShortIdSchema.describe("Note ID returned by note search/tree/read or a notebooks.note ref."),
    direction: z.enum(["incoming", "outgoing", "all"]).default("all").describe("Link direction relative to the selected note."),
    cursor: CursorSchema,
    limit: LimitSchema,
  })
  .strict();
export const NoteLinksDataSchema = z
  .array(
    z
      .object({
        direction: z.enum(["incoming", "outgoing"]),
        ref: resourceRef("notebooks.note"),
        noteId: ResourceShortIdSchema,
        title: z.string(),
        notebookId: ResourceShortIdSchema,
        notebookName: z.string(),
        updatedAt: TimestampSchema,
        links: ResourceLinksSchema,
      })
      .strict(),
  )
  .max(100);

export const TagListInputSchema = z
  .object({
    notebookId: ResourceShortIdSchema.describe("Notebook ID returned by notebook search/list/read or a notebooks.notebook ref."),
    cursor: CursorSchema,
    limit: LimitSchema,
  })
  .strict();
export const TagListDataSchema = z
  .array(z.object({ tag: z.string().min(1), count: z.number().int().nonnegative(), links: ResourceLinksSchema }).strict())
  .max(100);

export const TagNotesInputSchema = z
  .object({
    notebookId: ResourceShortIdSchema.describe("Notebook ID returned by notebook search/list/read or a notebooks.notebook ref."),
    tag: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z][\w-]*(?:\/[\w-]+)*$/)
      .describe("Notebook tag without the leading hash sign."),
    query: QuerySchema,
    cursor: CursorSchema,
    limit: LimitSchema,
  })
  .strict();
export const TagNotesDataSchema = z
  .array(
    z
      .object({
        id: ResourceShortIdSchema,
        ref: resourceRef("notebooks.note"),
        title: z.string(),
        preview: z.string().nullable(),
        updatedAt: TimestampSchema,
        links: ResourceLinksSchema,
      })
      .strict(),
  )
  .max(100);

const EditBlockSelectorShape = {
  name: z.string().trim().min(1).max(200).describe("Named Markdown block selector."),
  type: NamedBlockTypeSchema.optional().describe("Optional block type disambiguation."),
  index: z.number().int().nonnegative().optional().describe("Zero-based match index when names repeat."),
};
const FullEditContentSchema = z.string().max(200_000).describe("Complete Markdown replacement, limited to 200,000 characters.");
const FragmentEditContentSchema = z.string().max(10_000).describe("Markdown fragment used by this structural edit.");
const EditKindSchema = <T extends string>(kind: T) => z.literal(kind).describe("Structural edit operation kind.");
const EditLineSchema = z.number().int().positive().describe("One-based Markdown line number.");

const SetContentEditOperationSchema = z.object({ kind: EditKindSchema("set-content"), content: FullEditContentSchema }).strict();

const StructuralNoteEditOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: EditKindSchema("append"), content: FragmentEditContentSchema }).strict(),
  z.object({ kind: EditKindSchema("prepend"), content: FragmentEditContentSchema }).strict(),
  z.object({ kind: EditKindSchema("insert-before-line"), line: EditLineSchema, content: FragmentEditContentSchema }).strict(),
  z.object({ kind: EditKindSchema("insert-after-line"), line: EditLineSchema, content: FragmentEditContentSchema }).strict(),
  z
    .object({
      kind: EditKindSchema("replace-lines"),
      startLine: EditLineSchema.describe("First one-based line to replace."),
      endLine: EditLineSchema.describe("Last one-based line to replace."),
      content: FragmentEditContentSchema,
    })
    .strict(),
  z
    .object({
      kind: EditKindSchema("delete-lines"),
      startLine: EditLineSchema.describe("First one-based line to delete."),
      endLine: EditLineSchema.describe("Last one-based line to delete."),
    })
    .strict(),
  z
    .object({
      kind: EditKindSchema("replace-block"),
      ...EditBlockSelectorShape,
      includeHandle: z.boolean().optional().describe("Whether replacement includes the block handle line."),
      content: FragmentEditContentSchema,
    })
    .strict(),
  z.object({ kind: EditKindSchema("append-block"), ...EditBlockSelectorShape, content: FragmentEditContentSchema }).strict(),
  z.object({ kind: EditKindSchema("prepend-block"), ...EditBlockSelectorShape, content: FragmentEditContentSchema }).strict(),
]);

export const NoteEditOperationSchema = z.union([SetContentEditOperationSchema, StructuralNoteEditOperationSchema]);

export const NoteCreateInputSchema = z
  .object({
    notebookId: ResourceShortIdSchema.describe("Writable notebook ID."),
    parentId: ResourceShortIdSchema.optional().describe("Optional parent note ID in the same notebook."),
    position: z.number().int().nonnegative().optional().describe("Optional sibling position; defaults to append."),
    content: z.string().max(200_000).optional().describe("Initial Markdown source; a title is derived or generated by the notebook."),
  })
  .strict();

export const NoteEditInputSchema = z
  .object({
    noteId: ResourceShortIdSchema.describe("Stable writable note ID."),
    operations: z
      .union([z.tuple([SetContentEditOperationSchema]), z.array(StructuralNoteEditOperationSchema).min(1).max(20)])
      .describe("Either one complete set-content replacement or up to 20 ordered structural Markdown edits."),
    ifUpdatedAt: TimestampSchema.optional().describe("Reject when the note timestamp changed."),
    ifContentHash: ContentHashSchema.optional().describe("Reject when the complete Markdown hash changed."),
    ifBlockHash: ContentHashSchema.optional().describe("Reject when the selected named block changed."),
  })
  .strict();

export const NoteEditDataSchema = z
  .object({
    note: NoteSummaryDataSchema,
    changed: z.boolean(),
    beforeHash: ContentHashSchema,
    afterHash: ContentHashSchema,
    blocks: z.array(NamedBlockSummaryDataSchema).max(500),
    blocksTruncated: z.boolean(),
  })
  .strict();

export const NoteMoveInputSchema = z
  .object({
    noteId: ResourceShortIdSchema.describe("Stable writable note ID."),
    parentId: ResourceShortIdSchema.nullable().describe("New parent note ID in the same notebook, or null for a root note."),
    position: z.number().int().nonnegative().describe("New sibling position."),
  })
  .strict();
