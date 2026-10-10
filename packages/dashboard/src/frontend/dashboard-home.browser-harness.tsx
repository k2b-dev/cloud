import { render } from "solid-js/web";
import DashboardHome, { type DashboardHomeProps } from "./dashboard-home";

/**
 * The real dashboard island for a browser test, with the props the page would render from `window.dashboardProps`.
 * The test server answers `/api/widgets/v1` and `/api/dashboard/settings`.
 */
const props = (window as unknown as { dashboardProps: DashboardHomeProps }).dashboardProps;
render(() => <DashboardHome {...props} />, document.getElementById("root")!);
