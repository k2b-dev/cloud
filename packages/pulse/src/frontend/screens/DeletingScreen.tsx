import V2WorkspaceNavigation from "@k2b/cloud/ssr/V2WorkspaceNavigation";
import { List, Nav, Pane, Workspace } from "@k2b/ui/v2";
import type { PulseBaseNav, PulseNav } from "../../contracts";
import { usePulseMessages } from "../use-messages";
import { DeletingBase } from "./base-lifecycle";
import { createBaseNav } from "./base-nav";
import { useScreenMessages } from "./messages";

export type DeletingScreenProps = {
  /** The sidebar's bases; the open one stands under "Wird gelöscht". */
  nav: PulseNav;
  /** The base whose deletion runs or failed. */
  base: PulseBaseNav;
};

/**
 * The page of a base in deletion, for its admins: the bases stay in the sidebar, and the base's one row says how far
 * the deletion is, offers "Erneut versuchen" when it stopped and leads back to Pulse once the base is gone.
 */
export default function DeletingScreen(props: DeletingScreenProps) {
  const t = usePulseMessages();
  const words = useScreenMessages();
  const nav = createBaseNav(props.nav, () => props.base.id);
  return (
    <>
      <V2WorkspaceNavigation label={t().appName} groups={nav.groups()} />
      {nav.dialog()}
      <Workspace
        sidebar={<Nav title={t().appName} icon="activity-heartbeat" search={nav.search()} groups={nav.groups()} />}
        sidebarLabel={words().bases}
      >
        {/* the row stands at the top like any detail; the sidebar's open entry already names the base */}
        <Pane label={props.base.name}>
          <List label={words().deletingTitle}>
            <DeletingBase base={props.base} />
          </List>
        </Pane>
      </Workspace>
    </>
  );
}
