import type { DateContext } from "@k2b/stdlib";
import { AppWorkspace, prompts, useLocale } from "@k2b/ui";
import type { PublicField as Field, PublicForm as Form } from "../../../api/public-dto";
import { sidebarMessages } from "./messages";
import { openSidebarForm } from "./open-sidebar-form";
import SidebarTableMeta from "./SidebarTableMeta";

export default function FormSidebarEntry(props: {
  form: Form;
  tableName: string;
  editMode?: boolean;
  fields: Field[];
  dateConfig?: DateContext;
}) {
  const { t } = sidebarMessages.resolve([useLocale()()]);
  return (
    <AppWorkspace.SidebarItem
      class={props.editMode ? "text-secondary" : undefined}
      onClick={() =>
        void openSidebarForm(props, t).catch((error) => prompts.error(error instanceof Error ? error.message : t.openFormEditorFailed))
      }
      title={t.formEntryTitle({ action: props.editMode ? t.edit : t.submit, name: props.form.name, table: props.tableName })}
    >
      <AppWorkspace.SidebarItemIcon icon="ti ti-forms" />
      <AppWorkspace.SidebarItemLabel>{props.form.name}</AppWorkspace.SidebarItemLabel>
      <SidebarTableMeta tableName={props.tableName} />
    </AppWorkspace.SidebarItem>
  );
}
