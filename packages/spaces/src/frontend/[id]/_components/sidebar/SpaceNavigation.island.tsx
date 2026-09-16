import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { createEffect, onCleanup } from "solid-js";
import { createSpaceCommands } from "../../../space-commands";
import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import type { DateContext } from "@k2b/stdlib";
import { spaceCommandMessages } from "../../../../commands";
import { createNavigation, useLocale } from "@k2b/ui";
import { useSpaceMessages } from "../../messages";
import { createSpaceSearch } from "../search/SearchButton";
import { createIcalCopy } from "./CopyICalButton";
import { createItemController } from "./CreateItemButton";
import { createSpaceSettings } from "./SpaceSettingsButton";
import type { SpaceContext } from "./types";
import { createSpaceViews } from "./ViewLinks";

export default function SpaceNavigation(props: { ctx: SpaceContext; baseUrl: string; dateConfig?: DateContext }) {
  const t = useSpaceMessages();
  const locale = useLocale();
  createSpaceCommands({ current: () => (props.ctx.canWrite ? props.ctx.space : undefined), dateConfig: props.dateConfig });
  const create = createItemController({
    get spaceId() {
      return props.ctx.space.id;
    },
    get columns() {
      return props.ctx.columns;
    },
    get tags() {
      return props.ctx.tags;
    },
    get dateConfig() {
      return props.dateConfig;
    },
    get defaultType() {
      return props.ctx.currentView === "calendar" ? "event" : "task";
    },
  });
  createEffect(() => {
    if (!props.ctx.canWrite) return;
    for (const type of ["task", "event"] as const)
      onCleanup(
        registerContextAwareCommand({
          id: `spaces.${type}.compose`,
          title: type === "task" ? t.newTask : t.newEvent,
          description: spaceCommandMessages.resolve([locale()]).t.createDescription({ name: props.ctx.space.name }),
          icon: type === "task" ? "ti ti-checkbox" : "ti ti-calendar-event",
          ...(type === (props.ctx.currentView === "calendar" ? "event" : "task") ? { shortcut: "mod+alt+n" } : {}),
          action: { command: `spaces.${type}.compose`, input: { spaceId: props.ctx.space.id } },
        }),
      );
  });
  const search = createSpaceSearch({
    get spaceId() {
      return props.ctx.space.id;
    },
    get spaceName() {
      return props.ctx.space.name;
    },
  });
  const settings = createSpaceSettings({
    get spaceId() {
      return props.ctx.space.id;
    },
    get baseUrl() {
      return props.baseUrl;
    },
  });
  const calendar = createIcalCopy({
    get icalToken() {
      return props.ctx.space.icalToken;
    },
  });
  const views = createSpaceViews({
    get spaceId() {
      return props.ctx.space.id;
    },
    get query() {
      return props.ctx.query;
    },
    get currentView() {
      return props.ctx.currentView;
    },
  });
  const navigation = createNavigation({
    items: () => [
      ...(props.ctx.canWrite
        ? [{ id: "create", label: create.label(), icon: "ti ti-plus", action: "create", disabled: create.pending() }]
        : []),
      { id: "search", label: t.searchItems, icon: "ti ti-search", action: "search" },
      { id: "all", label: t.allSpaces, icon: "ti ti-layout-grid", href: "/app/spaces" },
      ...views.views.map((view) => ({
        id: view.id,
        label: view.label,
        icon: `ti ${view.icon}`,
        href: views.href(view.id),
        active: props.ctx.currentView === view.id,
      })),
      ...(props.ctx.space.icalToken
        ? [{ id: "ical", label: calendar.copied() ? t.copied : t.copyIcalUrl, icon: "ti ti-calendar-share", action: "ical" }]
        : []),
      { id: "settings", label: t.spaceSettings, icon: "ti ti-settings", action: "settings", disabled: settings.open() },
    ],
    onAction: async (action) => {
      if (action === "create") await create.createItem();
      if (action === "search") await search();
      if (action === "ical") await calendar.handleCopy();
      if (action === "settings") await settings.openDialog();
    },
  });
  return <WorkspaceNavigationProvider navigation={navigation} label={props.ctx.space.name} />;
}
