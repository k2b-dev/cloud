import type { DateContext } from "@k2b/stdlib";
import { Button, NoticeCard, PanelHeader, prompts, useLocale } from "@k2b/ui";
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { evaluateFormValidations } from "../../../form-validations";
import type { PublicRenderableForm } from "../../../service/forms";
import { errorMessage } from "../utils/api-helpers";
import { FormComputedSummary } from "./FormComputedSummary";
import { createFormSections, FormSections, focusFormField } from "./FormSections";
import { formFieldClass, formLayoutClass } from "./field-layout";
import {
  buildFormSubmitPayload,
  buildInitialValues,
  type FrontendField as Field,
  FieldInput,
  type InlineCreateState,
  userInputEntriesOf,
} from "./form-fields";
import { formFieldError } from "./form-input-validation";
import type { FormEditState } from "./form-submit-payload";
import { gridsFormMessages } from "./messages";
import { normalizeNumberInput } from "./number-input";

type Props = {
  /** Form config (fields, labels, defaults) — server-trusted. */
  form: PublicRenderableForm;
  /** Resolved table fields so we know each entry's type + options. */
  fields: Field[];
  inlineTargetFields?: Record<string, Field[]>;
  initialRecord?: FormEditState;
  relationLabels?: Record<string, string>;
  relationLookupFields?: string[];
  dateConfig?: DateContext;
  surface?: "bare" | "paper";
  showTitle?: boolean;
  disabled?: boolean;
  titleAs?: "h1" | "h2";
  formRef?: (form: HTMLFormElement) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSubmittingChange?: (submitting: boolean) => void;
} & (
  | { publicToken: string; submitUrl?: never; preview?: never }
  | { publicToken?: never; submitUrl: string; preview?: never }
  | { publicToken?: never; submitUrl?: never; preview: true }
);

/**
 * Shared Form submit surface. It renders the same field contract for a
 * public token or an authenticated internal endpoint and shows the
 * configured success message on completion.
 *
 * All field rendering lives in `form-fields.tsx` and uses platform
 * inputs only (TextInput / NumberInput / DatePicker / DateTimePicker /
 * Checkbox / Select / CheckboxCards for select).
 */
export default function FormSubmit(props: Props) {
  const locale = useLocale();
  const t = () => gridsFormMessages.resolve([locale()]).t;
  const fieldsById = new Map(props.fields.map((f) => [f.id, f]));
  const entries = userInputEntriesOf(props.form.config.fields);
  let formRef: HTMLFormElement | undefined;

  const [values, setValues] = createSignal<Record<string, unknown>>(
    props.initialRecord?.values ?? buildInitialValues(entries, props.fields),
  );
  const sections = createFormSections(entries, values());
  const [inlineCreates, setInlineCreates] = createSignal<InlineCreateState>(props.initialRecord?.inlineCreates ?? {});
  const [submitting, setSubmitting] = createSignal(false);
  const [dirty, setDirty] = createSignal(false);
  const [pendingSubmission, setPendingSubmission] = createSignal<Record<string, unknown> | null>(null);
  const [confirmedConflict, setConfirmedConflict] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [done, setDone] = createSignal(false);
  const [clientReady, setClientReady] = createSignal(false);
  const [validationAttempted, setValidationAttempted] = createSignal(false);
  const validationFailures = createMemo(() => {
    const failures: Array<{ errorFieldId: string; message: string }> = evaluateFormValidations(
      props.form.config.validations,
      values(),
      fieldsById,
    );
    if (!validationAttempted()) return failures;
    const context = { locale: locale(), dateConfig: props.dateConfig };
    for (const entry of entries) {
      const field = fieldsById.get(entry.fieldId);
      if (!field || field.deletedAt) continue;
      let message = formFieldError(field, entry, values()[field.id], context);
      if (!message && entry.inlineCreate?.enabled) {
        const targetFields = props.inlineTargetFields?.[String(field.config.targetTableId)] ?? [];
        for (const draft of inlineCreates()[field.id] ?? []) {
          for (const inlineEntry of entry.inlineCreate.fields ?? []) {
            const target = targetFields.find((field) => field.id === inlineEntry.fieldId);
            if (!target) continue;
            const value = draft.data[target.id] !== undefined ? draft.data[target.id] : (inlineEntry.defaultValue ?? target.defaultValue);
            const detail = formFieldError(target, inlineEntry, value, context);
            if (detail) {
              message = `${inlineEntry.label || target.name}: ${detail}`;
              break;
            }
          }
          if (message) break;
        }
      }
      if (message) failures.push({ errorFieldId: field.id, message });
    }
    return failures;
  });
  const validationErrors = createMemo(() =>
    Object.fromEntries(validationFailures().map((failure) => [failure.errorFieldId, failure.message])),
  );

  const setValue = (fieldId: string, v: unknown) => {
    if (props.disabled || pendingSubmission()) return;
    setValues((current) => ({ ...current, [fieldId]: v }));
    setDirty(true);
    props.onDirtyChange?.(true);
  };
  const setInlineDrafts = (fieldId: string, drafts: InlineCreateState[string]) => {
    if (props.disabled || pendingSubmission()) return;
    setInlineCreates((current) => ({ ...current, [fieldId]: drafts }));
    setDirty(true);
    props.onDirtyChange?.(true);
  };
  const hasInlineCreate = () =>
    entries.some((entry) => {
      if (!entry.inlineCreate?.enabled) return false;
      const selected = values()[entry.fieldId];
      return Array.isArray(selected) && (inlineCreates()[entry.fieldId] ?? []).some((draft) => selected.includes(draft.tempId));
    });
  const surfaceClass = () => (props.surface === "bare" ? "w-full" : "paper mx-auto max-w-xl p-6");

  onMount(() => {
    setClientReady(true);
    const warn = (event: BeforeUnloadEvent) => {
      if (!props.preview && (dirty() || submitting())) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    onCleanup(() => window.removeEventListener("beforeunload", warn));
  });

  const handleSubmit = async (event: Event) => {
    event.preventDefault();
    if (props.disabled || props.preview || submitting()) return;
    setError(null);
    if (!pendingSubmission()) {
      // Include native controls/autofill before validating or disabling fields.
      const captured = { ...values() };
      for (const [key, value] of formRef ? new FormData(formRef).entries() : []) {
        if (typeof value === "string" && fieldsById.has(key))
          captured[key] = fieldsById.get(key)?.type === "number" ? normalizeNumberInput(value, locale()) : value;
      }
      setValues(captured);
      setValidationAttempted(true);
    }
    const invalid = pendingSubmission() ? undefined : entries.find((entry) => validationErrors()[entry.fieldId]);
    if (invalid) {
      focusFormField(formRef, invalid.fieldId, sections);
      return;
    }
    // Capture native controls before the pending fieldset disables them.
    const formData = formRef ? new FormData(formRef) : null;
    setSubmitting(true);
    props.onSubmittingChange?.(true);
    try {
      const payload: Record<string, unknown> = { ...values() };
      if (formData) {
        for (const [key, value] of formData.entries()) {
          if (typeof value !== "string") continue;
          payload[key] = fieldsById.get(key)?.type === "number" ? normalizeNumberInput(value, locale()) : value;
        }
      }
      const submitFields = entries
        .map((entry) => fieldsById.get(entry.fieldId))
        .filter((field): field is Field => Boolean(field && !field.deletedAt));
      const retrying = pendingSubmission() !== null;
      const submitPayload =
        pendingSubmission() ??
        buildFormSubmitPayload(submitFields, payload, inlineCreates(), {
          omitEmpty: !props.initialRecord,
          recordVersion: props.initialRecord?.version,
          idempotencyKey: crypto.randomUUID(),
        });
      setPendingSubmission(submitPayload);
      const res = props.submitUrl
        ? await fetch(props.submitUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(submitPayload),
          })
        : await apiClient.forms.public[":token"].submit.$post({
            param: { token: props.publicToken! },
            json: submitPayload,
          });
      if (!res.ok) {
        setConfirmedConflict(Boolean(props.initialRecord) && !retrying && res.status === 409);
        if (!retrying && [400, 401, 403, 404, 422].includes(res.status)) setPendingSubmission(null);
        setError(await errorMessage(res, t().submitFailed));
        return;
      }
      setDirty(false);
      setSubmitting(false);
      props.onDirtyChange?.(false);
      if (props.submitUrl) {
        const result = (await res.json()) as { navigateTo?: unknown };
        if (typeof result.navigateTo === "string") {
          window.location.replace(result.navigateTo);
          return;
        }
      }
      const redirect = props.publicToken ? props.form.config.redirectUrl : null;
      if (redirect) {
        window.location.href = redirect;
        return;
      }
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : t().submitFailed);
    } finally {
      setSubmitting(false);
      props.onSubmittingChange?.(false);
    }
  };

  return (
    <div class={`${surfaceClass()} flex flex-col gap-4`}>
      {/* Optional title image — banner above the form. Compact
          max-h (96 px) + object-contain matches FormSubmitModal so
          the public page and the in-app preview render the same
          shape regardless of source aspect ratio. */}
      <Show when={props.form.config.titleImage}>
        {(src) => <img src={src()} alt="" class="w-full max-h-24 rounded-md object-contain" />}
      </Show>
      <Show
        when={props.showTitle !== false}
        fallback={
          <Show when={props.form.config.description}>
            <p class="text-sm text-dimmed">{props.form.config.description}</p>
          </Show>
        }
      >
        <PanelHeader
          title={props.form.config.title ?? props.form.name}
          subtitle={props.form.config.description}
          as={props.titleAs ?? "h1"}
          size="md"
        />
      </Show>

      <Show
        when={!done()}
        fallback={
          <NoticeCard tone="success" icon={false} bodyClass="flex items-center gap-2">
            <i class="ti ti-circle-check shrink-0" />
            <span>{props.form.config.successMessage ?? t().saved}</span>
          </NoticeCard>
        }
      >
        <form
          ref={(element) => {
            formRef = element;
            props.formRef?.(element);
          }}
          class="flex flex-col gap-3"
          data-grids-public-form-ready={clientReady() ? "true" : "false"}
          noValidate
          onSubmit={handleSubmit}
        >
          <fieldset disabled={props.disabled || submitting() || pendingSubmission() !== null} class={formLayoutClass}>
            <Show when={hasInlineCreate()}>
              <NoticeCard class="basis-full" tone="info" icon={false} bodyClass="flex items-start gap-2">
                <i class="ti ti-info-circle mt-0.5 shrink-0" />
                <span>{t().linkedRecordsWarning}</span>
              </NoticeCard>
            </Show>
            <FormSections state={sections}>
              {(entry) => {
                const field = fieldsById.get(entry.fieldId);
                if (!field || field.deletedAt) return null;
                return (
                  <div class={formFieldClass(entry.width)} data-grids-form-field={entry.fieldId}>
                    <FieldInput
                      field={field}
                      entry={entry}
                      value={values()[entry.fieldId]}
                      relationLabels={props.relationLabels}
                      relationLookupUrl={
                        props.relationLookupFields?.includes(entry.fieldId)
                          ? props.submitUrl?.replace(/\/submit(?=\?|$)/, `/relations/${entry.fieldId}/lookup`)
                          : undefined
                      }
                      onChange={(v) => setValue(entry.fieldId, v)}
                      error={() => validationErrors()[entry.fieldId]}
                      validate={validationAttempted()}
                      inlineCreates={inlineCreates}
                      onInlineCreatesChange={setInlineDrafts}
                      inlineTargetFields={props.inlineTargetFields}
                      dateConfig={props.dateConfig}
                    />
                  </div>
                );
              }}
            </FormSections>
          </fieldset>

          <Show when={error()}>
            <NoticeCard tone="danger" icon={false} bodyClass="flex items-start gap-2">
              <i class="ti ti-alert-circle mt-0.5 shrink-0" />
              <span>{error()}</span>
            </NoticeCard>
            <Show when={pendingSubmission() && !confirmedConflict()}>
              <p class="text-sm text-dimmed">{t().retrySubmission}</p>
            </Show>
            <Show when={confirmedConflict()}>
              <Button
                variant="input"
                type="button"
                onClick={async () => {
                  if (
                    await prompts.confirm(t().reloadEditWarning, { title: t().reloadCurrentValues, confirmText: t().reloadCurrentValues })
                  ) {
                    window.location.reload();
                  }
                }}
              >
                {t().reloadCurrentValues}
              </Button>
            </Show>
          </Show>

          <FormComputedSummary config={props.form.config} fields={props.fields} values={values()} dateConfig={props.dateConfig} />
          {/* Wrap the button so it sizes to its content rather than
              stretching the full form width (flex-column children are
              `align-items: stretch` by default). */}
          <div class="mt-2 flex items-center justify-end">
            <Button
              variant="primary"
              size="sm"
              type="submit"
              disabled={props.disabled || props.preview || submitting() || confirmedConflict()}
            >
              <Show when={submitting()} fallback={<i class="ti ti-send" />}>
                <i class="ti ti-loader-2 animate-spin" />
              </Show>
              {props.form.config.submitLabel ?? (props.initialRecord ? t().saveChanges : t().submit)}
            </Button>
          </div>
        </form>
      </Show>
    </div>
  );
}
