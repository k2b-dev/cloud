import type { DateContext } from "@k2b/stdlib";
import { AppWorkspace, toast } from "@k2b/ui";
import { createSignal, For, onCleanup } from "solid-js";
import type { PublicField as Field } from "../../api/public-dto";
import type { PublicRenderableForm } from "../../service/forms";
import { useCustomAppRuntimeMessages } from "./runtime-messages";

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
  const messages = useCustomAppRuntimeMessages();
  const [opening, setOpening] = createSignal<string | null>(null);
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const open = async (action: CustomAppRenderedSidebarAction) => {
    if (props.preview || opening() !== null || disposed) return;
    setOpening(action.id);
    try {
      const { openCustomAppSidebarForm } = await import("./sidebar-form");
      if (disposed) return;
      setOpening(null);
      await openCustomAppSidebarForm(action);
    } catch {
      if (!disposed) toast.error(messages().formUnavailable);
    } finally {
      if (!disposed) setOpening(null);
    }
  };
  return (
    <For each={props.actions}>
      {(action) => (
        <AppWorkspace.SidebarItem
          icon={opening() === action.id ? "ti ti-loader-2 animate-spin" : `ti ti-${action.icon ?? "forms"}`}
          tone={action.tone}
          disabled={props.preview || opening() !== null}
          onClick={() => void open(action)}
        >
          <AppWorkspace.SidebarItemLabel>{action.label}</AppWorkspace.SidebarItemLabel>
        </AppWorkspace.SidebarItem>
      )}
    </For>
  );
}
