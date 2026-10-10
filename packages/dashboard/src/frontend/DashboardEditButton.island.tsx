import { createMemo } from "solid-js";
import type { DashboardWidgetSummary } from "../shared";
import { dashboardTilesOnPage } from "./board-store";
import { type DashboardControlsProps, DashboardEditButton } from "./dashboard-controls";
import { type DashboardWidgetHint, summarizeDashboardWidgets } from "./widget-board";

export type DashboardEditButtonIslandProps = Omit<DashboardControlsProps, "available" | "inaccessible"> & {
  /** Every declared widget with the app's name and icon. */
  widgets: DashboardWidgetSummary[];
  hint: DashboardWidgetHint;
};

/** The edit dialog lists widgets by what they answered on this page, and by the hint until they have. */
export default function DashboardEditButtonIsland(props: DashboardEditButtonIslandProps) {
  const lists = createMemo(() =>
    summarizeDashboardWidgets(props.widgets, props.hint, dashboardTilesOnPage(), props.settings.hiddenWidgets),
  );
  return (
    <DashboardEditButton
      apps={props.apps}
      legalLinks={props.legalLinks}
      settings={props.settings}
      available={lists().available}
      inaccessible={lists().inaccessible}
    />
  );
}
