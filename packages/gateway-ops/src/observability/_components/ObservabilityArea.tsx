import { AdminLayout, getDisplayRuntimeContext } from "@k2b/cloud/ssr";
import SettingsSaveStatus from "@k2b/cloud/ssr/SettingsSaveStatus.island";
import { AppWorkspace, StatusBadge, ViewTabs } from "@k2b/ui";
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

type ContributedLink = { href: string; label: string; icon: string; app: string };

/** Links other apps the person may use add to the area with `adminNav[].section: "observability"`. Gateway Ops owns the sections above. */
const contributedLinks = (c: AreaProps["c"]): ContributedLink[] =>
  getDisplayRuntimeContext(c).apps.flatMap((app) =>
    app.id === "gateway-ops"
      ? []
      : (app.adminNav ?? [])
          .filter((group) => group.section === "observability")
          .flatMap((group) =>
            group.links
              .filter((link) => link.href.startsWith("/admin/"))
              .map((link) => ({ href: link.href, label: link.label, icon: link.icon.replace(/^ti\s+/, ""), app: app.name })),
          ),
  );

function AreaColumn(props: { t: AreaMessages; section: ObservabilitySection; attention: Attention; contributed: ContributedLink[] }) {
  return (
    <>
      {GROUPS.map((group) => (
        <AppWorkspace.SidebarSection title={group.title ? (props.t[group.title] as string) : undefined}>
          {group.sections.map((section) => {
            const mark = props.attention[section];
            return (
              <AppWorkspace.SidebarItem
                href={OBSERVABILITY_SECTION_HREF[section]}
                navigation="document"
                active={props.section === section}
                icon={SECTION_ICON[section]}
                meta={
                  mark ? (
                    <span title={props.t.needsAttention}>
                      <StatusBadge tone={mark} variant="dot" label="" />
                      <span class="sr-only">{props.t.needsAttention}</span>
                    </span>
                  ) : undefined
                }
              >
                {props.t[section]}
              </AppWorkspace.SidebarItem>
            );
          })}
        </AppWorkspace.SidebarSection>
      ))}
      {props.contributed.length > 0 ? (
        <AppWorkspace.SidebarSection title={props.t.fromApps}>
          {props.contributed.map((link) => (
            <AppWorkspace.SidebarItem href={link.href} navigation="document" icon={`ti ${link.icon}`} description={link.app}>
              {link.label}
            </AppWorkspace.SidebarItem>
          ))}
        </AppWorkspace.SidebarSection>
      ) : null}
    </>
  );
}

type AreaProps = {
  c: Parameters<typeof AdminLayout>[0]["c"];
  locale: string;
  /** The open section. */
  section: ObservabilitySection;
  attention: Attention;
  /** Id of the deepest open level: "section", or a deeper pane id the page adds. */
  level?: string;
  /** The section's panes, starting with one whose id is "section". */
  children: JSX.Element;
};

/** The save status in a level head. A phone has no room there; it shows the status at the bottom of the level instead. */
export const SaveStatusHead = () => (
  <div class="hidden md:block">
    <SettingsSaveStatus />
  </div>
);
export const SaveStatusFoot = () => (
  <div class="sticky bottom-0 flex justify-end bg-(--k2b-surface) px-4 py-3 md:hidden">
    <SettingsSaveStatus />
  </div>
);

/** A section that fills the width beside the first column, such as a dashboard. */
export function ObservabilityPane(props: {
  label: string;
  description?: JSX.Element;
  /** Before the title, such as the step back from one job source to all sources. */
  lead?: JSX.Element;
  actions?: JSX.Element;
  /** A form that saves with a button: its status, Discard and Save sit in the head, on a phone at the bottom. */
  saveStatus?: boolean;
  /** With a detail level beside it: the address of this level without the selection. */
  href?: string;
  /** A wide list declares the room it needs; the first column then gives way before the list is squeezed. */
  minSize?: number;
  children: JSX.Element;
}) {
  return (
    <AppWorkspace.MainPane
      id="section"
      label={props.label}
      description={props.description}
      lead={props.lead}
      actions={props.saveStatus ? <SaveStatusHead /> : props.actions}
      href={props.href}
      minSize={props.minSize}
      defaultSize={props.minSize}
    >
      <div class="app-rows px-[var(--ui-space-shell)] pb-[var(--ui-space-shell)]">{props.children}</div>
      {props.saveStatus ? <SaveStatusFoot /> : null}
    </AppWorkspace.MainPane>
  );
}

/**
 * The Observability area: the admin layout with the area's sections as the first column and the open section beside
 * it. Pages own their panes; a list adds a `minSize` so a wide list pushes the first column aside.
 */
export function ObservabilityArea(props: AreaProps) {
  const t = areaText(props.locale);
  return (
    <AdminLayout c={props.c} title={t[props.section]} ownMain>
      <AppWorkspace.Main level={props.level ?? "section"}>
        <AppWorkspace.MainPane
          id="area"
          label={t.area}
          href={OBSERVABILITY_SECTION_HREF.home}
          defaultSize={248}
          minSize={232}
          maxSize={320}
        >
          <nav aria-label={t.sections}>
            <AreaColumn t={t} section={props.section} attention={props.attention} contributed={contributedLinks(props.c)} />
          </nav>
        </AppWorkspace.MainPane>
        {props.children}
      </AppWorkspace.Main>
    </AdminLayout>
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
