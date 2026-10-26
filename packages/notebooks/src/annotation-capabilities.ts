import {
  type CapabilityActionDefinition,
  type CapabilityExecutionContext,
  type CapabilityQueryDefinition,
  capabilityPage,
  cloudResourceHref,
} from "@k2b/cloud/contracts";
import { err, fail, ok } from "@k2b/stdlib";
import { z } from "zod";
import {
  AnnotationCreateSchema,
  AnnotationDataSchema,
  AnnotationEditSchema,
  AnnotationOperationSchema,
  AnnotationPageSchema,
  AnnotationProjectionSchema,
  AnnotationReplyDataSchema,
  AnnotationReplySchema,
} from "./lib/annotation-contracts";
import * as annotations from "./service/annotations";
import * as notebooks from "./service/notebooks";

const NoteIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9]{6}$/)
  .describe("Public notebooks.note ID from note.read, note.search or the notebook tree.");
const TargetSchema = z
  .object({ noteId: NoteIdSchema, annotationId: z.uuid().describe("Inline comment ID returned by annotation.list or annotation.create.") })
  .strict();
const ReplyTargetSchema = TargetSchema.extend({
  replyId: z.uuid().optional().describe("Reply ID returned by annotation.reply or annotation.replies; omit to change the root comment."),
});
const MutationSchema = z.object({ id: z.uuid(), annotationId: z.uuid(), deleted: z.boolean() }).strict();
const OperationDataSchema = z
  .object({ id: z.uuid(), operationId: z.uuid(), status: z.literal("applied"), state: z.enum(["open", "resolved", "accepted"]) })
  .strict();
const ref = (id: string) => ({ type: "notebooks.annotation" as const, id });
const link = (id: string) => ({ rel: "open" as const, href: cloudResourceHref(ref(id)) });
const envelope = <T extends { id: string }>(data: T) => ({ data, refs: [ref(data.id)], links: [link(data.id)] });
const inputKey = (context: CapabilityExecutionContext) => context.idempotencyKey;
const noKey = () => fail(err.badInput("Idempotency-Key is required"));
const review = async (
  input: { noteId: string; annotationId?: string; body?: string; suggestion?: string | null; quote?: string },
  context: CapabilityExecutionContext,
) => {
  const access = await annotations.authorize(input.noteId, context, true);
  if (!access.ok) return access;
  const notebook = await notebooks.get({ id: access.data.note.notebookId });
  if (!notebook) return fail(err.notFound("Notebook"));
  const de = context.locale.startsWith("de");
  return ok({
    message: de ? `Kommentar in „${access.data.note.title}“ ändern` : `Change a comment in “${access.data.note.title}”`,
    details: [
      { label: de ? "Notiz" : "Note", value: access.data.note.title },
      ...(input.quote !== undefined ? [{ label: de ? "Textstelle" : "Passage", value: input.quote, display: "block" as const }] : []),
      ...(input.body !== undefined ? [{ label: de ? "Kommentar" : "Comment", value: input.body, display: "block" as const }] : []),
      ...(input.suggestion != null ? [{ label: de ? "Vorschlag" : "Suggestion", value: input.suggestion, display: "block" as const }] : []),
    ],
    links: [{ rel: "open" as const, href: cloudResourceHref({ type: "notebooks.note", id: input.noteId }) }],
    approvalScope: `notebook:${notebook.shortId}`,
  });
};
const reviewOperation =
  (kind: "accept" | "undo") =>
  async (input: { noteId: string; annotationId: string; expectedText?: string }, context: CapabilityExecutionContext) => {
    const base = await review(input, context);
    if (!base.ok) return base;
    const preview = await annotations.previewOperation(input.noteId, input.annotationId, kind, input.expectedText, context);
    if (!preview.ok) return preview;
    const de = context.locale.startsWith("de");
    return ok({
      ...base.data,
      details: [
        ...base.data.details,
        { label: de ? "Erwartete Textstelle" : "Expected passage", value: preview.data.before, display: "block" as const },
        { label: de ? "Ersetzen durch" : "Replace with", value: preview.data.after, display: "block" as const },
      ],
    });
  };
const ListSchema = AnnotationProjectionSchema.omit({ text: true }).extend({
  items: z.array(AnnotationDataSchema.extend({ ref: z.object({ type: z.literal("notebooks.annotation"), id: z.uuid() }) })),
});
export const annotationQueries = {
  "annotation.list": {
    title: "List passage comments",
    description:
      "Read comments on one note, including resolved and accepted comments, source offsets, orphan state and headingPath. The contentHash and cursor identify one Markdown state; read the text with note.read and check its hash. Follow nextCursor; each thread has independently paged replies.",
    input: AnnotationPageSchema.extend({ noteId: NoteIdSchema }),
    data: ListSchema,
    openWorld: false,
    run: async (input: z.output<typeof AnnotationPageSchema> & { noteId: string }, context: CapabilityExecutionContext) => {
      const result = await annotations.list(input.noteId, { cursor: input.cursor, limit: input.limit }, context, { compact: true });
      if (!result.ok) return result;
      const { text: _text, ...projection } = result.data;
      return ok({
        data: { ...projection, items: projection.items.map((item) => ({ ...item, ref: ref(item.id) })) },
        page: capabilityPage(projection.nextCursor),
      });
    },
  },
  "annotation.read": {
    title: "Read passage comment",
    description:
      "Read a notebooks.annotation resource with its current passage, replies and permissions. Follow repliesNextCursor with annotation.replies.",
    input: z.object({ id: z.uuid().describe("notebooks.annotation ref.id from annotation.list or annotation.create.") }).strict(),
    data: AnnotationDataSchema,
    openWorld: false,
    run: async (input: { id: string }, context: CapabilityExecutionContext) => {
      const result = await annotations.readResource(input.id, context);
      if (!result.ok) return result;
      const access = await annotations.authorize(result.data.noteId, context);
      if (!access.ok) return access;
      const notebook = await notebooks.get({ id: access.data.note.notebookId });
      if (!notebook) return fail(err.notFound("Notebook"));
      return ok({
        data: result.data,
        refs: [ref(result.data.id)],
        links: [
          { rel: "open" as const, href: `/app/notebooks/${notebook.shortId}/notes/${result.data.noteId}?annotation=${result.data.id}` },
        ],
      });
    },
  },
  "annotation.replies": {
    title: "List passage comment replies",
    description:
      "Continue replies from annotation.read or annotation.list using repliesNextCursor. Returns complete reply text and current edit/delete permissions.",
    input: AnnotationPageSchema.extend(TargetSchema.shape),
    data: z.object({ items: z.array(AnnotationReplyDataSchema), nextCursor: z.string().nullable() }),
    openWorld: false,
    run: async (input: z.output<typeof AnnotationPageSchema> & z.infer<typeof TargetSchema>, context: CapabilityExecutionContext) => {
      const result = await annotations.replies(input.noteId, input.annotationId, { cursor: input.cursor, limit: input.limit }, context);
      return result.ok ? ok({ data: result.data }) : result;
    },
  },
} satisfies Record<string, CapabilityQueryDefinition>;

const CreateInputSchema = z.object(AnnotationCreateSchema.shape).omit({ idempotencyKey: true }).extend({ noteId: NoteIdSchema }).strict();
const ReplyInputSchema = AnnotationReplySchema.omit({ idempotencyKey: true }).extend(TargetSchema.shape);
const EditInputSchema = AnnotationEditSchema.extend(ReplyTargetSchema.shape);
const ResolveInputSchema = TargetSchema.extend({
  resolved: z.boolean().describe("True resolves the comment; false reopens it. Accepted suggestions require annotation.undo-accept."),
});
const OperationInputSchema = AnnotationOperationSchema.extend(TargetSchema.shape);
export const annotationActions = {
  "annotation.create": {
    title: "Comment on a passage",
    description:
      "Add a comment or replacement suggestion to a known writable note. Quote up to 2,000 UTF-16 characters and provide surrounding context or an offsetHint. Requires an Idempotency-Key; retry the same payload with the same key.",
    input: CreateInputSchema,
    data: AnnotationDataSchema,
    destructive: false,
    openWorld: false,
    idempotency: "required",
    approval: "rememberable",
    review,
    run: async (input: z.output<typeof CreateInputSchema>, context: CapabilityExecutionContext) => {
      const idempotencyKey = inputKey(context);
      if (!idempotencyKey) return noKey();
      const { noteId, ...value } = input;
      const result = await annotations.create(noteId, { ...value, idempotencyKey }, context);
      return result.ok ? ok(envelope(result.data)) : result;
    },
  },
  "annotation.reply": {
    title: "Reply to a passage comment",
    description: "Reply as the current user, agent or service account. Requires write access to the note and an Idempotency-Key.",
    input: ReplyInputSchema,
    data: AnnotationReplyDataSchema,
    destructive: false,
    openWorld: false,
    idempotency: "required",
    review,
    run: async (input: z.output<typeof ReplyInputSchema>, context: CapabilityExecutionContext) => {
      const idempotencyKey = inputKey(context);
      if (!idempotencyKey) return noKey();
      const result = await annotations.reply(input.noteId, input.annotationId, { body: input.body, idempotencyKey }, context);
      return result.ok ? ok({ data: result.data, refs: [ref(input.annotationId)], links: [link(input.annotationId)] }) : result;
    },
  },
  "annotation.edit": {
    title: "Edit your recent passage comment",
    description:
      "Edit the root comment or a reply by replyId. Only its author within ten minutes, with current write access. Omit suggestion to preserve it; null removes it.",
    input: EditInputSchema,
    data: MutationSchema,
    destructive: false,
    openWorld: false,
    idempotency: "none",
    review,
    run: async (input: z.output<typeof EditInputSchema>, context: CapabilityExecutionContext) => {
      const { noteId, annotationId, ...value } = input;
      const result = await annotations.mutate(noteId, annotationId, { kind: "edit", ...value }, context);
      return result.ok ? ok({ data: result.data }) : result;
    },
  },
  "annotation.delete": {
    title: "Delete your recent passage comment",
    description:
      "Soft-delete an author-owned comment or reply within ten minutes. A root with live replies cannot be deleted. Requires write access.",
    input: ReplyTargetSchema,
    data: MutationSchema,
    destructive: true,
    openWorld: false,
    idempotency: "required",
    review,
    run: async (input: z.infer<typeof ReplyTargetSchema>, context: CapabilityExecutionContext) => {
      const result = await annotations.mutate(input.noteId, input.annotationId, { kind: "delete", replyId: input.replyId }, context);
      return result.ok ? ok({ data: result.data }) : result;
    },
  },
  "annotation.restore": {
    title: "Restore your recent deleted passage comment",
    description:
      "Undo a soft deletion before the author's original ten-minute window expires. Use replyId for a reply. Requires write access.",
    input: ReplyTargetSchema,
    data: MutationSchema,
    destructive: false,
    openWorld: false,
    idempotency: "none",
    review,
    run: async (input: z.infer<typeof ReplyTargetSchema>, context: CapabilityExecutionContext) => {
      const result = await annotations.mutate(input.noteId, input.annotationId, { kind: "restore", replyId: input.replyId }, context);
      return result.ok ? ok({ data: result.data }) : result;
    },
  },
  "annotation.resolve": {
    title: "Resolve or reopen a passage comment",
    description: "Any writer can resolve or reopen a comment, including on a locked note. Accepted suggestions must be undone instead.",
    input: ResolveInputSchema,
    data: MutationSchema,
    destructive: false,
    openWorld: false,
    idempotency: "none",
    review,
    run: async (input: z.infer<typeof ResolveInputSchema>, context: CapabilityExecutionContext) => {
      const result = await annotations.mutate(input.noteId, input.annotationId, { kind: input.resolved ? "resolve" : "reopen" }, context);
      return result.ok ? ok({ data: result.data }) : result;
    },
  },
  "annotation.accept": {
    title: "Accept a passage suggestion",
    description:
      "Replace only the anchored passage on an unlocked note. operationId is a caller-stable UUID: retry it after an uncertain result. expectedText defaults to the quoted text. Conflicts include details.currentText and operationId.",
    input: OperationInputSchema,
    data: OperationDataSchema,
    destructive: true,
    openWorld: false,
    idempotency: "required",
    review: reviewOperation("accept"),
    run: async (input: z.output<typeof OperationInputSchema>, context: CapabilityExecutionContext) => {
      const { noteId, annotationId, ...value } = input;
      const result = await annotations.operate(noteId, annotationId, "accept", value, context);
      return result.ok ? ok({ data: result.data }) : result;
    },
  },
  "annotation.undo-accept": {
    title: "Undo an accepted passage suggestion",
    description:
      "Restore only the accepted range if its inserted text is unchanged. Requires an unlocked note and write access. Retry uncertain outcomes with the same operationId UUID.",
    input: OperationInputSchema,
    data: OperationDataSchema,
    destructive: true,
    openWorld: false,
    idempotency: "required",
    review: reviewOperation("undo"),
    run: async (input: z.output<typeof OperationInputSchema>, context: CapabilityExecutionContext) => {
      const { noteId, annotationId, ...value } = input;
      const result = await annotations.operate(noteId, annotationId, "undo", value, context);
      return result.ok ? ok({ data: result.data }) : result;
    },
  },
} satisfies Record<string, CapabilityActionDefinition>;
