import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { IconButton, Tooltip, useLocale } from "@k2b/ui";
import { createEffect, onCleanup, Show } from "solid-js";
import { notebookWorkspaceMessages } from "../../messages";
import { NOTEBOOK_NAVIGATION_ID, setNavigationHidden } from "./navigation-visibility";

type Props = {
  hidden: boolean;
  /** Views without the editor toolbar need a visible way back; the toolbar has its own toggle. */
  showControl: boolean;
};

/**
 * The search command and shortcut that toggle the hidden notebook navigation,
 * plus the control that shows it again. Every navigation that can hide, the
 * workspace sidebar and Book view's contents list, renders these.
 */
export default function NavigationVisibilityControls(props: Props) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;

  createEffect(() => {
    const hidden = props.hidden;
    onCleanup(
      registerContextAwareCommand({
        id: "notebooks.navigation.toggle",
        title: hidden ? t().showNavigationCommand : t().hideNavigationCommand,
        description: t().navigationCommandDescription,
        icon: hidden ? "ti ti-layout-sidebar-left-expand" : "ti ti-layout-sidebar-left-collapse",
        shortcut: "mod+alt+s",
        action: () => setNavigationHidden(!hidden),
      }),
    );
  });

  // Phones keep the navigation in the header menu, so the control exists from lg up.
  return (
    <Show when={props.hidden && props.showControl}>
      <div class="absolute bottom-3 left-3 z-10 hidden lg:flex">
        <Tooltip.Anchor content={t().showNavigation}>
          <IconButton
            label={t().showNavigation}
            tooltip={false}
            variant="secondary"
            size="sm"
            aria-expanded="false"
            aria-controls={NOTEBOOK_NAVIGATION_ID}
            onClick={() => setNavigationHidden(false)}
          >
            <i class="ti ti-layout-sidebar-left-expand" aria-hidden="true" />
          </IconButton>
        </Tooltip.Anchor>
      </div>
    </Show>
  );
}
