import type { DateContext } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { AppWorkspace, Button, dialogCore, panelDialogOptions, prompts, toast } from "@k2b/ui";
import { createSignal } from "solid-js";
import { apiClient } from "@/api/client";
import type { SpaceColumn, SpaceItem, SpaceTag } from "@/contracts";
import { readResponseError } from "../../../lib/response";
import { useSpaceMessages } from "../../messages";
import ItemForm, { type ItemFormData } from "../shared/ItemForm";
import type { ItemType } from "../shared/item-form/types";
import { invalidateSpacesData } from "../workspace/workspace-events";

type Props = {
  spaceId: string;
  columns: SpaceColumn[];
  tags: SpaceTag[];
  dateConfig?: DateContext;
  variant?: "primary" | "secondary" | "sidebar" | "chip" | "icon" | "inline";
  defaultType?: ItemType;
  defaultColumnId?: string;
};

export default function CreateItemButton(props: Props) {
  const t = useSpaceMessages();
  const defaultType = () => props.defaultType ?? "task";
  const label = () => (defaultType() === "event" ? t.newEvent : t.newTask);
  const [dialogPending, setDialogPending] = createSignal(false);
  const mutation = mutations.create<SpaceItem, ItemFormData>({
    mutation: async (intent) => {
      const res = await apiClient[":id"].items.$post({
        param: { id: props.spaceId },
        json: {
          ...intent,
          location: intent.location ?? undefined,
          url: intent.url ?? undefined,
          priority: intent.priority ?? undefined,
          recurrence: intent.recurrence ?? undefined,
          estimatedDurationMinutes: intent.estimatedDurationMinutes ?? undefined,
        },
      });
      if (!res.ok) throw new Error(await readResponseError(res, t.createItemFailed));
      return res.json();
    },
    onSuccess: () => {
      toast.success(defaultType() === "event" ? t.eventCreated : t.taskCreated);
      void invalidateSpacesData().catch(() => prompts.error(t.workspaceRefreshAfterCreateFailed));
    },
    onError: (err) => prompts.error(err.message),
  });
  const createItem = async () => {
    if (dialogPending() || mutation.loading()) return;
    setDialogPending(true);
    try {
      const intent = await dialogCore.open<ItemFormData | null>(
        (close) => (
          <ItemForm
            spaceId={props.spaceId}
            columns={props.columns}
            tags={props.tags}
            quickCreate
            defaults={{ type: defaultType(), columnId: props.defaultColumnId }}
            onSubmit={(data) => close(data)}
            onCancel={() => close(null)}
            title={label()}
            icon={defaultType() === "event" ? "ti ti-calendar-plus" : "ti ti-square-plus"}
            dateConfig={props.dateConfig}
          />
        ),
        panelDialogOptions,
      );
      if (intent) void mutation.mutate(intent);
    } finally {
      setDialogPending(false);
    }
  };
  const pending = () => dialogPending() || mutation.loading();

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
