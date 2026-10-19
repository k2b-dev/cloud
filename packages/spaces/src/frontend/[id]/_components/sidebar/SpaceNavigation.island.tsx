import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import type { DateContext } from "@k2b/stdlib";
import { createNavigation, useLocale } from "@k2b/ui";
import { createEffect, onCleanup, onMount } from "solid-js";
import { spaceCommandMessages } from "../../../../commands";
import { overviewMessages } from "../../../overview-messages";
import { createSpaceCommands } from "../../../space-commands";
import { useSpaceMessages } from "../../messages";
import { createItemController } from "./CreateItemButton";
import { interceptSpacePrimaryClick, syncSpacePrimaryHref } from "./space-primary";
import {
  createNewSpace,
  createPinnedSpaces,
  createSpacesNavigationItems,
  listenSpacesNavigationHints,
  type SpacesSidebarData,
} from "./spaces-navigation";
import type { SpaceContext } from "./types";

export default function SpaceNavigation(props: { ctx: SpaceContext; sidebar: SpacesSidebarData; dateConfig?: DateContext }) {
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
    get templates() {
      return props.ctx.space.templates;
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
  onMount(() => {
    onCleanup(listenSpacesNavigationHints(document, props.sidebar.spaces));
    if (!props.ctx.canWrite) return;
    onCleanup(syncSpacePrimaryHref(document, props.ctx));
    onCleanup(interceptSpacePrimaryClick(document, () => void create.createItem()));
  });
  const { t: overview } = overviewMessages.resolve([locale()]);
  const createSpace = createNewSpace(overview);
  const [pinned] = createPinnedSpaces(props.sidebar.pinnedSpaceIds);
  const navigation = createNavigation({
    items: () =>
      createSpacesNavigationItems({
        ...props.sidebar,
        pinnedSpaceIds: pinned(),
        current: { kind: "space", id: props.ctx.space.id },
        canCreate: Boolean(props.ctx.userId),
        myWorkLabel: overview.myWork,
        newSpaceLabel: overview.newSpace,
      }),
    onAction: async (action) => {
      if (action === "new-space") await createSpace();
    },
  });
  return <WorkspaceNavigationProvider navigation={navigation} label={props.ctx.space.name} />;
}
