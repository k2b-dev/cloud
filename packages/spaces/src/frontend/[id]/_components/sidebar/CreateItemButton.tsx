import type { DateContext } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { AppWorkspace, Button, dialogCore, toast } from "@k2b/ui";
import { createSignal } from "solid-js";
import { apiClient } from "@/api/client";
import type { SpaceColumn, SpaceItem, SpaceItemResourceReferenceInput, SpaceTag } from "@/contracts";
import { toastErrorWithRetry } from "../../../lib/feedback";
import { readResponseError } from "../../../lib/response";
import { useSpaceMessages } from "../../messages";
import ItemForm, { type ItemFormData } from "../shared/ItemForm";
import { itemCreateDialogOptions } from "../shared/item-form/dialog";
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

export function createItemController(props: Props) {
  const t = useSpaceMessages();
  const defaultType = () => props.defaultType ?? "task";
  const label = () => (defaultType() === "event" ? t.newEvent : t.newTask);
  const [dialogPending, setDialogPending] = createSignal(false);
  // The Space and the return address belong to the intent: a compose command can select another Space before Retry.
  type CreateIntent = { spaceId: string; data: ItemFormData; returnTo?: string };
  const mutation = mutations.create<SpaceItem, CreateIntent, { intent: CreateIntent }>({
    onBefore: (intent) => ({ intent }),
    mutation: async ({ spaceId, data }) => {
      const res = await apiClient[":id"].items.$post({
        param: { id: spaceId },
        json: {
          ...data,
          location: data.location ?? undefined,
          url: data.url ?? undefined,
          priority: data.priority ?? undefined,
          recurrence: data.recurrence ?? undefined,
          estimatedDurationMinutes: data.estimatedDurationMinutes ?? undefined,
        },
      });
      if (!res.ok) throw new Error(await readResponseError(res, t.createItemFailed));
      return res.json();
    },
    onSuccess: (item, context) => {
      // The new entry can land outside the current view or filter, so it is confirmed.
      toast.success(item.startsAt && item.endsAt ? t.eventCreated : t.taskCreated);
      refreshWorkspace();
      if (context?.intent.returnTo) window.location.assign(context.intent.returnTo);
    },
    // The form has closed, so Retry sends the captured entry again instead of losing it.
    onError: (err, context) => toastErrorWithRetry(err.message, t.retry, () => context && mutation.mutate(context.intent)),
  });
  const refreshWorkspace = (): void =>
    void invalidateSpacesData().catch(() => toastErrorWithRetry(t.workspaceRefreshAfterCreateFailed, t.retry, refreshWorkspace));
  const createItem = async (options: { type?: ItemType; references?: SpaceItemResourceReferenceInput[]; returnTo?: string } = {}) => {
    if (dialogPending() || mutation.loading()) return;
    setDialogPending(true);
    const spaceId = props.spaceId;
    try {
      const data = await dialogCore.open<ItemFormData | null>(
        (close) => (
          <ItemForm
            spaceId={spaceId}
            columns={props.columns}
            tags={props.tags}
            quickCreate
            defaults={{ type: options.type ?? defaultType(), columnId: props.defaultColumnId, references: options.references }}
            onSubmit={(data) => close(data)}
            onCancel={() => close(null)}
            dateConfig={props.dateConfig}
          />
        ),
        itemCreateDialogOptions,
      );
      if (data) await mutation.mutate({ spaceId, data, returnTo: options.returnTo });
      else if (options.returnTo) window.location.assign(options.returnTo);
    } finally {
      setDialogPending(false);
    }
  };
  const pending = () => dialogPending() || mutation.loading();

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
