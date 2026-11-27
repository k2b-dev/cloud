import { Dropdown } from "@k2b/ui";
import { Show } from "solid-js";
import { useSpaceMessages } from "../../messages";
import { CreateMenu } from "./CreateMenu";
import { type CreateItemProps, createItemController } from "./create-item";

/** The "+" menu lives in its own module, so a page can offer it without the create dialog. */
export { CreateMenu } from "./CreateMenu";

/**
 * The create menu on a small button. A board column (`variant="column"`) shows it as a quiet "+" in its head beside the
 * column's other actions, so the screen keeps one visible create cue and the column still offers its own.
 */
export default function CreateItemButton(props: CreateItemProps) {
  const t = useSpaceMessages();
  const controller = createItemController(props);
  const column = () => props.columns.find((candidate) => candidate.id === props.defaultColumnId);
  const kind = () => controller.defaultType();
  const icon = () => (controller.pending() ? "ti ti-loader-2 animate-spin" : "ti ti-plus");
  const title = () => (column() ? t.createMenuInColumn({ column: column()!.name }) : undefined);

  return (
    <CreateMenu kind={kind()} templates={props.templates ?? []} choose={controller.choose} title={title()} disabled={controller.pending()}>
      <Show
        when={props.variant === "column"}
        fallback={
          <Dropdown.Trigger size="sm">
            <i class={icon()} aria-hidden="true" />
            <span>{controller.label()}</span>
            <i class="ti ti-chevron-down text-xs opacity-70" aria-hidden="true" />
          </Dropdown.Trigger>
        }
      >
        <Dropdown.Trigger
          iconOnly
          size="xs"
          variant="ghost"
          class="spaces-kanban-column-create h-6 w-6 text-dimmed"
          label={title() ?? controller.label()}
          data-spaces-kanban-column-create
        >
          <i class={`${icon()} text-sm`} aria-hidden="true" />
        </Dropdown.Trigger>
      </Show>
    </CreateMenu>
  );
}
