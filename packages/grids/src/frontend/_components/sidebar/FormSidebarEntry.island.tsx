import { refreshCurrentPath } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { AppWorkspace, Button, prompts, useLocale } from "@k2b/ui";
import type { PublicField as Field, PublicForm as Form } from "../../../api/public-dto";
import { openFormEditorDialog } from "../forms/FormsManager";
import { openFormModal } from "../records/FormSubmitModal";
import { sidebarMessages } from "./messages";
import SidebarTableMeta from "./SidebarTableMeta";

type Props = {
  form: Form;
  tableName: string;
  editMode?: boolean;
  /** All fields on the form's parent table — used by the modal to
   *  render input rows for each user_input entry referenced by the
   *  form config. Pre-fetched server-side so the click is instant. */
  fields: Field[];
  dateConfig?: DateContext;
};

const chooseEditModeAction = (formName: string, t: ReturnType<typeof sidebarMessages.resolve>["t"]) =>
  prompts.dialog<"use" | "edit">(
    (close) => (
      <div class="flex flex-col gap-4">
        <p class="text-sm text-dimmed">{t.editModeQuestion({ name: formName })}</p>
        <div class="flex justify-end gap-2">
          <Button variant="secondary" size="sm" type="button" onClick={() => close("use")}>
            <i class="ti ti-send" /> {t.useForm}
          </Button>
          <Button variant="primary" size="sm" type="button" onClick={() => close("edit")}>
            <i class="ti ti-pencil" /> {t.editForm}
          </Button>
        </div>
      </div>
    ),
    { title: t.formInEditMode, icon: "ti ti-forms", size: "small" },
  );

/**
 * Sidebar row for a single form. Click opens the authenticated submit
 * modal.
 *
 * Lives as its own island file because the records-page is SSR and
 * can't carry an onClick handler directly. We hydrate just this small
 * button — nothing else from the surrounding sidebar — to keep the
 * payload minimal.
 */
export default function FormSidebarEntry(props: Props) {
  const { t } = sidebarMessages.resolve([useLocale()()]);
  const openSubmit = () =>
    openFormModal(props.form, props.fields, {
      onSubmitted: refreshCurrentPath,
      dateConfig: props.dateConfig,
    });

  const openEditor = () =>
    openFormEditorDialog({
      form: props.form,
      tableFields: props.fields,
      onSaved: refreshCurrentPath,
      onDelete: refreshCurrentPath,
    });

  const handleClick = async () => {
    if (props.editMode) {
      const action = await chooseEditModeAction(props.form.name, t);
      if (action === "use") void openSubmit();
      if (action === "edit") {
        await openEditor().catch((error: unknown) => {
          prompts.error(error instanceof Error ? error.message : t.openFormEditorFailed);
        });
      }
      return;
    }
    void openSubmit();
  };

  return (
    <AppWorkspace.SidebarItem
      class={props.editMode ? "text-secondary" : undefined}
      onClick={() => void handleClick()}
      title={t.formEntryTitle({ action: props.editMode ? t.edit : t.submit, name: props.form.name, table: props.tableName })}
    >
      <AppWorkspace.SidebarItemIcon icon="ti ti-forms" />
      <AppWorkspace.SidebarItemLabel>{props.form.name}</AppWorkspace.SidebarItemLabel>
      <SidebarTableMeta tableName={props.tableName} />
    </AppWorkspace.SidebarItem>
  );
}
