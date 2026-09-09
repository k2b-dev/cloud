import type { DateContext } from "@k2b/stdlib";
import { Button, NoticeCard, PanelHeader, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { evaluateFormValidations } from "../../../form-validations";
import type { PublicRenderableForm } from "../../../service/forms";
import { errorMessage } from "../utils/api-helpers";
import {
  buildFormSubmitPayload,
  buildInitialValues,
  type FrontendField as Field,
  FieldInput,
  type InlineCreateState,
  userInputEntriesOf,
} from "./form-fields";
import { gridsFormMessages } from "./messages";

type Props = {
  /** Form config (fields, labels, defaults) — server-trusted. */
  form: PublicRenderableForm;
  /** Resolved table fields so we know each entry's type + options. */
  fields: Field[];
  inlineTargetFields?: Record<string, Field[]>;
  dateConfig?: DateContext;
  surface?: "bare" | "paper";
  showTitle?: boolean;
  titleAs?: "h1" | "h2";
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

  const [values, setValues] = createSignal<Record<string, unknown>>(buildInitialValues(entries));
  const [inlineCreates, setInlineCreates] = createSignal<InlineCreateState>({});
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [done, setDone] = createSignal(false);
  const [clientReady, setClientReady] = createSignal(false);
  const validationFailures = createMemo(() => evaluateFormValidations(props.form.config.validations, values(), fieldsById));
  const validationErrors = createMemo(() =>
    Object.fromEntries(validationFailures().map((failure) => [failure.errorFieldId, failure.message])),
  );

  const setValue = (fieldId: string, v: unknown) => {
    setValues((current) => ({ ...current, [fieldId]: v }));
    props.onDirtyChange?.(true);
  };
  const setInlineDrafts = (fieldId: string, drafts: InlineCreateState[string]) => {
    setInlineCreates((current) => ({ ...current, [fieldId]: drafts }));
    props.onDirtyChange?.(true);
  };
  const hasInlineCreate = () => entries.some((entry) => entry.inlineCreate?.enabled);
  const surfaceClass = () => (props.surface === "bare" ? "w-full" : "paper mx-auto max-w-xl p-6");

  onMount(() => setClientReady(true));

  const handleSubmit = async (event: Event) => {
    event.preventDefault();
    if (props.preview || submitting()) return;
    setError(null);
    const invalid = validationFailures()[0];
    if (invalid) {
      formRef?.querySelector<HTMLElement>(`[name="${invalid.errorFieldId}"]`)?.focus();
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
          payload[key] = value;
        }
      }
      const submitFields = entries
        .map((entry) => fieldsById.get(entry.fieldId))
        .filter((field): field is Field => Boolean(field && !field.deletedAt));
      const submitPayload = buildFormSubmitPayload(submitFields, payload, inlineCreates(), { omitEmpty: true });
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
        setError(await errorMessage(res, t().submitFailed));
        return;
      }
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
          ref={formRef}
          class="flex flex-col gap-3"
          data-grids-public-form-ready={clientReady() ? "true" : "false"}
          onSubmit={handleSubmit}
        >
          <fieldset disabled={submitting()} class="flex flex-col gap-3 min-w-0">
            <Show when={hasInlineCreate()}>
              <NoticeCard tone="warning" icon={false} bodyClass="flex items-start gap-2">
                <i class="ti ti-alert-triangle mt-0.5 shrink-0" />
                <span>{t().linkedRecordsWarning}</span>
              </NoticeCard>
            </Show>
            <For each={entries}>
              {(entry) => {
                const field = fieldsById.get(entry.fieldId);
                if (!field || field.deletedAt) return null;
                return (
                  <FieldInput
                    field={field}
                    entry={entry}
                    value={values()[entry.fieldId]}
                    onChange={(v) => setValue(entry.fieldId, v)}
                    error={() => validationErrors()[entry.fieldId]}
                    inlineCreates={inlineCreates}
                    onInlineCreatesChange={setInlineDrafts}
                    inlineTargetFields={props.inlineTargetFields}
                    dateConfig={props.dateConfig}
                  />
                );
              }}
            </For>

            <Show when={error()}>
              <NoticeCard tone="danger" icon={false} bodyClass="flex items-start gap-2">
                <i class="ti ti-alert-circle mt-0.5 shrink-0" />
                <span>{error()}</span>
              </NoticeCard>
            </Show>

            {/* Wrap the button so it sizes to its content rather than
              stretching the full form width (flex-column children are
              `align-items: stretch` by default). */}
            <div class="mt-2 flex items-center justify-end">
              <Button variant="primary" size="sm" type="submit" disabled={props.preview || submitting()}>
                <Show when={submitting()} fallback={<i class="ti ti-send" />}>
                  <i class="ti ti-loader-2 animate-spin" />
                </Show>
                {props.form.config.submitLabel ?? t().submit}
              </Button>
            </div>
          </fieldset>
        </form>
      </Show>
    </div>
  );
}
