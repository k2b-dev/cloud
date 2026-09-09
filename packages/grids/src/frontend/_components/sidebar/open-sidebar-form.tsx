import { refreshCurrentPath } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { Button, prompts } from "@k2b/ui";
import type { PublicField, PublicForm } from "../../../api/public-dto";
import { openFormEditorDialog } from "../forms/FormsManager";
import { openFormModal } from "../records/FormSubmitModal";
import type { sidebarMessages } from "./messages";

export const openSidebarForm = async (
  props: { form: PublicForm; fields: PublicField[]; editMode?: boolean; dateConfig?: DateContext },
  t: ReturnType<typeof sidebarMessages.resolve>["t"],
) => {
  let action: "use" | "edit" | undefined = "use";
  if (props.editMode)
    action = await prompts.dialog<"use" | "edit">(
      (close) => (
        <div class="flex flex-col gap-4">
          <p class="text-sm text-dimmed">{t.editModeQuestion({ name: props.form.name })}</p>
          <div class="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => close("use")}>
              {t.useForm}
            </Button>
            <Button size="sm" onClick={() => close("edit")}>
              {t.editForm}
            </Button>
          </div>
        </div>
      ),
      { title: t.formInEditMode, icon: "ti ti-forms", size: "small" },
    );
  if (action === "use") return openFormModal(props.form, props.fields, { onSubmitted: refreshCurrentPath, dateConfig: props.dateConfig });
  if (action === "edit")
    return openFormEditorDialog({ form: props.form, tableFields: props.fields, onSaved: refreshCurrentPath, onDelete: refreshCurrentPath });
};
