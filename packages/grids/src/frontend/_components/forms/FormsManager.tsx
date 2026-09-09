import { Button, CopyButton, IconButton, Placeholder, prompts, ScrollArea, Tooltip, useLocale } from "@k2b/ui";
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
  const result = await prompts.form({
    title: t().newForm,
    icon: "ti ti-forms",
    fields: {
      name: { type: "text", label: t().name, required: true, placeholder: t().formNameExample },
    },
    confirmText: t().create,
  });
  if (!result) return;

  const eligibleFields = props.fields.filter((f) => !f.deletedAt && canBeFormInput(f));
  // Default config = include every editable field, in declared order.
  const config: FormConfig = {
    fields: eligibleFields.map((f) => ({
      kind: "user_input" as const,
      fieldId: f.id,
      required: f.required,
    })),
  };
  const res = await apiClient.forms["by-table"][":tableId"].$post({
    param: { tableId: props.tableId },
    json: { name: String(result.name).trim(), config, isPublic: false },
  });
  if (!res.ok) {
    prompts.error(await errorMessage(res, t().createFormFailed));
    return;
  }
  return res.json();
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
      onDelete: () => handleDelete(form),
    });

  // ---- Create ----------------------------------------------------------
  const handleCreate = async () => {
    const created = await createForm(props, locale());
    if (!created) return;
    updateForms([...forms(), created]);
    openFormEditor(created);
  };

  // ---- Delete ----------------------------------------------------------
  const handleDelete = async (form: PublicForm) => {
    if (!form.id) return;
    const confirmed = await prompts.confirm(t().deleteFormConfirm({ name: form.name }), {
      title: t().deleteFormQuestion,
      variant: "danger",
      confirmText: t().delete,
    });
    if (!confirmed) return;
    const res = await apiClient.forms[":formId"].$delete({ param: { formId: form.id } });
    if (res.status >= 400) {
      prompts.error(await errorMessage(res, t().deleteFormFailed));
      return;
    }
    updateForms(forms().filter((f) => f.id !== form.id));
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
