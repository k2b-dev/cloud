import LayoutHeader from "./LayoutHeader";
import LayoutRail from "./LayoutRail";
import type { LayoutBreadcrumb } from "./layout-runtime";

type CloudShellProps =
  | { slot: "rail"; currentPath: string }
  | { slot: "header"; authenticated: boolean; title?: string; launchpad: boolean; breadcrumbs?: LayoutBreadcrumb[] };

export default function CloudShell(props: CloudShellProps) {
  return props.slot === "rail" ? <LayoutRail currentPath={props.currentPath} /> : <LayoutHeader {...props} />;
}
