import type { DateContext } from "@k2b/stdlib";
import { AppWorkspace, Button, dialogCore, toast } from "@k2b/ui";
import { createSignal } from "solid-js";
import type { SpaceColumn, SpaceItem, SpaceItemResourceReferenceInput, SpaceItemTemplate, SpaceTag } from "@/contracts";
import { createRetryToasts } from "../../../lib/feedback";
import { useSpaceMessages } from "../../messages";
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
  variant?: "primary" | "secondary" | "sidebar" | "chip" | "icon" | "inline";
  defaultType?: ItemType;
  defaultColumnId?: string;
};

export function createItemController(props: Props) {
  const t = useSpaceMessages();
  const retryToast = createRetryToasts();
  const defaultType = () => props.defaultType ?? "task";
  const label = () => (defaultType() === "event" ? t.newEvent : t.newTask);
  const [pending, setPending] = createSignal(false);
  const refreshWorkspace = (): void =>
    void invalidateSpacesData().catch(() => retryToast(t.workspaceRefreshAfterCreateFailed, t.retry, refreshWorkspace));
  const createItem = async (options: { type?: ItemType; references?: SpaceItemResourceReferenceInput[]; returnTo?: string } = {}) => {
    if (pending()) return;
    setPending(true);
    // The Space is the one the dialog opened for, even when a compose command selects another while it is open.
    const spaceId = props.spaceId;
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
            defaults={{ type: options.type ?? defaultType(), columnId: props.defaultColumnId, references: options.references }}
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

  return { createItem, pending, label, defaultType };
}

export default function CreateItemButton(props: Props) {
  const t = useSpaceMessages();
  const { createItem, pending, label, defaultType } = createItemController(props);

  if (props.variant === "chip") {
    return (
      <Button type="button" size="sm" onClick={() => void createItem()} disabled={pending()}>
        {pending() ? (
          <i class="ti ti-loader-2 animate-spin" />
        ) : (
          <>
            <i class="ti ti-plus" />
            <span>{label()}</span>
          </>
        )}
      </Button>
    );
  }

  if (props.variant === "sidebar") {
    return (
      <AppWorkspace.SidebarItem
        onClick={() => void createItem()}
        disabled={pending()}
        tone="success"
        icon={pending() ? "ti ti-loader-2 animate-spin" : "ti ti-plus"}
      >
        {label()}
      </AppWorkspace.SidebarItem>
    );
  }

  if (props.variant === "icon") {
    return (
      <AppWorkspace.SidebarIconAction
        icon={pending() ? "ti ti-loader-2 animate-spin" : "ti ti-plus"}
        label={label()}
        onClick={() => void createItem()}
        disabled={pending()}
      />
    );
  }

  if (props.variant === "inline") {
    return (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => void createItem()}
        disabled={pending()}
        class="w-full justify-start text-left text-[11px] text-dimmed hover:text-primary [&_.k2b-button__label]:w-full [&_.k2b-button__label]:justify-start"
      >
        <i class={`ti ${pending() ? "ti-loader-2 animate-spin" : "ti-plus"} text-xs`} />
        <span>{defaultType() === "event" ? t.addEvent : t.addTask}</span>
      </Button>
    );
  }

  return (
    <Button type="button" onClick={() => void createItem()} disabled={pending()} class="w-full">
      {pending() ? (
        <i class="ti ti-loader-2 animate-spin" />
      ) : (
        <>
          <i class="ti ti-plus" />
          <span>{label()}</span>
        </>
      )}
    </Button>
  );
}
