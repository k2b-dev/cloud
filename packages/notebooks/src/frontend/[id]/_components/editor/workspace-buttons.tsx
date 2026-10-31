import { appWorkspaceDetailElementId, IconButton, Tooltip, useLocale } from "@k2b/ui";
import { notebookWorkspaceMessages } from "../../messages";
import { NOTEBOOK_DETAIL_ID } from "../detail/events";
import { NOTEBOOK_NAVIGATION_ID } from "../sidebar/navigation-visibility";

/**
 * The note page draws no workspace head, so the bar under the note holds its buttons: the editor toolbar and, once
 * syncing ended, the bar that replaces it. The shared workspace controller runs both and keeps aria-expanded current.
 */

/** Opens the navigation as an overlay below a 64 rem app host and shows or hides the column from there. */
export function NavigationButton() {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  // Phones keep the header's menu (app.css).
  return (
    <div class="notebooks-navigation-toggle">
      <Tooltip.Anchor content={t().navigation}>
        <IconButton
          label={t().navigation}
          tooltip={false}
          size="xs"
          class="text-dimmed"
          aria-controls={NOTEBOOK_NAVIGATION_ID}
          data-app-workspace-sidebar-toggle=""
        >
          <i class="ti ti-layout-sidebar text-sm" aria-hidden="true" />
        </IconButton>
      </Tooltip.Anchor>
    </div>
  );
}

/** Opens and closes the detail panel and, while it waits for room, slides it in. */
export function DetailsButton() {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  return (
    <Tooltip.Anchor content={t().detailPanel}>
      <IconButton
        label={t().detailPanel}
        tooltip={false}
        size="xs"
        class="text-dimmed shrink-0"
        aria-controls={appWorkspaceDetailElementId(NOTEBOOK_DETAIL_ID)}
        data-app-workspace-detail-toggle=""
      >
        <i class="ti ti-layout-sidebar-right text-sm" aria-hidden="true" />
      </IconButton>
    </Tooltip.Anchor>
  );
}
