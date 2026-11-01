import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import type { DateContext } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { createEffect, onCleanup } from "solid-js";
import type { SpaceColumn, SpaceItemTemplate, SpaceTag } from "@/contracts";
import { spaceCommandMessages } from "../../../../commands";
import { useSpaceMessages } from "../../messages";
import { CreateMenu, createItemController } from "../sidebar/CreateItemButton";

/**
 * The menu behind the head's "+" and the phone's round button. The head renders the button as a link to the compose
 * command, so a reload, a new tab, or a page before hydration opens the form; a plain click or key opens this menu,
 * and a phone shows it as a sheet. N creates a blank task without the menu; the calendar has its own N for an event.
 */
export default function SpaceCreateMenu(props: {
  spaceId: string;
  spaceName: string;
  columns: SpaceColumn[];
  tags: SpaceTag[];
  templates: SpaceItemTemplate[];
  calendar: boolean;
  dateConfig?: DateContext;
}) {
  const t = useSpaceMessages();
  const locale = useLocale();
  const create = createItemController({
    get spaceId() {
      return props.spaceId;
    },
    get columns() {
      return props.columns;
    },
    get tags() {
      return props.tags;
    },
    get templates() {
      return props.templates;
    },
    get dateConfig() {
      return props.dateConfig;
    },
    get defaultType() {
      return props.calendar ? "event" : "task";
    },
  });
  createEffect(() => {
    if (props.calendar) return;
    onCleanup(
      registerContextAwareCommand({
        id: "spaces.task.blank",
        title: t.createMenuBlankTask,
        description: spaceCommandMessages.resolve([locale()]).t.createDescription({ name: props.spaceName }),
        icon: "ti ti-plus",
        shortcut: "n",
        action: () => create.createItem({ type: "task" }),
      }),
    );
  });
  return (
    <CreateMenu
      kind={props.calendar ? "calendar" : "task"}
      templates={props.templates}
      choose={create.choose}
      shortcuts
      align="end"
      disabled={create.pending()}
      attach={() => document.querySelector<HTMLElement>("a[data-workspace-primary]")}
    />
  );
}
