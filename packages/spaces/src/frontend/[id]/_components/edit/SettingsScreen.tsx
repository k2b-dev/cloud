import { listenPopState, navigate } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { query } from "@k2b/stdlib/solid";
import { Bar, confirm, Pane, Path, Tabs, Workspace } from "@k2b/ui/v2";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { SpaceSettingsContext } from "@/settings-context";
import SpacesNav, { useSpacesNav } from "../../../_components/spaces-nav";
import { useSpaceMessages } from "../../messages";
import type { SpacesSidebarData } from "../sidebar/spaces-navigation";
import { ApiKeysSection, PermissionsSection } from "./AccessSection";
import { CalendarSection, DangerZone, DefaultsSection, GeneralSection } from "./BasicSections";
import { GitHubSection } from "./GitHubSection";
import { StatusesSection } from "./StatusesSection";
import { TagsSection } from "./TagsSection";
import { TemplatesSection } from "./TemplatesSection";
import { readErrorMessage } from "./utils";
import { WormholesSection } from "./WormholesSection";

export const SETTINGS_TABS = [
  "general",
  "tags",
  "statuses",
  "templates",
  "defaults",
  "calendar",
  "wormholes",
  "github",
  "access",
  "api-keys",
  "danger",
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export type SettingsScreenProps = {
  sidebar: SpacesSidebarData;
  settings: SpaceSettingsContext;
  tab: SettingsTab;
  /** The address calendar apps use, such as "https://cloud.example.org". */
  baseUrl: string;
  dateConfig?: DateContext;
};

/** Which tabs a person sees: writers shape the Space, everyone sets their own defaults, admins manage the rest. */
export const visibleTabs = (permission: SpaceSettingsContext["permission"]): SettingsTab[] => {
  const canWrite = permission === "write" || permission === "admin";
  const isAdmin = permission === "admin";
  return SETTINGS_TABS.filter((tab) =>
    tab === "defaults" || tab === "calendar"
      ? true
      : tab === "general" || tab === "tags" || tab === "statuses" || tab === "templates"
        ? canWrite
        : isAdmin,
  );
};

/**
 * The settings of a Space on v2, a page of its own: its areas as tabs (the address keeps the open one), each area
 * saving on its own. Leaving an area with unsaved changes asks first.
 */
export default function SettingsScreen(props: SettingsScreenProps) {
  const m = useSpaceMessages();
  const spaceHref = `/app/spaces/${props.settings.space.id}`;
  const nav = useSpacesNav({ ...props.sidebar, current: { kind: "space", id: props.settings.space.id }, canCreate: true });
  const settings = query.create<string, SpaceSettingsContext>({
    source: () => props.settings.space.id,
    initial: { source: props.settings.space.id, data: props.settings },
    load: async (spaceId, context) => {
      const response = await apiClient[":id"]["settings-context"].$get(
        { param: { id: spaceId } },
        { init: { signal: context.abortSignal } },
      );
      if (!response.ok) throw new Error(await readErrorMessage(response, m.loadSpaceSettingsFailed));
      return response.json();
    },
  });
  const current = () => settings.data() ?? props.settings;
  const refresh = async () => {
    await settings.refresh();
  };
  const [tab, setTab] = createSignal<SettingsTab>(props.tab);
  const [dirty, setDirty] = createSignal(false);
  const tabs = () => visibleTabs(current().permission);
  const tabHref = (id: SettingsTab) => `${spaceHref}/settings${id === tabs()[0] ? "" : `?tab=${id}`}`;
  const label = (id: SettingsTab) =>
    ({
      general: m.settingsGeneral,
      tags: m.tags,
      statuses: m.statuses,
      templates: m.templates,
      defaults: m.defaults,
      calendar: m.calendar,
      wormholes: m.wormholes,
      github: "GitHub",
      access: m.access,
      "api-keys": m.apiKeys,
      danger: m.dangerZone,
    })[id];
  const icon = (id: SettingsTab) =>
    ({
      general: "id",
      tags: "tags",
      statuses: "columns-3",
      templates: "template",
      defaults: "layout-sidebar",
      calendar: "calendar-share",
      wormholes: "arrow-bounce",
      github: "brand-github",
      access: "shield",
      "api-keys": "key",
      danger: "alert-triangle",
    })[id];
  /** Another area opens in place; unsaved changes are discarded only after the person agrees. */
  const open = async (id: SettingsTab) => {
    if (id === tab()) return;
    if (dirty() && !(await confirm({ title: m.discardChanges, description: m.discardChangesConfirm, confirm: m.discard }))) return;
    setDirty(false);
    setTab(id);
    navigate(tabHref(id), { scroll: "preserve" });
  };
  onMount(() =>
    onCleanup(
      listenPopState(({ url }) => {
        const next = SETTINGS_TABS.find((entry) => entry === url.searchParams.get("tab")) ?? tabs()[0];
        if (next) setTab(next);
      }),
    ),
  );
  const space = () => current().space;
  const isAdmin = () => current().permission === "admin";

  return (
    <Workspace
      sidebar={<SpacesNav nav={nav} />}
      head={<Bar start={<Path label={m.spaceSettings} items={[{ label: space().name, href: spaceHref }, { label: m.spaceSettings }]} />} />}
    >
      <Pane
        label={m.spaceSettings}
        scrollKey={`spaces-settings-${space().id}`}
        head={
          <Tabs
            label={m.spaceSettings}
            items={tabs().map((id) => ({
              label: label(id),
              icon: icon(id),
              href: tabHref(id),
              current: id === tab(),
              onNavigate: () => void open(id),
            }))}
          />
        }
      >
        <Show when={tab() === "general"}>
          <GeneralSection space={space()} onDirtyChange={setDirty} />
        </Show>
        <Show when={tab() === "tags"}>
          <TagsSection spaceId={space().id} tags={space().tags} onSettingsChange={refresh} onDirtyChange={setDirty} />
        </Show>
        <Show when={tab() === "statuses"}>
          <StatusesSection
            spaceId={space().id}
            columns={space().columns}
            virtualColumns={space().virtualColumns}
            onSettingsChange={refresh}
            onDirtyChange={setDirty}
          />
        </Show>
        <Show when={tab() === "templates"}>
          <TemplatesSection
            spaceId={space().id}
            templates={space().templates}
            tags={space().tags}
            dateConfig={props.dateConfig}
            onSettingsChange={refresh}
            onDirtyChange={setDirty}
          />
        </Show>
        <Show when={tab() === "defaults"}>
          <DefaultsSection spaceId={space().id} initialSettings={current().settings} />
        </Show>
        <Show when={tab() === "calendar"}>
          <CalendarSection spaceId={space().id} icalToken={space().icalToken} baseUrl={props.baseUrl} isAdmin={isAdmin()} />
        </Show>
        <Show when={tab() === "wormholes" && isAdmin()}>
          <WormholesSection spaceId={space().id} initialWormholes={current().wormholes} onDirtyChange={setDirty} />
        </Show>
        <Show when={tab() === "github" && isAdmin()}>
          <GitHubSection spaceId={space().id} configured={current().githubTokenConfigured} onSettingsChange={refresh} />
        </Show>
        <Show when={tab() === "access" && isAdmin()}>
          <PermissionsSection spaceId={space().id} spaceName={space().name} accessEntries={current().accessEntries} />
        </Show>
        <Show when={tab() === "api-keys" && isAdmin()}>
          <ApiKeysSection spaceId={space().id} apiKeys={current().apiKeys} />
        </Show>
        <Show when={tab() === "danger" && isAdmin()}>
          <DangerZone spaceId={space().id} spaceName={space().name} />
        </Show>
      </Pane>
    </Workspace>
  );
}
