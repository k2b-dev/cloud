import type { DateContext } from "@k2b/stdlib";
import { confirmDiscardIfDirty, dialogCore, PanelDialog, panelDialogOptions } from "@k2b/ui";
import { createSignal } from "solid-js";
import type { FormBlockData } from "../../api/custom-app-published-page";
import type { PublicField as Field } from "../../api/public-dto";
import type { PublicRenderableForm } from "../../service/forms";
import FormSubmit from "../_components/forms/PublicFormSubmit";

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

export const openCustomAppSidebarForm = (action: CustomAppRenderedSidebarAction) =>
  openCustomAppFormDialog({ ...action, data: { ...action, ok: true } });

export const openCustomAppFormDialog = (action: {
  label: string;
  icon?: string;
  data: Extract<FormBlockData, { ok: true }>;
  dateConfig: DateContext;
}) => {
  return dialogCore.open<void>((close, context) => {
    const [dirty, setDirty] = createSignal(false);
    const [submitting, setSubmitting] = createSignal(false);
    const closeIfClean = async () => {
      if (submitting()) return;
      if (await confirmDiscardIfDirty(dirty)) close();
    };
    context.setDismissHandler(closeIfClean);
    const saved = () => {
      close();
      window.location.reload();
    };
    return (
      <PanelDialog>
        <PanelDialog.Header
          title={action.label}
          icon={`ti ti-${action.icon ?? "forms"}`}
          close={() => void closeIfClean()}
          closeDisabled={submitting()}
        />
        <PanelDialog.Body>
          <FormSubmit
            submitUrl={action.data.submitUrl}
            form={action.data.form}
            fields={action.data.fields}
            inlineTargetFields={action.data.inlineTargetFields}
            initialRecord={action.data.initialRecord}
            relationLabels={action.data.relationLabels}
            relationLookupFields={action.data.relationLookupFields}
            dateConfig={action.dateConfig}
            surface="bare"
            showTitle={false}
            onDirtyChange={setDirty}
            onSubmittingChange={setSubmitting}
            onSuccess={saved}
          />
        </PanelDialog.Body>
      </PanelDialog>
    );
  }, panelDialogOptions);
};
