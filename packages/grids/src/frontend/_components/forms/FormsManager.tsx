import {
  Button,
  CopyButton,
  confirmDiscardIfDirty,
  dialogCore,
  IconButton,
  NoticeCard,
  PanelDialog,
  Placeholder,
  panelDialogOptions,
  ScrollArea,
  TextInput,
  Tooltip,
  useLocale,
} from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { PublicField as Field, PublicForm } from "../../../api/public-dto";
import type { FormConfig } from "../../../service/forms";
import { isRecordInputField } from "../fields/field-render";
import { errorMessage } from "../utils/api-helpers";
import { openFormEditorDialog } from "./FormEditorDialog";
import { gridsFormMessages } from "./messages";

export { openFormEditorDialog } from "./FormEditorDialog";

const canBeFormInput = (field: Field) => isRecordInputField(field.type);

const publicFormUrl = (token: string) => `${typeof window === "undefined" ? "" : window.location.origin}/share/grids/forms/${token}`;

type Props = {
  tableId: string;
  /** All fields on this table — drives the "Add field" picker and the
   *  rendered field rows inside each form. */
  fields: Field[];
  initialForms: PublicForm[];
  canManage: boolean;
  onFormsChanged?: (forms: PublicForm[]) => void;
};

export const createForm = async (props: { tableId: string; fields: Field[] }, locale: string): Promise<PublicForm | undefined> => {
  const t = () => gridsFormMessages.resolve([locale]).t;
  const eligibleFields = props.fields.filter((f) => !f.deletedAt && canBeFormInput(f));
  // Default config = include every editable field, in declared order.
  const config: FormConfig = {
    fields: eligibleFields.map((f) => ({
      kind: "user_input" as const,
      fieldId: f.id,
      required: f.required,
    })),
  };
  return dialogCore.open<PublicForm>((close, context) => {
    const [name, setName] = createSignal("");
    const [pending, setPending] = createSignal(false);
    const [invalid, setInvalid] = createSignal(false);
    const [error, setError] = createSignal<string>();
    let input: HTMLInputElement | undefined;
    const dismiss = async () => {
      if (!pending() && (await confirmDiscardIfDirty(Boolean(name())))) close();
    };
    context.setDismissHandler(dismiss);
    const save = async () => {
      if (pending()) return;
      if (!name().trim()) {
        setInvalid(true);
        input?.focus();
        return;
      }
      setPending(true);
      setError(undefined);
      try {
        const response = await apiClient.forms["by-table"][":tableId"].$post({
          param: { tableId: props.tableId },
          json: { name: name().trim(), config, isPublic: false },
        });
        if (!response.ok) throw new Error(await errorMessage(response, t().createFormFailed));
        close(await response.json());
      } catch (error) {
        setError(error instanceof Error ? error.message : t().createFormFailed);
      } finally {
        setPending(false);
      }
    };
    return (
      <PanelDialog>
        <PanelDialog.Header title={t().newForm} icon="ti ti-forms" close={dismiss} closeDisabled={pending()} />
        <PanelDialog.Body>
          <TextInput
            ref={(element) => {
              input = element;
            }}
            label={t().name}
            value={name}
            onValueChange={setName}
            required
            placeholder={t().formNameExample}
            disabled={pending()}
            error={() => (invalid() && !name().trim() ? t().nameRequired : undefined)}
            onSubmit={save}
          />
          <Show when={error()}>{(message) => <NoticeCard tone="danger" title={message()} />}</Show>
        </PanelDialog.Body>
        <PanelDialog.Footer>
          <Button variant="secondary" onClick={dismiss} disabled={pending()}>
            {t().cancel}
          </Button>
          <Button onClick={save} loading={pending()}>
            {t().create}
          </Button>
        </PanelDialog.Footer>
      </PanelDialog>
    );
  }, panelDialogOptions);
};

/**
 * Form builder. Mirrors the field-editor card pattern: every form
 * collapses to a one-line summary; clicking expands it for full edit.
 * Each form's expanded body has three sub-sections — General (name +
 * public toggle), Submission (submit label + success message), Fields
 * (which table-fields appear, with per-row label/help/required overrides
 * and a + picker for fields not yet included).
 *
 * Default form (`default-<tableId>`) is virtual server-side and not
 * persisted; we filter it out of the editor list — users edit real
 * forms here, the default is always available regardless.
 */
export default function FormsManager(props: Props) {
  const locale = useLocale();
  const t = () => gridsFormMessages.resolve([locale()]).t;
  const [forms, setForms] = createSignal<PublicForm[]>(props.initialForms.filter((f) => !f.isDefault));

  const updateForms = (next: PublicForm[]) => {
    setForms(next);
    props.onFormsChanged?.(next);
  };

  /**
   * Open the form editor inside a centered modal. Previously each form
   * expanded inline below its row; with several forms the page grew to
   * multiple screens. The modal keeps the row list compact and gives
   * the editor a fixed viewport — same UX as the field editor.
   */
  const openFormEditor = (form: PublicForm) =>
    openFormEditorDialog({
      form,
      tableFields: props.fields,
      onSaved: (next) => updateForms(forms().map((f) => (f.id === next.id ? next : f))),
      onDelete: () => updateForms(forms().filter((f) => f.id !== form.id)),
    });

  // ---- Create ----------------------------------------------------------
  const handleCreate = async () => {
    const created = await createForm(props, locale());
    if (!created) return;
    updateForms([...forms(), created]);
    openFormEditor(created);
  };

  return (
    <ScrollArea class="flex min-h-0 flex-1 flex-col gap-2">
      <Show when={forms().length > 0} fallback={<Placeholder surface="paper" align="left" description={<>{t().noCustomForms}</>} />}>
        <ul class="flex flex-col gap-2">
          <For each={forms()}>
            {(form) => (
              <li class="group paper transition-colors hover:paper-highlighted">
                <div class="flex min-h-12 items-center gap-2 px-3 py-2">
                  <span class="flex w-6 shrink-0 items-center justify-center">
                    <i
                      class={`ti ${form.publicToken ? "ti-world" : "ti-lock"} text-sm ${form.publicToken ? "text-emerald-600" : "text-dimmed"}`}
                    />
                  </span>
                  <button
                    type="button"
                    class="flex min-h-8 min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--k2b-focus-ring)]"
                    onClick={() => openFormEditor(form)}
                    aria-label={t().editFormNamed({ name: form.name })}
                  >
                    <span class="flex min-w-0 flex-1 items-baseline gap-2">
                      <span class="text-sm font-semibold text-primary truncate">{form.name}</span>
                      <span class="text-[10px] text-dimmed">{t().fieldCount({ count: form.config.fields.length })}</span>
                      <span class="text-[10px] text-dimmed">· {form.publicToken ? t().publicStatus : t().privateStatus}</span>
                    </span>
                  </button>
                  <div class="flex shrink-0 items-center gap-0">
                    <Show when={form.publicToken}>{(token) => <CopyButton text={publicFormUrl(token())} />}</Show>
                    <Tooltip.Anchor content={t().editFormNamed({ name: form.name })}>
                      <IconButton
                        variant="ghost"
                        size="sm"
                        type="button"
                        onClick={() => openFormEditor(form)}
                        label={t().editFormNamed({ name: form.name })}
                      >
                        <i class="ti ti-pencil" />
                      </IconButton>
                    </Tooltip.Anchor>
                  </div>
                </div>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={props.canManage}>
        <Button variant="success" size="sm" type="button" class="self-start" onClick={handleCreate}>
          <i class="ti ti-plus" /> {t().newForm}
        </Button>
      </Show>
    </ScrollArea>
  );
}
