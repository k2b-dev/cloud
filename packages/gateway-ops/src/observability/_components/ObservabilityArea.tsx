import {
  AdminArea,
  type AdminAreaGroup,
  type AdminAreaItem,
  AdminAreaPane,
  AdminAreaSaveStatusFoot,
  AdminAreaSaveStatusHead,
  getDisplayRuntimeContext,
} from "@k2b/cloud/ssr";
import { ViewTabs } from "@k2b/ui";
import type { JSX } from "solid-js";
import { buildGatewayHealth, type GatewayHealth } from "../../health";
import { type AreaMessages, areaMessages } from "./area-messages";

/** Every section of the Observability area, in the order of its first column. */
export const OBSERVABILITY_SECTIONS = [
  "home",
  "logs",
  "jobs",
  "workflows",
  "capabilities",
  "telemetry",
  "metrics",
  "deliveries",
  "gateway",
  "postgres",
  "valkey",
  "nats",
  "alerts",
  "healthCheck",
  "retention",
] as const;
export type ObservabilitySection = (typeof OBSERVABILITY_SECTIONS)[number];

export const OBSERVABILITY_SECTION_HREF: Record<ObservabilitySection, string> = {
  home: "/admin/observability",
  logs: "/admin/observability/logs",
  jobs: "/admin/observability/jobs",
  workflows: "/admin/observability/workflows",
  capabilities: "/admin/observability/capabilities",
  telemetry: "/admin/observability/telemetry",
  metrics: "/admin/observability/metrics",
  deliveries: "/admin/observability/deliveries",
  gateway: "/admin/observability/gateway",
  postgres: "/admin/observability/postgres",
  valkey: "/admin/observability/valkey",
  nats: "/admin/observability/nats",
  alerts: "/admin/observability/alerts",
  healthCheck: "/admin/observability/health-check",
  retention: "/admin/observability/retention",
};

const SECTION_ICON: Record<ObservabilitySection, string> = {
  home: "ti ti-dashboard",
  logs: "ti ti-file-text",
  jobs: "ti ti-hourglass",
  workflows: "ti ti-binary-tree",
  capabilities: "ti ti-bolt",
  telemetry: "ti ti-activity",
  metrics: "ti ti-chart-bar",
  deliveries: "ti ti-bell-ringing",
  gateway: "ti ti-route",
  postgres: "ti ti-database",
  valkey: "ti ti-database",
  nats: "ti ti-topology-star-3",
  alerts: "ti ti-webhook",
  healthCheck: "ti ti-heart-rate-monitor",
  retention: "ti ti-archive",
};

const GROUPS: { title?: keyof AreaMessages; sections: ObservabilitySection[] }[] = [
  { sections: ["home"] },
  { title: "groupView", sections: ["logs", "jobs", "workflows", "capabilities", "telemetry", "metrics", "deliveries"] },
  { title: "groupServices", sections: ["gateway", "postgres", "valkey", "nats"] },
  { title: "groupSetup", sections: ["alerts", "healthCheck", "retention"] },
];

export type Attention = Partial<Record<ObservabilitySection, "warning" | "error">>;

// The first column marks sections that need attention on every page of the area. Health reads the registry and the
// NATS inventory, so pages share one result for a short time instead of each asking again.
const HEALTH_TTL_MS = 30_000;
let healthCache: { at: number; value: Promise<GatewayHealth> } | null = null;

/** Gateway health, shared by the pages of the area for 30 s. */
export const readHealth = (): Promise<GatewayHealth> => {
  const now = Date.now();
  if (!healthCache || now - healthCache.at > HEALTH_TTL_MS) {
    const value = buildGatewayHealth();
    healthCache = { at: now, value };
    // A failed read is not kept: the next page asks again.
    value.catch(() => {
      if (healthCache?.value === value) healthCache = null;
    });
  }
  return healthCache.value;
};

const loadAttention = async (): Promise<Attention> => {
  const health = await readHealth();
  const tone = (status: string) => (status === "error" ? ("error" as const) : status === "warn" ? ("warning" as const) : undefined);
  const attention: Attention = {};
  const overall = tone(health.status);
  if (overall) attention.home = overall;
  const sync = health.sync ? tone(health.sync.status) : undefined;
  if (sync) attention.nats = sync;
  return attention;
};

/** Marks for the first column. A failed health read shows no marks: the overview reports what could not be read. */
export const readAttention = (): Promise<Attention> => loadAttention().catch(() => ({}));

export const areaText = (locale: string): AreaMessages => areaMessages.resolve([locale]).t;

/** Links other apps the person may use add to the area with `adminNav[].section: "observability"`. Gateway Ops owns the sections above. */
const contributedLinks = (c: AreaProps["c"]): AdminAreaItem[] =>
  getDisplayRuntimeContext(c).apps.flatMap((app) =>
    app.id === "gateway-ops"
      ? []
      : (app.adminNav ?? [])
          .filter((group) => group.section === "observability")
          .flatMap((group) =>
            group.links
              .filter((link) => link.href.startsWith("/admin/"))
              .map((link) => ({
                id: link.href,
                href: link.href,
                label: link.label,
                icon: `ti ${link.icon.replace(/^ti\s+/, "")}`,
                description: app.name,
              })),
          ),
  );

type AreaProps = {
  c: Parameters<typeof AdminArea>[0]["c"];
  locale: string;
  /** The open section. */
  section: ObservabilitySection;
  attention: Attention;
  /** Id of the deepest open level: "section", or a deeper pane id the page adds. */
  level?: string;
  /** The section's panes, starting with one whose id is "section". */
  children: JSX.Element;
};

export { AdminAreaSaveStatusFoot as SaveStatusFoot, AdminAreaSaveStatusHead as SaveStatusHead, AdminAreaPane as ObservabilityPane };

/**
 * The Observability area on the shared admin area frame: its sections as the first column with attention marks, other
 * apps' links under "From apps", and the open section beside it.
 */
export function ObservabilityArea(props: AreaProps) {
  const t = areaText(props.locale);
  const contributed = contributedLinks(props.c);
  const groups: AdminAreaGroup[] = [
    ...GROUPS.map((group) => ({
      title: group.title ? (t[group.title] as string) : undefined,
      items: group.sections.map((section) => ({
        id: section,
        label: t[section],
        href: OBSERVABILITY_SECTION_HREF[section],
        icon: SECTION_ICON[section],
        mark: props.attention[section],
      })),
    })),
    ...(contributed.length > 0 ? [{ title: t.fromApps, items: contributed }] : []),
  ];
  return (
    <AdminArea
      c={props.c}
      label={t.area}
      sectionsLabel={t.sections}
      href={OBSERVABILITY_SECTION_HREF.home}
      groups={groups}
      current={props.section}
      title={t[props.section]}
      markLabel={t.needsAttention}
      level={props.level}
    >
      {props.children}
    </AdminArea>
  );
}

/** NATS and Sync share one section; these tabs switch between their two views. */
export function NatsSyncTabs(props: { current: "nats" | "sync"; locale: string }) {
  const t = areaText(props.locale);
  return (
    <ViewTabs
      label={t.nats}
      current={props.current}
      items={[
        { id: "nats", label: "NATS", href: OBSERVABILITY_SECTION_HREF.nats },
        { id: "sync", label: "Sync", href: "/admin/observability/nats/sync" },
      ]}
    />
  );
}
