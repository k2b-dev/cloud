import V2WorkspaceNavigation from "@k2b/cloud/ssr/V2WorkspaceNavigation";
import { type Action, Bar, Menu, type MenuEntry, Nav, Tabs, Workspace } from "@k2b/ui/v2";
import type { JSX } from "solid-js";
import type { PulseNav } from "../../contracts";
import { usePulseMessages } from "../use-messages";
import { baseHref, createBaseNav } from "./base-nav";
import { useScreenMessages } from "./messages";
import { iconName } from "./store-state";

export { baseHref, iconName };

export type BaseView = "sources" | "sql" | "queries";

type Props = {
  /** The sidebar's bases, as the page read them. */
  nav: PulseNav;
  baseId: string;
  /** The open base's name, for its settings entry. */
  baseName: string;
  view: BaseView;
  sourceCount: number;
  /** What the head shows before the "…": a search, or the main action of the view. */
  end?: JSX.Element;
  /** More deeds on the base behind the head's "…", after Settings. */
  more?: MenuEntry[];
  primary?: Action;
  /** A detail opens beside the columns (the open source). */
  detail?: true | number;
  detailEmpty?: { icon: string; text: string };
  children: JSX.Element;
};

/**
 * The frame of one base: the bases are the places in the sidebar, the base's views (sources, SQL, saved queries)
 * are tabs in the head, and the rare deeds on the base (settings, Gustav) wait behind "…".
 */
export default function BaseFrame(props: Props) {
  const t = usePulseMessages();
  const words = useScreenMessages();
  const nav = createBaseNav(props.nav, () => props.baseId);
  return (
    <>
      <V2WorkspaceNavigation label={t().appName} groups={nav.groups()} />
      {nav.dialog()}
      <Workspace
        sidebar={<Nav title={t().appName} icon="activity-heartbeat" groups={nav.groups()} />}
        sidebarLabel={words().bases}
        detail={props.detail}
        detailEmpty={props.detailEmpty}
        primary={props.primary}
        head={
          <Bar
            start={
              <Tabs
                label={words().views}
                items={[
                  {
                    label: words().sources,
                    icon: "database",
                    count: props.sourceCount,
                    href: baseHref(props.baseId),
                    current: props.view === "sources",
                  },
                  { label: words().sql, icon: "code", href: baseHref(props.baseId, "sql"), current: props.view === "sql" },
                  { label: words().queries, icon: "bookmark", href: baseHref(props.baseId, "queries"), current: props.view === "queries" },
                ]}
              />
            }
            end={
              <>
                {props.end}
                <Menu
                  label={words().moreBaseActions}
                  items={[
                    { label: t().settingsFor({ title: props.baseName }), icon: "settings", href: baseHref(props.baseId, "settings") },
                    ...(props.more ?? []),
                  ]}
                />
              </>
            }
          />
        }
      >
        {props.children}
      </Workspace>
    </>
  );
}
