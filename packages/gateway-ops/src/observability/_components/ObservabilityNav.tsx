import type { AdminAreaGroup } from "@k2b/cloud/ssr";
import { useLocale } from "@k2b/ui";
import { Nav, Tabs } from "@k2b/ui/v2";
import { natsMessages } from "../nats/messages";
import { areaMessages } from "./area-messages";

/** What a v2 screen of the area needs for its sidebar; the page builds it with `observabilityGroups`. */
export type ObservabilityAreaNav = { title: string; groups: AdminAreaGroup[]; markLabel: string };

/** v1 icon classes ("ti ti-file-text") to v2 Tabler names ("file-text"). */
export const v2Icon = (classes: string) => classes.replace(/^ti\s+(ti-)?/, "").replace(/^ti-/, "");

/** The area's sections as the v2 sidebar of a screen, with the open one marked and attention as dots. */
export function ObservabilityNav(props: { area: ObservabilityAreaNav; current: string }) {
  return (
    <Nav
      title={props.area.title}
      icon="activity"
      groups={props.area.groups.map((group) => ({
        label: group.title,
        items: group.items.map((item) => ({
          label: item.label,
          icon: v2Icon(item.icon),
          href: item.href,
          current: item.id === props.current,
          dot: item.mark === "error" ? ("bad" as const) : item.mark === "warning" ? ("warn" as const) : undefined,
        })),
      }))}
    />
  );
}

export const NATS_SYNC_HREF = {
  nats: "/admin/observability/nats",
  sync: "/admin/observability/nats/sync",
  access: "/admin/observability/nats/access",
} as const;

/** NATS diagnostics, Sync work and diagnostics access share one section: three views in the head. */
export function NatsSyncViewTabs(props: { current: keyof typeof NATS_SYNC_HREF }) {
  const locale = useLocale();
  const area = areaMessages.resolve([locale()]).t;
  const nats = natsMessages.resolve([locale()]).t;
  return (
    <Tabs
      label={area.nats}
      items={[
        { label: "NATS", icon: "topology-star-3", href: NATS_SYNC_HREF.nats, current: props.current === "nats" },
        { label: "Sync", icon: "refresh", href: NATS_SYNC_HREF.sync, current: props.current === "sync" },
        { label: nats.access, icon: "key", href: NATS_SYNC_HREF.access, current: props.current === "access" },
      ]}
    />
  );
}
