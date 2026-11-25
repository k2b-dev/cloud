import V2WorkspaceNavigation from "@k2b/cloud/ssr/V2WorkspaceNavigation";
import { type Action, Bar, Menu, type MenuEntry, Nav, type NavGroup, Tabs, Workspace } from "@k2b/ui/v2";
import type { JSX } from "solid-js";
import type { PulseBase } from "../../contracts";
import { usePulseMessages } from "../use-messages";
import { useScreenMessages } from "./messages";

export type BaseView = "sources" | "sql" | "queries";

export const baseHref = (baseId: string, view: BaseView | "settings" = "sources") =>
  `/app/pulse/${encodeURIComponent(baseId)}${view === "sources" ? "" : `/${view}`}`;

/** v1 icon classes ("ti ti-database") to v2 Tabler names ("database"). */
export const iconName = (classes: string) => classes.replace(/^ti\s+/, "").replace(/^ti-/, "") || "activity-heartbeat";

type Props = {
  bases: PulseBase[];
  baseId: string;
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
  const groups = (): NavGroup[] => [
    { items: [{ label: words().allBases, icon: "layout-grid", href: "/app/pulse" }] },
    {
      label: words().bases,
      items: props.bases.map((base) => ({
        label: base.name,
        icon: iconName(base.icon),
        href: baseHref(base.id),
        current: base.id === props.baseId,
        dot: base.store.state === "failed" ? ("bad" as const) : undefined,
      })),
    },
  ];
  const name = () => props.bases.find((base) => base.id === props.baseId)?.name ?? t().appName;
  return (
    <>
      <V2WorkspaceNavigation label={t().appName} groups={groups()} />
      <Workspace
        sidebar={<Nav title={t().appName} icon="activity-heartbeat" groups={groups()} />}
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
                    { label: t().settingsFor({ title: name() }), icon: "settings", href: baseHref(props.baseId, "settings") },
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
