import CustomAppBuilder from "../custom-apps/CustomAppBuilder";
import type { PublicOkWorkspaceState } from "./workspace-public-state-model";

/**
 * The v1 route island of a base page. Every other route kind renders on v2 in its own screen; this island serves
 * the custom app builder, which stays on v1 until it moves.
 */
export default function GridsRoute(props: { state: PublicOkWorkspaceState; userId?: string; now?: string }) {
  const state = props.state;
  const route = state.route;
  if (route.kind !== "customApp") return null;
  return (
    <CustomAppBuilder
      app={route.app}
      baseId={state.base.id}
      catalog={state.catalog}
      dateConfig={state.dateConfig}
      editMode={state.adminModeRequested}
      initialSettingsOpen={route.initialSettingsOpen}
    />
  );
}
