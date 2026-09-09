import type { DateContext } from "@k2b/stdlib";
import { Button, confirmDiscardIfDirty, dialogCore, NoticeCard, PanelDialog, panelDialogOptions, useLocale } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import type { PublicField as Field, PublicGridRecord as GridRecord } from "../../../api/public-dto";
import { initialFieldInputValue, isRecordInputField, sanitizeFieldValues } from "../fields/field-render";
import { FieldInput, type UserInputEntry } from "../forms/form-fields";
import { recordMessages } from "./messages";

/**
 * Shared create/edit dialog for grids records.
 *
 * Why a custom dialog (not `prompts.form` from cloud-ui): the platform-
 * wide form has a fixed set of field types and no relation extension
 * slot. We need one record-write surface where every editable grids
 * field type, including relations, renders inline. The dialog plumbing
 * (DialogHeader, validation, submit) lives here; the actual field
 * rendering delegates to {@link FieldInput} so record creation, form
 * submission, and field defaults use the same widget for each type.
 *
 * Required-field check is client-side (block submit + show error per
 * field), but the SERVER also enforces required + per-type validation
 * via field-type handlers — so a malicious / racy client can't sneak
 * through.
 */

type OpenArgs = {
  mode: "create" | "edit";
  /** Live fields of the table (deletedAt-filtered upstream). */
  fields: Field[];
  /** Needed by RelationPicker to deep-link out of chips. */
  baseId: string;
  /** Human table name for dialog context. */
  tableName?: string;
  /** Existing record when mode = edit. */
  record?: GridRecord;
  /** Existing relation labels so relation chips do not render as UUIDs. */
  relationLabels?: Record<string, string>;
  dateConfig?: DateContext;
  /** Runs while this dialog stays mounted. Returning false restores the
   * editor with its current draft intact. */
  beforeSubmit?: (values: Record<string, unknown>, baselineData: Record<string, unknown>) => Promise<boolean>;
  /** Persist while the draft stays mounted. Throw to keep the draft and show the error. */
  onSubmit: (values: Record<string, unknown>, version?: number) => Promise<void>;
  reloadRecord?: () => Promise<GridRecord>;
};

export class RecordSaveConflictError extends Error {}

/**
 * Keeps the record draft open until onSubmit persists successfully.
 * Resolves with the saved payload, or null if the user dismisses.
 */
export const openRecordUpsertDialog = (args: OpenArgs): Promise<Record<string, unknown> | null> => {
  return dialogCore
    .open<Record<string, unknown> | null>((close, context) => {
      const locale = useLocale();
      const t = () => recordMessages.resolve([locale()]).t;
      // Each editable field gets its own signal. Storing them in an
      // object keyed by field id keeps the gather-on-submit step
      // trivial: just walk the fields array and read the signal.
      const editableFields = args.fields.filter((f) => !f.deletedAt && isRecordInputField(f.type));

      // values: per-field, lazily initialised. Use a single signal on a
      // record so any update triggers all dependents (cheap — small
      // form). Edit mode starts from the record data; create mode starts
      // from field defaults.
      let initial: Record<string, unknown> = {};
      for (const f of editableFields) {
        initial[f.id] = initialFieldInputValue(f, args.mode === "edit" && args.record ? args.record.data[f.id] : undefined);
      }
      const [values, setValues] = createSignal<Record<string, unknown>>(initial);
      const [errors, setErrors] = createSignal<Record<string, string>>({});
      const [submitting, setSubmitting] = createSignal(false);
      const [submitError, setSubmitError] = createSignal<string | null>(null);
      const [conflict, setConflict] = createSignal(false);
      let version = args.record?.version;
      let baselineData = args.record?.data ?? {};
      const requestClose = async () => {
        if (submitting()) return;
        if (await confirmDiscardIfDirty(() => JSON.stringify(values()) !== JSON.stringify(initial))) close(null);
      };
      context.setDismissHandler(requestClose);
      const compareCurrent = async () => {
        if (!args.reloadRecord || submitting()) return;
        setSubmitting(true);
        try {
          const current = await args.reloadRecord();
          if (current.id !== args.record?.id || current.deletedAt || current.finalizedAt) throw new Error(t().conflictRecordUnavailable);
          const changedFields = editableFields.filter((field) => JSON.stringify(values()[field.id]) !== JSON.stringify(initial[field.id]));
          const reviewed = await dialogCore.open<boolean>(
            (closeReview) => (
              <PanelDialog>
                <PanelDialog.Header title={t().compareCurrentRecord} close={() => closeReview(false)} />
                <PanelDialog.Body>
                  <p class="text-sm text-dimmed">{t().compareCurrentRecordDetail}</p>
                  <fieldset disabled class="flex flex-col gap-3">
                    <For each={changedFields}>
                      {(field) => (
                        <div class="flex flex-col gap-2">
                          <h3 class="text-sm font-semibold">{field.name}</h3>
                          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <FieldInput
                              field={field}
                              entry={{ kind: "user_input", fieldId: field.id, label: t().yourDraftValue, required: false }}
                              value={values()[field.id]}
                              onChange={() => {}}
                              baseId={args.baseId}
                              relationLabels={args.relationLabels}
                              dateConfig={args.dateConfig}
                            />
                            <FieldInput
                              field={field}
                              entry={{ kind: "user_input", fieldId: field.id, label: t().currentSavedValue, required: false }}
                              value={initialFieldInputValue(field, current.data[field.id])}
                              onChange={() => {}}
                              baseId={args.baseId}
                              dateConfig={args.dateConfig}
                            />
                          </div>
                        </div>
                      )}
                    </For>
                  </fieldset>
                </PanelDialog.Body>
                <PanelDialog.Footer>
                  <Button variant="ghost" onClick={() => closeReview(false)}>
                    {t().cancel}
                  </Button>
                  <Button variant="primary" onClick={() => closeReview(true)}>
                    {t().keepEditsOnCurrentVersion}
                  </Button>
                </PanelDialog.Footer>
              </PanelDialog>
            ),
            panelDialogOptions,
          );
          if (!reviewed) return;
          const currentValues = Object.fromEntries(
            editableFields.map((field) => [field.id, initialFieldInputValue(field, current.data[field.id])]),
          );
          const editedValues = Object.fromEntries(changedFields.map((field) => [field.id, values()[field.id]]));
          initial = currentValues;
          version = current.version;
          baselineData = current.data;
          setValues({ ...currentValues, ...editedValues });
          setConflict(false);
          setSubmitError(null);
        } catch (error) {
          setSubmitError(error instanceof Error ? error.message : t().updateFailed);
        } finally {
          setSubmitting(false);
        }
      };

      const update = (id: string, v: unknown) => {
        if (submitting()) return;
        setValues((current) => ({ ...current, [id]: v }));
        // Clear the error on user touch — let server-side feedback be
        // the authoritative re-check, but don't keep a stale red banner
        // visible while they're typing.
        if (errors()[id]) {
          const next = { ...errors() };
          delete next[id];
          setErrors(next);
        }
      };

      // Pre-flight required check. Mirrors the server's per-field
      // validation closely but only catches the "obvious empty" cases
      // — full type validation (regex, min/max, number parsing) is
      // left to the server, which surfaces errors in this dialog.
      const validate = (): boolean => {
        const errs: Record<string, string> = {};
        for (const f of editableFields) {
          if (!f.required) continue;
          const v = values()[f.id];
          if (v === null || v === undefined || v === "") {
            errs[f.id] = t().required;
          } else if (Array.isArray(v) && v.length === 0) {
            errs[f.id] = t().required;
          }
        }
        setErrors(errs);
        return Object.keys(errs).length === 0;
      };

      const handleSubmit = async (e: Event) => {
        e.preventDefault();
        if (submitting() || conflict()) return;
        if (!validate()) {
          if (e.currentTarget instanceof HTMLElement) e.currentTarget.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
          return;
        }
        setSubmitError(null);
        // Create omits empties so server-side defaults/nulls apply.
        // Edit sends explicit nulls so users can clear a field. The
        // server validates and normalises every value again.
        const out = sanitizeFieldValues(editableFields, values(), { omitEmpty: args.mode === "create" });
        setSubmitting(true);
        try {
          if (args.beforeSubmit && !(await args.beforeSubmit(out, baselineData))) return;
          await args.onSubmit(out, version);
          close(out);
        } catch (error) {
          setSubmitError(error instanceof Error ? error.message : t().updateFailed);
          setConflict(error instanceof RecordSaveConflictError);
        } finally {
          setSubmitting(false);
        }
      };

      // Field renderer. Synthesizes a UserInputEntry from the field
      // (label/required from the field itself, no per-form override)
      // and hands it to FieldInput — the platform's single field
      // renderer. Everything that diverged here (numeric widget,
      // select widget, relation widget) now matches what
      // PublicFormSubmit, FormSubmitModal, and the field-designer's
      // default-value editor render for the same type.
      const renderField = (f: Field) => {
        const entry: UserInputEntry = {
          kind: "user_input",
          fieldId: f.id,
          required: f.required,
          helpText: f.description ?? undefined,
        };
        return (
          <FieldInput
            field={f}
            entry={entry}
            value={values()[f.id]}
            onChange={(v) => update(f.id, v)}
            error={() => errors()[f.id]}
            baseId={args.baseId}
            relationLabels={args.relationLabels}
            currentRecordId={args.record?.id}
            dateConfig={args.dateConfig}
          />
        );
      };
      const tableName = args.tableName?.trim();
      const title =
        args.mode === "create"
          ? tableName
            ? t().titled({ action: t().newRecord, table: tableName })
            : t().newRecord
          : tableName
            ? t().titled({ action: t().editRecord, table: tableName })
            : t().editRecord;
      const icon = args.mode === "create" ? "ti ti-row-insert-bottom" : "ti ti-pencil";

      return (
        <form onSubmit={handleSubmit} class="contents">
          <PanelDialog>
            <PanelDialog.Header title={title} icon={icon} close={requestClose} closeDisabled={submitting()} />
            <PanelDialog.Body>
              <Show when={editableFields.length > 0} fallback={<p class="text-sm text-dimmed">{t().noEditableFields}</p>}>
                <fieldset disabled={submitting()} class="contents">
                  <For each={editableFields}>{(f) => renderField(f)}</For>
                </fieldset>
              </Show>
              <Show when={submitError()}>{(message) => <NoticeCard tone="danger">{message()}</NoticeCard>}</Show>
              <Show when={conflict() && args.reloadRecord}>
                <Button variant="secondary" onClick={() => void compareCurrent()} disabled={submitting()}>
                  {t().compareCurrentRecord}
                </Button>
              </Show>
            </PanelDialog.Body>
            <PanelDialog.Footer>
              <span />
              <div class="flex items-center gap-2">
                <Button variant="ghost" size="sm" type="button" onClick={requestClose} disabled={submitting()}>
                  {t().cancel}
                </Button>
                <Button variant="primary" size="sm" type="submit" disabled={editableFields.length === 0 || submitting() || conflict()}>
                  {args.mode === "create" ? t().create : t().save}
                </Button>
              </div>
            </PanelDialog.Footer>
          </PanelDialog>
        </form>
      );
    }, panelDialogOptions)
    .then((v) => v ?? null);
};
