import { Widget, WidgetHero, WidgetList, WidgetPills, WidgetStat, WidgetStatus } from "@k2b/ui";
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
    description="Widgets compose server-rendered presentation blocks. Header, row, and pill links remain native and independently focusable."
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

const demos: DemoSection = {
  composition: () => (
    <DemoGrid columns="one">
      <WidgetCompositionDemo />
    </DemoGrid>
  ),
};

export default demos;
