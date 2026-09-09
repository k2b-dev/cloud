import type { DateContext } from "@k2b/stdlib";
import { Button, CopyButton, confirmDiscardIfDirty, dialogCore, NoticeCard, PanelDialog, panelDialogOptions, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { PublicField as Field, PublicForm as Form } from "../../../api/public-dto";
import { evaluateFormValidations } from "../../../form-validations";
import { buildFormSubmitPayload, buildInitialValues, FieldInput, type InlineCreateState, userInputEntriesOf } from "../forms/form-fields";
import { errorMessage } from "../utils/api-helpers";
import { recordMessages } from "./messages";

/**
 * Open a modal that lets an authenticated user fill out a form and
 * submit. Mirrors what `PublicFormSubmit` does for anonymous callers
 * but
 *
 * - posts to `POST /api/grids/forms/:formId/submit` (the authenticated
 *   path that gates on form-write OR table-write — same superset trick
 *   the resolver uses), so the user doesn't need a public token,
 * - renders fields with PLATFORM input components only via the shared
 *   `FieldInput` from `form-fields.tsx`,
 * - shows a success card with "OK" + "Add another" actions instead of
 *   redirecting away — fits the modal context where the user came in
 *   to add a single record and likely wants to add more in a row.
 */
export const openFormModal = (form: Form, fields: Field[], options: { onSubmitted?: () => void; dateConfig?: DateContext } = {}) =>
  dialogCore.open<void>((close, context) => {
    let requestClose = () => {};
    context.setDismissHandler(() => requestClose());
    return (
      <PanelDialog>
        <PanelDialog.Header title={form.config.title ?? form.name} icon="ti ti-forms" close={() => requestClose()} />
        <PanelDialog.Body>
          <FormSubmitBody
            form={form}
            fields={fields}
            onSubmitted={options.onSubmitted}
            dateConfig={options.dateConfig}
            close={close}
            registerClose={(handler) => {
              requestClose = handler;
            }}
          />
        </PanelDialog.Body>
      </PanelDialog>
    );
  }, panelDialogOptions);

function FormSubmitBody(props: {
  form: Form;
  fields: Field[];
  onSubmitted?: () => void;
  dateConfig?: DateContext;
  close: (result?: void) => void;
  registerClose: (handler: () => void) => void;
}) {
  const locale = useLocale();
  const t = () => recordMessages.resolve([locale()]).t;
  const fieldsById = new Map(props.fields.map((f) => [f.id, f]));
  const entries = userInputEntriesOf(props.form.config.fields);

  const [values, setValues] = createSignal<Record<string, unknown>>(buildInitialValues(entries));
  const [inlineCreates, setInlineCreates] = createSignal<InlineCreateState>({});
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [done, setDone] = createSignal(false);
  const [attempted, setAttempted] = createSignal(false);
  const requestClose = async () => {
    if (submitting()) return;
    if (
      done() ||
      (await confirmDiscardIfDirty(
        () => JSON.stringify(values()) !== JSON.stringify(buildInitialValues(entries)) || Object.keys(inlineCreates()).length > 0,
      ))
    )
      props.close();
  };
  props.registerClose(() => void requestClose());
  const validationFailures = createMemo(() => evaluateFormValidations(props.form.config.validations, values(), fieldsById));
  const validationErrors = createMemo(() =>
    Object.fromEntries((attempted() ? validationFailures() : []).map((failure) => [failure.errorFieldId, failure.message])),
  );

  const setValue = (fieldId: string, v: unknown) => {
    if (!submitting()) setValues((current) => ({ ...current, [fieldId]: v }));
  };
  const setInlineDrafts = (fieldId: string, drafts: InlineCreateState[string]) => {
    if (!submitting()) setInlineCreates((current) => ({ ...current, [fieldId]: drafts }));
  };

  const handleSubmit = async (event: Event) => {
    event.preventDefault();
    if (submitting()) return;
    setAttempted(true);
    setError(null);
    const invalid = validationFailures()[0];
    if (invalid) {
      if (event.currentTarget instanceof HTMLElement) event.currentTarget.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      return;
    }
    setSubmitting(true);
    try {
      const formId = props.form.id;
      if (!formId) throw new Error(t().submitUnavailable);
      const payload = buildFormSubmitPayload(
        entries.map((entry) => fieldsById.get(entry.fieldId)).filter((field): field is Field => Boolean(field && !field.deletedAt)),
        values(),
        inlineCreates(),
        { omitEmpty: true },
      );
      const res = await apiClient.forms[":formId"].submit.$post({
        param: { formId },
        json: payload,
      });
      if (!res.ok) {
        setError(await errorMessage(res, t().submitFailed));
        return;
      }
      props.onSubmitted?.();
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : t().submitFailed);
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddAnother = () => {
    setValues(buildInitialValues(entries));
    setInlineCreates({});
    setError(null);
    setDone(false);
    setAttempted(false);
  };

  return (
    <Show
      when={!done()}
      fallback={
        <SuccessState message={props.form.config.successMessage ?? t().saved} onOk={() => props.close()} onAddAnother={handleAddAnother} />
      }
    >
      <form class="flex flex-col gap-3" onSubmit={handleSubmit}>
        {/* Keep title images compact and uncropped across logo and banner aspect ratios. */}
        <Show when={props.form.config.titleImage}>
          {(src) => <img src={src()} alt="" class="w-full max-h-24 rounded-md object-contain" />}
        </Show>
        <Show when={props.form.config.description}>
          <p class="text-sm text-dimmed">{props.form.config.description}</p>
        </Show>

        <fieldset disabled={submitting()} class="contents">
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
                  dateConfig={props.dateConfig}
                />
              );
            }}
          </For>
        </fieldset>

        <Show when={error()}>
          <NoticeCard tone="danger" icon={false} bodyClass="flex items-start gap-2">
            <i class="ti ti-alert-circle mt-0.5 shrink-0" />
            <span>{error()}</span>
          </NoticeCard>
        </Show>

        <div class="mt-2 flex items-center gap-2">
          {/* Public-form share affordance — bottom-left so it doesn't
              compete with the primary Submit on the right. Only shown
              when the form is publicly shared (has a token); for
              private forms the button is meaningless. The full
              absolute URL is built at click time from `window.location.origin`
              so the copied link points at the correct host (SSR can't
              resolve this — the modal is hydrated client-side anyway). */}
          <Show when={props.form.publicToken}>
            {(token) => (
              <CopyButton
                text={`${typeof window !== "undefined" ? window.location.origin : ""}/share/grids/forms/${token()}`}
                label={t().copyPublicLink}
                variant="ghost"
                size="sm"
              />
            )}
          </Show>
          <div class="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" type="button" onClick={requestClose} disabled={submitting()}>
              {t().cancel}
            </Button>
            <Button variant="primary" size="sm" type="submit" disabled={submitting()}>
              <Show when={submitting()} fallback={<i class="ti ti-send" />}>
                <i class="ti ti-loader-2 animate-spin" />
              </Show>
              {props.form.config.submitLabel ?? t().submit}
            </Button>
          </div>
        </div>
      </form>
    </Show>
  );
}

function SuccessState(props: { message: string; onOk: () => void; onAddAnother: () => void }) {
  const locale = useLocale();
  const t = () => recordMessages.resolve([locale()]).t;
  return (
    <div class="flex flex-col items-center gap-4 py-4 text-center">
      <div class="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400">
        <i class="ti ti-check text-2xl" />
      </div>
      <p class="text-sm text-secondary">{props.message}</p>
      <div class="flex items-center gap-2">
        <Button variant="ghost" size="sm" type="button" onClick={props.onAddAnother}>
          <i class="ti ti-plus" />
          {t().addAnother}
        </Button>
        <Button variant="primary" size="sm" type="button" onClick={props.onOk}>
          {t().ok}
        </Button>
      </div>
    </div>
  );
}
