import { Dropdown } from "@k2b/ui";
import { Show } from "solid-js";
import { useSpaceMessages } from "../../messages";
import { CreateMenu } from "./CreateMenu";
import { type CreateItemProps, createItemController } from "./create-item";

/** The "+" menu lives in its own module, so a page can offer it without the create dialog. */
export { CreateMenu } from "./CreateMenu";

/** The v1 "+" of a board column (inside its drawing): the create menu on a small button. */
export default function CreateItemButton(props: CreateItemProps) {
  const t = useSpaceMessages();
  const controller = createItemController(props);
  const column = () => props.columns.find((candidate) => candidate.id === props.defaultColumnId);
  const kind = () => controller.defaultType();
  const icon = () => (controller.pending() ? "ti ti-loader-2 animate-spin" : "ti ti-plus");

  return (
    <CreateMenu
      kind={kind()}
      templates={props.templates ?? []}
      choose={controller.choose}
      title={column() ? t.createMenuInColumn({ column: column()!.name }) : undefined}
      disabled={controller.pending()}
      class={props.variant === "inline" ? "w-full" : undefined}
    >
      <Show
        when={props.variant === "inline"}
        fallback={
          <Dropdown.Trigger size="sm">
            <i class={icon()} aria-hidden="true" />
            <span>{controller.label()}</span>
            <i class="ti ti-chevron-down text-xs opacity-70" aria-hidden="true" />
          </Dropdown.Trigger>
        }
      >
        {/* The chevron shows on hover, focus, and while open; it is always there, so the row never changes width. */}
        <Dropdown.Trigger
          variant="ghost"
          size="xs"
          class="group w-full justify-start text-left text-[11px] text-dimmed hover:text-primary [&_.k2b-button__label]:w-full [&_.k2b-button__label]:justify-start"
        >
          <i class={`${icon()} text-xs`} aria-hidden="true" />
          <span>{kind() === "event" ? t.addEvent : t.addTask}</span>
          <i
            class="ti ti-chevron-down ml-auto text-xs opacity-0 group-hover:opacity-70 group-focus-visible:opacity-70 group-aria-expanded:opacity-70"
            aria-hidden="true"
          />
        </Dropdown.Trigger>
      </Show>
    </CreateMenu>
  );
}
