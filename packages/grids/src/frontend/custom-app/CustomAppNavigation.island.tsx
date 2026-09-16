import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { createNavigation, type NavigationItem, toast } from "@k2b/ui";
import { createSignal, onCleanup } from "solid-js";
import { customAppPageHref } from "../../custom-apps/routing";
import { useCustomAppRuntimeMessages } from "./runtime-messages";
import type { CustomAppRenderedSidebarAction } from "./sidebar-form";

export default function CustomAppNavigation(props: {
  name: string;
  pages: Array<{ id: string; title: string; icon?: string }>;
  appId: string;
  pageId: string;
  actions: CustomAppRenderedSidebarAction[];
}) {
  const messages = useCustomAppRuntimeMessages();
  const [opening, setOpening] = createSignal<string | null>(null);
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const navigation = createNavigation({
    items: (): NavigationItem[] => [
      ...props.actions.map((action) => ({
        id: `action:${action.id}`,
        action: action.id,
        label: action.label,
        icon: opening() === action.id ? "ti ti-loader-2 animate-spin" : `ti ti-${action.icon ?? "forms"}`,
        disabled: opening() !== null,
      })),
      ...props.pages.map((page) => ({
        id: page.id,
        label: page.title,
        icon: `ti ti-${page.icon ?? "file"}`,
        href: customAppPageHref(props.appId, page.id),
        active: page.id === props.pageId,
      })),
    ],
    onAction: async (id) => {
      const action = props.actions.find((item) => item.id === id);
      if (!action || opening() !== null || disposed) return;
      setOpening(id);
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
    },
  });
  return <WorkspaceNavigationProvider navigation={navigation} label={props.name} />;
}
