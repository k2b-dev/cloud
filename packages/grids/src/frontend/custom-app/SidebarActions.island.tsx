import { openCustomAppSidebarForm } from "./sidebar-form";
import type { DateContext } from "@k2b/stdlib";
import { AppWorkspace } from "@k2b/ui";
import { For } from "solid-js";
import type { PublicField as Field } from "../../api/public-dto";
import type { PublicRenderableForm } from "../../service/forms";

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

export default function SidebarActions(props: { actions: CustomAppRenderedSidebarAction[]; preview?: boolean }) {
  return (
    <For each={props.actions}>
      {(action) => (
        <AppWorkspace.SidebarItem
          icon={`ti ti-${action.icon ?? "forms"}`}
          tone={action.tone}
          disabled={props.preview}
          onClick={() => {
            if (!props.preview) void openCustomAppSidebarForm(action);
          }}
        >
          <AppWorkspace.SidebarItemLabel>{action.label}</AppWorkspace.SidebarItemLabel>
        </AppWorkspace.SidebarItem>
      )}
    </For>
  );
}
