import type { AuthContext } from "@k2b/cloud/server";
import { getDateConfig, getLocale, respond } from "@k2b/cloud/server";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { Context } from "hono";
import { z } from "zod";
import { ShortIdSchema } from "../contracts";
import { gridsService } from "../service";
import { type FormSubmission, MAX_INLINE_CREATES_PER_FIELD, MAX_INLINE_CREATES_PER_SUBMISSION } from "../service/form-submission";
import type { Form } from "../service/forms";
import { fromPublicRecordValues, fromPublicRelationValues, projectPublicId, resolvePublicId } from "../service/public-resources";
import type { ExpansionViewer } from "../service/relation-access";
import { apiMessages } from "./messages";
import { fromPublicRecordQuery } from "./public-query";
import {
  PublicFormSchema as AuthenticatedPublicFormSchema,
  type PublicForm,
  PublicFormConfigSchema,
  toPublicForm as toPublicStoredForm,
} from "./public-dto";

type PublicFormConfig = PublicForm["config"];

export const fromPublicFormConfig = async (tableId: string, config: PublicFormConfig): Promise<Form["config"] | null> => {
  const fields = await gridsService.field.listByTable(tableId);
  const byPublicId = new Map(fields.map((field) => [field.shortId, field]));
  const entries: Form["config"]["fields"] = [];
  for (const entry of config.fields) {
    const field = byPublicId.get(entry.fieldId);
    if (!field) return null;
    const raw = entry.kind === "form_value" ? entry.value : entry.defaultValue;
    const converted = raw === undefined ? null : await fromPublicRelationValues([field], { [field.id]: raw });
    if (converted && !converted.ok) return null;
    const value = converted?.ok ? converted.data[field.id] : raw;
    if (entry.kind === "form_value") {
      entries.push({ ...entry, fieldId: field.id, value });
      continue;
    }
    let inlineCreate: Extract<Form["config"]["fields"][number], { kind: "user_input" }>["inlineCreate"];
    if (entry.inlineCreate) {
      const targetTableId = field.type === "relation" ? (field.config as { targetTableId?: unknown }).targetTableId : null;
      if (typeof targetTableId !== "string") return null;
      const targetFields = await gridsService.field.listByTable(targetTableId);
      const targetByPublicId = new Map(targetFields.map((target) => [target.shortId, target]));
      const inlineFields = entry.inlineCreate.fields
        ? await Promise.all(
            entry.inlineCreate.fields.map(async (inlineField) => {
              const target = targetByPublicId.get(inlineField.fieldId);
              if (!target) return null;
              const converted =
                inlineField.defaultValue === undefined
                  ? null
                  : await fromPublicRelationValues([target], { [target.id]: inlineField.defaultValue });
              if (converted && !converted.ok) return null;
              return { ...inlineField, fieldId: target.id, ...(converted?.ok ? { defaultValue: converted.data[target.id] } : {}) };
            }),
          )
        : undefined;
      if (inlineFields?.some((inlineField) => !inlineField)) return null;
      inlineCreate = { ...entry.inlineCreate, fields: inlineFields?.filter((item): item is NonNullable<typeof item> => Boolean(item)) };
    }
    let relationFilter: Extract<Form["config"]["fields"][number], { kind: "user_input" }>["relationFilter"];
    if (entry.relationFilter) {
      const targetTableId = field.type === "relation" ? field.config.targetTableId : null;
      if (typeof targetTableId !== "string") return null;
      const converted = await fromPublicRecordQuery(targetTableId, { filter: entry.relationFilter });
      if (!converted.ok) return null;
      relationFilter = converted.data.filter;
    }
    entries.push({ ...entry, fieldId: field.id, inlineCreate, relationFilter, ...(raw !== undefined ? { defaultValue: value } : {}) });
  }
  const validations = config.validations?.map((rule) => {
    const leftFieldId = byPublicId.get(rule.leftFieldId)?.id;
    const rightFieldId = byPublicId.get(rule.rightFieldId)?.id;
    const errorFieldId = rule.errorFieldId ? byPublicId.get(rule.errorFieldId)?.id : undefined;
    return leftFieldId && rightFieldId && (!rule.errorFieldId || errorFieldId)
      ? { ...rule, leftFieldId, rightFieldId, ...(errorFieldId ? { errorFieldId } : {}) }
      : null;
  });
  if (validations?.some((rule) => !rule)) return null;
  const computedFields = config.computedFields?.map((entry) => {
    const fieldId = byPublicId.get(entry.fieldId)?.id;
    return fieldId ? { ...entry, fieldId } : null;
  });
  if (computedFields?.some((entry) => !entry)) return null;
  return {
    ...config,
    fields: entries,
    computedFields: computedFields?.filter((entry): entry is NonNullable<typeof entry> => !!entry),
    validations: validations?.filter((rule): rule is NonNullable<typeof rule> => Boolean(rule)),
  };
};

export const FormSchema = AuthenticatedPublicFormSchema;

export const FormListSchema = z.array(FormSchema);

export const CreateFormSchema = z.object({
  name: z.string().min(1).max(200),
  config: PublicFormConfigSchema.optional(),
  isPublic: z.boolean().optional(),
});

export const UpdateFormSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  config: PublicFormConfigSchema.optional(),
  isPublic: z.boolean().optional(),
  isActive: z.boolean().optional(),
  position: z.number().int().optional(),
});

export const FormSubmitSchema = z.record(z.string(), z.unknown());

const InlineCreateDraftSchema = z.object({
  tempId: z.string().min(1).max(100),
  data: z.record(z.string(), z.unknown()),
});

const InlineCreatesSchema = z
  .record(z.string(), z.array(InlineCreateDraftSchema).max(MAX_INLINE_CREATES_PER_FIELD))
  .superRefine((groups, context) => {
    const total = Object.values(groups).reduce((count, drafts) => count + drafts.length, 0);
    if (total > MAX_INLINE_CREATES_PER_SUBMISSION) {
      context.addIssue({ code: "custom", message: `At most ${MAX_INLINE_CREATES_PER_SUBMISSION} related records may be created` });
    }
  });

const SubmitEnvelopeSchema = z.object({
  data: z.record(z.string(), z.unknown()).optional(),
  inlineCreates: InlineCreatesSchema.optional(),
  inlineUpdates: z
    .record(
      z.string(),
      z
        .array(
          z.object({ recordId: ShortIdSchema, version: z.number().int().positive(), data: z.record(z.string(), z.unknown()) }).strict(),
        )
        .max(MAX_INLINE_CREATES_PER_FIELD),
    )
    .optional(),
  idempotencyKey: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => value.trim().length > 0 && !value.includes("\0"))
    .optional(),
});

const parseFormSubmission = (submitted: Record<string, unknown>): FormSubmission | null => {
  const envelopeLike =
    Object.prototype.hasOwnProperty.call(submitted, "data") ||
    Object.prototype.hasOwnProperty.call(submitted, "inlineCreates") ||
    Object.prototype.hasOwnProperty.call(submitted, "inlineUpdates") ||
    Object.prototype.hasOwnProperty.call(submitted, "idempotencyKey");
  if (!envelopeLike) return { data: submitted, inlineCreates: {} };
  const parsed = SubmitEnvelopeSchema.safeParse(submitted);
  if (!parsed.success) return null;
  const creates = parsed.data.inlineCreates ?? {};
  const updates = parsed.data.inlineUpdates ?? {};
  let total = 0;
  for (const fieldId of new Set([...Object.keys(creates), ...Object.keys(updates)])) {
    const count = (creates[fieldId]?.length ?? 0) + (updates[fieldId]?.length ?? 0);
    total += count;
    if (count > MAX_INLINE_CREATES_PER_FIELD || total > MAX_INLINE_CREATES_PER_SUBMISSION) return null;
  }
  return {
    data: parsed.data.data ?? {},
    inlineCreates: parsed.data.inlineCreates ?? {},
    ...(parsed.data.inlineUpdates ? { inlineUpdates: parsed.data.inlineUpdates } : {}),
    ...(parsed.data.idempotencyKey ? { idempotencyKey: parsed.data.idempotencyKey } : {}),
  };
};

export const PublicFormSchema = z.object({
  id: ShortIdSchema,
  name: z.string(),
  config: PublicFormConfigSchema,
});

export const toPublicForm = async (form: Form): Promise<z.infer<typeof PublicFormSchema>> => {
  const projected = await toPublicStoredForm(form);
  return PublicFormSchema.parse({
    id: projected.id,
    name: projected.name,
    config: { ...projected.config, fields: projected.config.fields.filter((entry) => entry.kind === "user_input") },
  });
};

export type SubmitFormDeps = {
  submit?: typeof gridsService.form.submit;
  dateConfig?: typeof getDateConfig;
};

export const fromPublicFormSubmission = async (
  context: Context<AuthContext>,
  tableId: string,
  submitted: Record<string, unknown>,
): Promise<Result<FormSubmission>> => {
  const submission = parseFormSubmission(submitted);
  if (!submission) return fail(err.badInput(apiMessages(context).invalidFormSubmission));
  const fields = await gridsService.field.listByTable(tableId);
  const fieldsByPublicId = new Map(fields.map((field) => [field.shortId, field]));
  const locale = getLocale(context);
  const data = await fromPublicRecordValues(tableId, submission.data, { allowTemporaryRelationIds: true, locale });
  if (!data.ok) return data;
  const inlineCreates: FormSubmission["inlineCreates"] = {};
  for (const [publicFieldId, drafts] of Object.entries(submission.inlineCreates)) {
    const relationField = fieldsByPublicId.get(publicFieldId);
    const targetTableId = relationField?.type === "relation" ? (relationField.config as { targetTableId?: unknown }).targetTableId : null;
    if (!relationField || typeof targetTableId !== "string") return fail(err.badInput(apiMessages(context).invalidInlineRelationField));
    const convertedDrafts: typeof drafts = [];
    for (const draft of drafts) {
      const converted = await fromPublicRecordValues(targetTableId, draft.data, { locale });
      if (!converted.ok) return converted;
      convertedDrafts.push({ ...draft, data: converted.data });
    }
    inlineCreates[relationField.id] = convertedDrafts;
  }
  const inlineUpdates: NonNullable<FormSubmission["inlineUpdates"]> = {};
  for (const [publicFieldId, updates] of Object.entries(submission.inlineUpdates ?? {})) {
    const field = fieldsByPublicId.get(publicFieldId);
    const targetTableId = field?.type === "relation" ? field.config.targetTableId : null;
    if (!field || typeof targetTableId !== "string") return fail(err.badInput(apiMessages(context).invalidInlineRelationField));
    const convertedUpdates: typeof updates = [];
    for (const update of updates) {
      const recordId = await resolvePublicId("record", update.recordId);
      if (!recordId) return fail(err.badInput(apiMessages(context).invalidFormSubmission));
      const values = await fromPublicRecordValues(targetTableId, update.data, { locale });
      if (!values.ok) return values;
      convertedUpdates.push({ recordId, version: update.version, data: values.data });
    }
    inlineUpdates[field.id] = convertedUpdates;
  }
  return ok({
    data: data.data,
    inlineCreates,
    ...(Object.keys(inlineUpdates).length ? { inlineUpdates } : {}),
    ...(submission.idempotencyKey ? { idempotencyKey: submission.idempotencyKey } : {}),
  });
};

export const submitFormResponse = async (
  context: Context<AuthContext>,
  form: Form,
  submitted: Record<string, unknown>,
  actorId: string | null,
  deps: SubmitFormDeps = {},
  viewer?: ExpansionViewer,
  record?: { id: string; version: number },
) => {
  const submission = await fromPublicFormSubmission(context, form.tableId, submitted);
  if (!submission.ok) return respond(context, () => Promise.resolve(submission));
  const dateConfig = await (deps.dateConfig ?? getDateConfig)(context);
  const submit = deps.submit ?? gridsService.form.submit;
  const result = await submit({ form, submission: submission.data, actorId, dateConfig, viewer, ...(record ? { record } : {}) });
  if (!result.ok) return respond(context, () => Promise.resolve(result), 201);
  const recordId = await projectPublicId("record", result.data.recordId);
  if (!recordId) return context.json({ message: apiMessages(context).createdRecordMissingPublicId }, 500);
  return context.json({ recordId }, record ? 200 : 201);
};
