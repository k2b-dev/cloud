import type { DateContext } from "@k2b/stdlib";
import { Dropdown, dialogCore, toast, useLocale } from "@k2b/ui";
import { createMemo, createSignal, type JSX, Show } from "solid-js";
import type { SpaceColumn, SpaceItem, SpaceItemResourceReferenceInput, SpaceItemTemplate, SpaceTag } from "@/contracts";
import { createRetryToasts } from "../../../lib/feedback";
import { useSpaceMessages } from "../../messages";
import { openTemplateDialog } from "../edit/TemplateDialog";
import { type CreateMenuChoice, type CreateMenuKind, createMenuModel } from "../shared/create-menu";
import { createSpaceItem } from "../shared/editItem";
import ItemForm from "../shared/ItemForm";
import { itemCreateDialogOptions } from "../shared/item-form/dialog";
import type { ItemType } from "../shared/item-form/types";
import { invalidateSpacesData } from "../workspace/workspace-events";

type Props = {
  spaceId: string;
  columns: SpaceColumn[];
  tags: SpaceTag[];
  templates?: SpaceItemTemplate[];
  dateConfig?: DateContext;
  variant?: "chip" | "inline";
  defaultType?: ItemType;
  defaultColumnId?: string;
};

export type CreateItemOptions = {
  type?: ItemType;
  references?: SpaceItemResourceReferenceInput[];
  returnTo?: string;
  /** A blank item's title, such as a menu query no template matched. */
  title?: string;
  /** Opens the dialog with this template chosen; a template deleted meanwhile says so and opens it blank. */
  templateId?: string;
};

export function createItemController(props: Props) {
  const t = useSpaceMessages();
  const locale = useLocale();
  const retryToast = createRetryToasts();
  const defaultType = () => props.defaultType ?? "task";
  const label = () => (defaultType() === "event" ? t.newEvent : t.newTask);
  const [pending, setPending] = createSignal(false);
  const refreshWorkspace = (): void =>
    void invalidateSpacesData().catch(() => retryToast(t.workspaceRefreshAfterCreateFailed, t.retry, refreshWorkspace));
  const createItem = async (options: CreateItemOptions = {}) => {
    if (pending()) return;
    setPending(true);
    // The Space is the one the dialog opened for, even when a compose command selects another while it is open.
    const spaceId = props.spaceId;
    const template = options.templateId ? props.templates?.find((candidate) => candidate.id === options.templateId) : undefined;
    if (options.templateId && !template) toast.error(t.templateGone);
    try {
      // The dialog stays open until the create answers, so a failure shows in it with the input still there.
      const item = await dialogCore.open<SpaceItem | null>(
        (close) => (
          <ItemForm
            spaceId={spaceId}
            columns={props.columns}
            tags={props.tags}
            templates={props.templates}
            quickCreate
            defaults={{
              type: template?.kind ?? options.type ?? defaultType(),
              columnId: props.defaultColumnId,
              references: options.references,
              title: options.title,
              templateId: template?.id,
            }}
            onSubmit={async (data) => close(await createSpaceItem(spaceId, data, t.createItemFailed))}
            onCancel={() => close(null)}
            dateConfig={props.dateConfig}
          />
        ),
        itemCreateDialogOptions,
      );
      if (item) {
        // The new entry can land outside the current view or filter, so it is confirmed.
        toast.success(item.startsAt && item.endsAt ? t.eventCreated : t.taskCreated);
        refreshWorkspace();
      }
      if (options.returnTo) window.location.assign(options.returnTo);
    } finally {
      setPending(false);
    }
  };
  const createTemplate = async (kind: SpaceItemTemplate["kind"]) => {
    const saved = await openTemplateDialog({
      spaceId: props.spaceId,
      kind,
      tags: props.tags,
      templates: props.templates ?? [],
      dateConfig: props.dateConfig,
      locale: locale(),
    });
    if (saved) refreshWorkspace();
  };
  /** Runs what a person chose in the "+" menu. */
  const choose = (choice: CreateMenuChoice) => {
    if (choice.type === "blank") void createItem({ type: choice.kind, title: choice.title });
    else if (choice.type === "template") void createItem({ templateId: choice.template.id });
    else void createTemplate(choice.kind);
  };

  return { createItem, createTemplate, choose, pending, label, defaultType };
}

/**
 * The "+" menu: blank first, then the Space's templates, then "Create template…". A phone opens it as a sheet with its
 * title on top. Without `children` it adopts the element `attach` returns, such as the head's server-rendered link.
 */
export function CreateMenu(props: {
  kind: CreateMenuKind;
  templates: readonly SpaceItemTemplate[];
  choose: (choice: CreateMenuChoice) => void;
  /** The phone sheet's title, such as "New task in “Review”"; defaults to the menu's name. */
  title?: string;
  /** Shows N and Shift+N beside the blank entries, where those keys create directly. */
  shortcuts?: boolean;
  attach?: () => HTMLElement | null | undefined;
  disabled?: boolean;
  align?: "start" | "end";
  class?: string;
  children?: JSX.Element;
}) {
  const t = useSpaceMessages();
  const locale = useLocale();
  const model = createMemo(() =>
    createMenuModel({
      kind: props.kind,
      templates: props.templates,
      shortcuts: props.shortcuts,
      t,
      locale: locale(),
      choose: props.choose,
    }),
  );
  return (
    <Dropdown.Root
      items={model().items}
      search={model().search}
      label={model().label}
      icons="tile"
      phone="sheet"
      width="18.75rem"
      align={props.align}
      class={props.class}
      disabled={props.disabled}
      attach={props.attach}
      sheetTop={() => <p class="px-3 pb-1 text-[0.9375rem] font-semibold">{props.title ?? model().label}</p>}
    >
      {props.children}
    </Dropdown.Root>
  );
}

export default function CreateItemButton(props: Props) {
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
