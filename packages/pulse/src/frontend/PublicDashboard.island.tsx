import type { DashboardRange } from "../dashboard-contracts";
import DashboardView from "./workspace/DashboardView";
import type { PublicDashboard } from "./workspace/dashboard-client";

export default function PublicDashboardPage(props: { dashboard: PublicDashboard; token: string; range: DashboardRange; path: string }) {
  return (
    <main class="pulse-dashboard__public">
      <DashboardView
        name={props.dashboard.name}
        panels={props.dashboard.panels}
        target={{ token: props.token }}
        range={props.range}
        path={props.path}
      />
    </main>
  );
}
