import { AppWorkspace } from "@k2b/ui";
import type { HelpDocumentManifest } from "@valentinkolb/cloud/shared";
import { Layout } from "@valentinkolb/cloud/ssr/islands";
import { navigate } from "@k2b/ssr/nav";
import { createMemo, createSignal, For, Show } from "solid-js";
import type {
  PulseCurrentState,
  PulseMetricSeries,
  PulseMetricSummary,
  PulseRecordedEvent,
  PulseSignalField,
  PulseSource,
} from "../contracts";
import { PulseQueryReferenceInventory } from "./PulseQueryReferenceInventory";
import { defaultReferenceTab, isAvailableReferenceTab, type ReferenceTab, referenceTabs } from "./query-reference-tabs";
import { usePulseMessages } from "./use-messages";

type Props = {
  baseName: string;
  includeDashboardDsl: boolean;
  initialTab?: ReferenceTab;
  metrics: PulseMetricSummary[];
  events: PulseRecordedEvent[];
  states: PulseCurrentState[];
  sources: PulseSource[];
  series: PulseMetricSeries[];
  fields: PulseSignalField[];
  documents: readonly HelpDocumentManifest[];
};

const readInitialTab = (includeDashboardDsl: boolean, initialTab?: ReferenceTab): ReferenceTab => {
  if (isAvailableReferenceTab(initialTab, includeDashboardDsl)) return initialTab;
  if (typeof window === "undefined") return defaultReferenceTab(includeDashboardDsl);
  const value = new URL(window.location.href).searchParams.get("tab");
  return isAvailableReferenceTab(value, includeDashboardDsl) ? value : defaultReferenceTab(includeDashboardDsl);
};

const writeTabParam = (tab: ReferenceTab) => {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("tab", tab);
  navigate(`${url.pathname}${url.search}`, { replace: true, scroll: "preserve", viewTransition: false });
};

export default function PulseQueryReferenceWindow(props: Props) {
  const t = usePulseMessages();
  const [activeTab, setActiveTab] = createSignal<ReferenceTab>(readInitialTab(props.includeDashboardDsl, props.initialTab));
  const activeHelpTopic = createMemo(() => {
    if (activeTab() === "overview") return "pulse-reference";
    if (activeTab() === "query") return "pulse-query-language";
    if (activeTab() === "dashboard") return "pulse-dashboard-dsl";
    return null;
  });

  const switchTab = (tab: ReferenceTab) => {
    setActiveTab(tab);
    writeTabParam(tab);
  };

  const renderReferenceNav = () => (
    <AppWorkspace.SidebarSection title={t().reference}>
      <For
        each={referenceTabs(props.includeDashboardDsl, {
          overview: t().overview,
          query: t().queryDsl,
          dashboard: t().dashboardDsl,
          inventory: t().inventory,
        })}
      >
        {(tab) => (
          <AppWorkspace.SidebarItem icon={tab.icon} active={activeTab() === tab.value} onClick={() => switchTab(tab.value)}>
            {tab.label}
          </AppWorkspace.SidebarItem>
        )}
      </For>
    </AppWorkspace.SidebarSection>
  );

  const renderInventory = () => (
    <PulseQueryReferenceInventory
      metrics={props.metrics}
      events={props.events}
      states={props.states}
      sources={props.sources}
      series={props.series}
      fields={props.fields}
    />
  );

  return (
    <AppWorkspace class="h-screen">
      <AppWorkspace.Sidebar>
        <AppWorkspace.SidebarMobileTrigger label={t().pulseReference} />
        <AppWorkspace.SidebarMobile>
          <AppWorkspace.SidebarMobileBody scrollPreserveKey="pulse-reference-mobile">{renderReferenceNav()}</AppWorkspace.SidebarMobileBody>
        </AppWorkspace.SidebarMobile>
        <AppWorkspace.SidebarDesktop>
          <AppWorkspace.SidebarBody scrollPreserveKey="pulse-reference-sidebar">{renderReferenceNav()}</AppWorkspace.SidebarBody>
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>

      <AppWorkspace.Content>
        <AppWorkspace.Main class="overflow-y-auto">
          <Show
            when={activeHelpTopic()}
            fallback={<div class="mx-auto flex w-full max-w-7xl flex-col gap-5 p-[var(--ui-space-shell)]">{renderInventory()}</div>}
          >
            {(topic) => (
              <Layout.HelpPage
                documents={props.documents.filter((document) => document.id === topic())}
                initialTopic={topic()}
                includeShortcuts={false}
                embedded
              />
            )}
          </Show>
        </AppWorkspace.Main>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}
