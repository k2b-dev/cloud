import { type DateContext, err, fail, isServiceError, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { evaluateFormValidations, formValidationFieldsCompatible } from "../form-validations";
import { listByTable as listFields, materializeFieldDefault } from "./fields";
import { formMessagesFor } from "./form-messages";
import type { Form } from "./forms";
import type { AuthorizedRecordAccess } from "./record-access";
import { notifyRecordEventOutbox } from "./record-event-outbox";
import { createInTransaction } from "./record-write";
import type { ExpansionViewer } from "./relation-access";

type InlineCreateDraft = {
  tempId: string;
  data: Record<string, unknown>;
};

export type FormSubmission = {
  data: Record<string, unknown>;
  inlineCreates: Record<string, InlineCreateDraft[]>;
};

export const MAX_INLINE_CREATES_PER_FIELD = 20;
export const MAX_INLINE_CREATES_PER_SUBMISSION = 50;

const validateInlineCreateBounds = (inlineCreates: FormSubmission["inlineCreates"], locale?: string): Result<void> => {
  const t = formMessagesFor(locale);
  let total = 0;
  for (const drafts of Object.values(inlineCreates)) {
    if (drafts.length > MAX_INLINE_CREATES_PER_FIELD) {
      return fail(err.badInput(t.inlineFieldLimit({ count: MAX_INLINE_CREATES_PER_FIELD })));
    }
    total += drafts.length;
    if (total > MAX_INLINE_CREATES_PER_SUBMISSION) {
      return fail(err.badInput(t.inlineSubmissionLimit({ count: MAX_INLINE_CREATES_PER_SUBMISSION })));
    }
  }
  return ok(undefined);
};

export const submitForm = async (params: {
  form: Form;
  submission: FormSubmission;
  actorId: string | null;
  dateConfig: DateContext;
  /** Request-scoped values resolved by a trusted server surface. */
  fixedValues?: Record<string, unknown>;
  recordAccess?: AuthorizedRecordAccess;
  viewer?: ExpansionViewer;
}): Promise<Result<{ recordId: string }>> => {
  const t = formMessagesFor(params.dateConfig.locale);
  const inlineCreateBounds = validateInlineCreateBounds(params.submission.inlineCreates, params.dateConfig.locale);
  if (!inlineCreateBounds.ok) return inlineCreateBounds;
  const formFields = params.form.config.fields ?? [];
  const fields = await listFields(params.form.tableId);
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  const entriesById = new Map(formFields.map((entry) => [entry.fieldId, entry]));
  const fieldName = (fieldId: string) => {
    const entry = entriesById.get(fieldId);
    if (entry?.kind === "user_input" && entry.label?.trim()) return entry.label.trim();
    return fieldsById.get(fieldId)?.name ?? t.unknownField;
  };

  const userInputIds = new Set<string>();
  const formValueIds = new Set<string>();
  for (const entry of formFields) {
    if (entry.kind === "user_input") userInputIds.add(entry.fieldId);
    else formValueIds.add(entry.fieldId);
  }
  for (const key of Object.keys(params.submission.data)) {
    if (Object.prototype.hasOwnProperty.call(params.fixedValues ?? {}, key)) {
      return fail(err.badInput(t.fieldFixed({ field: fieldName(key) })));
    }
    if (formValueIds.has(key)) return fail(err.badInput(t.fieldServerManaged({ field: fieldName(key) })));
    if (!userInputIds.has(key)) return fail(err.badInput(t.fieldNotInForm({ field: fieldName(key) })));
  }

  for (const key of Object.keys(params.submission.inlineCreates)) {
    if (Object.prototype.hasOwnProperty.call(params.fixedValues ?? {}, key)) {
      return fail(err.badInput(t.fixedFieldCannotCreate({ field: fieldName(key) })));
    }
  }

  for (const key of Object.keys(params.fixedValues ?? {})) {
    if (!userInputIds.has(key)) return fail(err.badInput(t.fieldCannotBeFixed({ field: fieldName(key) })));
  }

  const payload: Record<string, unknown> = { ...params.submission.data, ...params.fixedValues };
  for (const entry of formFields) {
    if (entry.kind !== "user_input") continue;
    if (payload[entry.fieldId] === undefined && entry.defaultValue !== undefined && entry.defaultValue !== null) {
      const field = fieldsById.get(entry.fieldId);
      payload[entry.fieldId] = field
        ? materializeFieldDefault({ ...field, defaultValue: entry.defaultValue }, { dateConfig: params.dateConfig })
        : entry.defaultValue;
    }
    if (entry.required && (payload[entry.fieldId] === undefined || payload[entry.fieldId] === null || payload[entry.fieldId] === "")) {
      return fail(err.badInput(t.fieldRequired({ field: fieldName(entry.fieldId) })));
    }
  }
  for (const entry of formFields) {
    if (entry.kind !== "form_value") continue;
    const field = fieldsById.get(entry.fieldId);
    payload[entry.fieldId] = field
      ? materializeFieldDefault({ ...field, defaultValue: entry.value }, { dateConfig: params.dateConfig })
      : entry.value;
  }

  for (const rule of params.form.config.validations ?? []) {
    const left = fieldsById.get(rule.leftFieldId);
    const right = fieldsById.get(rule.rightFieldId);
    if (!left || !right || !userInputIds.has(left.id) || !userInputIds.has(right.id) || !formValidationFieldsCompatible(left, right)) {
      return fail({ ...err.conflict("Form validation"), message: t.validationChanged });
    }
  }

  const validationFailure = evaluateFormValidations(params.form.config.validations, payload, fieldsById)[0];
  if (validationFailure) return fail(err.badInput(validationFailure.message));

  for (const [relationFieldId, drafts] of Object.entries(params.submission.inlineCreates)) {
    const tempIds = new Set<string>();
    for (const draft of drafts) {
      if (tempIds.has(draft.tempId)) {
        return fail(err.badInput(t.duplicateInlineDraft({ field: fieldName(relationFieldId) })));
      }
      tempIds.add(draft.tempId);
    }
  }

  const outboxIds: string[] = [];
  try {
    const recordId = await sql.begin(async (tx) => {
      for (const [relationFieldId, drafts] of Object.entries(params.submission.inlineCreates)) {
        if (drafts.length === 0) continue;
        const entry = entriesById.get(relationFieldId);
        const relationField = fieldsById.get(relationFieldId);
        if (entry?.kind !== "user_input" || !entry.inlineCreate?.enabled || !relationField || relationField.type !== "relation") {
          throw err.badInput(t.inlineCreateNotAllowed({ field: fieldName(relationFieldId) }));
        }
        const targetTableId = (relationField.config as { targetTableId?: unknown }).targetTableId;
        if (typeof targetTableId !== "string") throw err.badInput(t.relationTargetMissing({ field: fieldName(relationFieldId) }));
        const cardinality = (relationField.config as { cardinality?: "single" | "multiple" }).cardinality ?? "multiple";
        const inlineEntries = entry.inlineCreate.fields ?? [];
        const allowedFieldIds = new Set(inlineEntries.map((inlineEntry) => inlineEntry.fieldId));
        const targetFields = await listFields(targetTableId);
        const targetFieldsById = new Map(targetFields.map((field) => [field.id, field]));

        for (const draft of drafts) {
          if (!draft.tempId.startsWith("tmp_")) throw err.badInput(t.invalidInlineDraftId({ field: fieldName(relationFieldId) }));
          for (const key of Object.keys(draft.data)) {
            if (!allowedFieldIds.has(key)) {
              throw err.badInput(t.inlineFieldNotAllowed({ field: fieldName(relationFieldId) }));
            }
          }
        }

        const currentIds = Array.isArray(payload[relationFieldId])
          ? (payload[relationFieldId] as unknown[]).filter((id): id is string => typeof id === "string")
          : typeof payload[relationFieldId] === "string"
            ? [payload[relationFieldId]]
            : [];
        const draftIds = drafts.map((draft) => draft.tempId);
        const existingIds = currentIds.filter((id) => !draftIds.includes(id));
        if (cardinality === "single" && (drafts.length > 1 || (drafts.length > 0 && existingIds.length > 0))) {
          throw err.badInput(t.singleRelationConflict({ field: fieldName(relationFieldId) }));
        }

        const replacements = new Map<string, string>();
        for (const draft of drafts) {
          const draftPayload: Record<string, unknown> = { ...draft.data };
          for (const inlineEntry of inlineEntries) {
            const targetField = targetFieldsById.get(inlineEntry.fieldId);
            if (!targetField) throw err.badInput(t.inlineConfigChanged({ field: fieldName(relationFieldId) }));
            if (
              draftPayload[inlineEntry.fieldId] === undefined &&
              inlineEntry.defaultValue !== undefined &&
              inlineEntry.defaultValue !== null
            ) {
              draftPayload[inlineEntry.fieldId] = materializeFieldDefault(
                { ...targetField, defaultValue: inlineEntry.defaultValue },
                { dateConfig: params.dateConfig },
              );
            }
            if (
              (inlineEntry.required || targetField.required) &&
              (draftPayload[inlineEntry.fieldId] === undefined ||
                draftPayload[inlineEntry.fieldId] === null ||
                draftPayload[inlineEntry.fieldId] === "")
            ) {
              throw err.badInput(t.fieldRequired({ field: inlineEntry.label?.trim() || targetField.name }));
            }
          }
          const created = await createInTransaction(tx, targetTableId, draftPayload, params.actorId, "form", {
            dateConfig: params.dateConfig,
            locale: params.dateConfig.locale,
            viewer: params.viewer,
          });
          if (!created.ok) throw created.error;
          replacements.set(draft.tempId, created.data.record.id);
          outboxIds.push(created.data.outboxId);
        }

        const sourceIds = currentIds.length > 0 ? [...currentIds] : [...draftIds];
        if (cardinality !== "single") {
          for (const draftId of draftIds) {
            if (!sourceIds.includes(draftId)) sourceIds.push(draftId);
          }
        }
        payload[relationFieldId] = sourceIds.map((id) => replacements.get(id) ?? id);
      }

      const created = await createInTransaction(tx, params.form.tableId, payload, params.actorId, "form", {
        dateConfig: params.dateConfig,
        locale: params.dateConfig.locale,
        recordAccess: params.recordAccess,
        viewer: params.viewer,
      });
      if (!created.ok) throw created.error;
      outboxIds.push(created.data.outboxId);
      return created.data.record.id;
    });

    for (const outboxId of outboxIds) notifyRecordEventOutbox(outboxId);
    return { ok: true, data: { recordId } };
  } catch (error) {
    if (isServiceError(error)) return fail(error);
    throw error;
  }
};
