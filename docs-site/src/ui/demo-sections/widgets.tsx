import {
  Chart,
  DashboardGrid,
  DashboardPanel,
  DashboardSection,
  StatCell,
  StatGrid,
  Widget,
  WidgetHero,
  WidgetList,
  WidgetPills,
  WidgetStat,
  WidgetStatus,
} from "@k2b/ui";
import { For } from "solid-js";
import { DemoCard } from "../DemoCard";
import { DemoGrid, type DemoSection } from "./types";

const WidgetCompositionDemo = () => (
  <DemoCard
    id="widget-composition"
    chip={[
      { kind: "component", name: "Widget", from: "@k2b/ui" },
      { kind: "component", name: "WidgetHero", from: "@k2b/ui" },
      { kind: "component", name: "WidgetList", from: "@k2b/ui" },
      { kind: "component", name: "WidgetPills", from: "@k2b/ui" },
      { kind: "component", name: "WidgetStat", from: "@k2b/ui" },
      { kind: "component", name: "WidgetStatus", from: "@k2b/ui" },
    ]}
    description="Widget header icons sit in soft chips of the host accent. Status icons keep their status colors. Header, row, and pill links remain native and independently focusable."
    code={`import {
  Widget, WidgetHero, WidgetList,
  WidgetPills, WidgetStat, WidgetStatus,
} from "@k2b/ui";

<Widget title="Workspace" meta="last 24h" icon="ti ti-layout-dashboard" href="/workspace">
  <WidgetStat value={12} label="Open tasks" sub="3 due today" accent={{ tone: "amber", icon: "ti ti-clock", text: "today" }} />
  <WidgetList grow items={[{ label: "Review release notes", sub: "Platform", href: "/tasks/12" }]} />
  <WidgetStatus tone="success" title="All services operational" />
  <WidgetPills pills={[{ label: "Teams", value: 4, href: "/teams" }]} />
</Widget>
<Widget title="Release" size="compact" icon="ti ti-rocket">
  <WidgetHero title="Ready to ship" subtitle="All required checks passed" icon="ti ti-circle-check" tone="emerald" />
</Widget>
<Widget title="Status vocabulary" size="content" icon="ti ti-heart-rate-monitor">
  <WidgetStatus tone="success" title="Operational" />
  <WidgetStatus tone="warning" title="Delayed" message="Samples are eight minutes old." />
  <WidgetStatus tone="danger" title="Unavailable" message="The source could not be reached." />
  <WidgetStatus tone="info" title="Maintenance scheduled" />
</Widget>`}
  >
    <div class="ui-widget-demo">
      <Widget title="Workspace" meta="last 24h" icon="ti ti-layout-dashboard" href="#widget-composition">
        <WidgetStat value={12} label="Open tasks" sub="3 due today" accent={{ tone: "amber", icon: "ti ti-clock", text: "today" }} />
        <WidgetList
          grow
          items={[
            {
              label: "Review release notes with the platform maintainers",
              sub: "Platform",
              meta: "today",
              icon: "ti ti-notes",
              iconTone: "blue",
              href: "#widget-composition",
            },
            { label: "Prepare demo", sub: "Design systems", meta: "Fri", icon: "ti ti-presentation", iconTone: "zinc" },
          ]}
        />
        <WidgetStatus tone="success" title="All services operational" />
        <WidgetPills
          pills={[
            { label: "Teams", value: 4, href: "#widget-composition" },
            { label: "Projects", value: 9, tone: "blue" },
          ]}
        />
      </Widget>
      <Widget title="Release" size="compact" icon="ti ti-rocket">
        <WidgetHero title="Ready to ship" subtitle="All required checks passed" icon="ti ti-circle-check" tone="emerald" />
      </Widget>
      <Widget title="Portable content" size="compact" icon="ti ti-components">
        <WidgetHero title="Bring any content" subtitle="Widget supplies the shared frame." icon="ti ti-components" tone="blue" />
      </Widget>
      <Widget title="Status vocabulary" size="content" icon="ti ti-heart-rate-monitor">
        <WidgetStatus tone="success" title="Operational" />
        <WidgetStatus tone="warning" title="Delayed" message="Samples are eight minutes old." />
        <WidgetStatus tone="danger" title="Unavailable" message="The source could not be reached." />
        <WidgetStatus tone="info" title="Maintenance scheduled" />
      </Widget>
    </div>
  </DemoCard>
);

// Invented newsletter figures; the same on the server and in every browser.
const demoMonths = ["May", "Jun", "Jul", "Aug", "Sep", "Oct"];
const demoPanels = [
  { id: "opens", title: "Opens per month", meta: "Share of recipients", width: "twoThirds", values: [44, 45, 47, 48, 46, 49] },
  { id: "revenue", title: "Newsletter revenue", meta: "October against September", width: "third", values: [31, 43, 39, 46, 23, 28] },
  { id: "steps", title: "From send to purchase", meta: "Weekly letter 44", width: "half", values: [100, 49, 20, 6, 3, 1] },
  { id: "pages", title: "Pages after the click", meta: "October", width: "half", values: [38, 22, 14, 11, 9, 6] },
] as const;

const DashboardGridDemo = () => (
  <DemoCard
    id="dashboard-grid"
    chip={[
      { kind: "component", name: "DashboardGrid", from: "@k2b/ui" },
      { kind: "component", name: "DashboardSection", from: "@k2b/ui" },
      { kind: "component", name: "DashboardPanel", from: "@k2b/ui" },
    ]}
    description="Six columns measured on the dashboard itself: two thirds take four, a third two, a half three. At 1000 px a third takes half the row and two thirds all of it; at 600 px every panel takes the row. A StatGrid is the section's row of key figures. Every panel is one light frame."
    code={`<DashboardGrid>
  <DashboardSection title="Impact" icon="ti ti-chart-dots" description="Recipients · invented figures">
    <StatGrid columns={4}>
      <StatCell label="Subscribers" value="48,210" />
      …
    </StatGrid>
    <DashboardPanel width="twoThirds" aria-label="Opens per month">…</DashboardPanel>
    <DashboardPanel width="third" aria-label="Newsletter revenue">…</DashboardPanel>
  </DashboardSection>
  <DashboardSection title="After the click" icon="ti ti-route">
    <DashboardPanel width="half">…</DashboardPanel>
    <DashboardPanel width="half">…</DashboardPanel>
  </DashboardSection>
</DashboardGrid>`}
  >
    <DashboardGrid>
      <For each={[demoPanels.slice(0, 2), demoPanels.slice(2)]}>
        {(panels, index) => (
          <DashboardSection
            title={index() === 0 ? "Impact" : "After the click"}
            icon={index() === 0 ? "ti ti-chart-dots" : "ti ti-route"}
            description={index() === 0 ? "Recipients · invented figures" : undefined}
          >
            {index() === 0 && (
              <StatGrid columns={4}>
                <StatCell label="Subscribers" value="48,210" sub="Last month 44,560" />
                <StatCell label="Open rate" value="49.2 %" sub="Last month 46.1 %" />
                <StatCell label="Click rate" value="19.8 %" sub="Last month 20.4 %" />
                <StatCell label="Unsubscribes" value="182" sub="Last month 208" />
              </StatGrid>
            )}
            <For each={panels}>
              {(panel) => (
                <DashboardPanel width={panel.width} aria-labelledby={`dashboard-grid-${panel.id}`}>
                  <h3 id={`dashboard-grid-${panel.id}`} class="ui-dashboard-demo__title">
                    {panel.title}
                  </h3>
                  <p class="ui-dashboard-demo__meta">{panel.meta}</p>
                  <Chart
                    kind="bar"
                    style={{ height: "160px" }}
                    data={panel.values.map((value, position) => ({ label: demoMonths[position]!, value }))}
                  />
                </DashboardPanel>
              )}
            </For>
          </DashboardSection>
        )}
      </For>
    </DashboardGrid>
  </DemoCard>
);

const demos: DemoSection = {
  composition: () => (
    <DemoGrid columns="one">
      <WidgetCompositionDemo />
      <DashboardGridDemo />
    </DemoGrid>
  ),
};

export default demos;
