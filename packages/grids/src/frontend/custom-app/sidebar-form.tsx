import type { DateContext } from "@k2b/stdlib";
import { confirmDiscardIfDirty, dialogCore, PanelDialog, panelDialogOptions } from "@k2b/ui";
import { createSignal } from "solid-js";
import type { PublicField as Field } from "../../api/public-dto";
import type { PublicRenderableForm } from "../../service/forms";
import FormSubmit from "../_components/forms/PublicFormSubmit.island";

export type CustomAppRenderedSidebarAction = {
  id: string;
  kind: "form";
  label: string;
  icon?: string;
  tone: "default" | "success" | "danger";
  submitUrl: string;
  form: PublicRenderableForm;
  fields: Field[];
  inlineTargetFields: Record<string, Field[]>;
  relationLabels?: Record<string, string>;
  relationLookupFields?: string[];
  dateConfig: DateContext;
};

export const openCustomAppSidebarForm = (action: CustomAppRenderedSidebarAction) => {
  return dialogCore.open<void>((close, context) => {
    const [dirty, setDirty] = createSignal(false);
    const [submitting, setSubmitting] = createSignal(false);
    const closeIfClean = async () => {
      if (submitting()) return;
      if (await confirmDiscardIfDirty(dirty)) close();
    };
    context.setDismissHandler(closeIfClean);
    return (
      <PanelDialog>
        <PanelDialog.Header
          title={action.form.config.title || action.label}
          icon={`ti ti-${action.icon ?? "forms"}`}
          close={() => void closeIfClean()}
        />
        <PanelDialog.Body>
          <FormSubmit
            submitUrl={action.submitUrl}
            form={action.form}
            fields={action.fields}
            inlineTargetFields={action.inlineTargetFields}
            relationLabels={action.relationLabels}
            relationLookupFields={action.relationLookupFields}
            dateConfig={action.dateConfig}
            surface="bare"
            showTitle={false}
            onDirtyChange={setDirty}
            onSubmittingChange={setSubmitting}
          />
        </PanelDialog.Body>
      </PanelDialog>
    );
  }, panelDialogOptions);
};
