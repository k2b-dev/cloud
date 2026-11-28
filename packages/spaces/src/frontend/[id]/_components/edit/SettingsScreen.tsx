import { liveConnection } from "@k2b/cloud/browser/live";
import { reloadOnce } from "@k2b/cloud/browser/reload";
import { listenPopState, navigate } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { query } from "@k2b/stdlib/solid";
import { Bar, confirm, Notice, Pane, Path, Tabs, useToast, Workspace } from "@k2b/ui/v2";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { SpaceLiveEventSchema } from "@/live-events";
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
 * saving on its own. Leaving an area with unsaved changes asks first, also by Back and forward. A change of the Space
 * elsewhere refreshes the settings in place; while the person has unsaved changes, it says so and offers the reload
 * instead, so nothing replaces what they are typing.
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
  const toast = useToast();
  /** The Space changed elsewhere while the person had unsaved changes; saving or discarding them clears it. */
  const [changedElsewhere, setChangedElsewhere] = createSignal(false);
  createEffect(() => {
    if (!dirty()) setChangedElsewhere(false);
  });
  const discardQuestion = () => confirm({ title: m.discardChanges, description: m.discardChangesConfirm, confirm: m.discard });
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
  /** One question at a time: a second Back or tab click while it is open asks nothing more (null). */
  let asking = false;
  const askDiscard = async (): Promise<boolean | null> => {
    if (asking) return null;
    asking = true;
    try {
      return await discardQuestion();
    } finally {
      asking = false;
    }
  };
  /** Another area opens in place; unsaved changes are discarded only after the person agrees. */
  const open = async (id: SettingsTab) => {
    if (id === tab()) return;
    if (dirty() && (await askDiscard()) !== true) return;
    setDirty(false);
    setTab(id);
    navigate(tabHref(id), { scroll: "preserve" });
  };
  onMount(() =>
    onCleanup(
      listenPopState(async ({ url }) => {
        const next = SETTINGS_TABS.find((entry) => entry === url.searchParams.get("tab")) ?? tabs()[0];
        if (!next || next === tab()) return;
        // Back and forward leave an area as a tab does: unsaved changes go only after the person agrees, and
        // otherwise the address returns to the area that stays open.
        if (dirty()) {
          const agreed = await askDiscard();
          if (agreed === null) return;
          if (!agreed) {
            navigate(tabHref(tab()), { scroll: "preserve" });
            return;
          }
        }
        setDirty(false);
        // A further Back while the question was open moved the address on: the area it names now opens.
        const now = SETTINGS_TABS.find((entry) => entry === new URL(window.location.href).searchParams.get("tab")) ?? tabs()[0];
        setTab(now ?? next);
      }),
    ),
  );

  // The Space's name, colour, statuses, tags, templates, wormholes and access change on other pages and devices too.
  onMount(() => {
    let stopped = false;
    const changed = () => {
      if (stopped) return;
      if (dirty()) setChangedElsewhere(true);
      else void refresh().catch(() => setChangedElsewhere(true));
    };
    const subscription = liveConnection("/api/spaces/live").subscribe(
      "space",
      { space: props.settings.space.id },
      {
        cursor: null,
        parse: (data) => SpaceLiveEventSchema.parse(data),
        apply: async (events) => {
          // Items are not settings; everything else of the Space is.
          if (events.some((event) => !event.data.type.startsWith("item."))) changed();
        },
        resync: async () => changed(),
        // Access to the Space changed for this person: the page as it is may no longer be theirs to see.
        revoked: () => {
          if (dirty()) setChangedElsewhere(true);
          else if (!reloadOnce(`spaces:settings:${props.settings.space.id}`)) setChangedElsewhere(true);
        },
        // k2b-ui gap: a v2 toast cannot stay until it is answered; it offers the reload for its five seconds.
        unavailable: () => toast(m.liveUpdatesUnavailable, { status: "bad", retry: () => window.location.reload() }),
      },
    );
    onCleanup(() => {
      stopped = true;
      subscription.close();
    });
  });
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
        <Show when={changedElsewhere()}>
          <Notice tone="warn" primary={{ label: m.reload, icon: "refresh", onClick: () => window.location.reload() }}>
            {m.settingsChangedElsewhere}
          </Notice>
        </Show>
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
