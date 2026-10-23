import { type DateContext, dates } from "@k2b/stdlib";
import { Button, DetailPanel, Dropdown, dialogCore, PanelDialog, panelDialogOptions, toast } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { SpaceItem } from "@/contracts";
import type { SpaceTimeBlock } from "../../../../time-block-contracts";
import { readResponseError } from "../../../lib/response";
import { invalidateSpacesData } from "../workspace/workspace-events";
import { deleteTimeBlock } from "./client";
import { useTimeBlockMessages } from "./messages";
import { openTimeBlockDialog } from "./TimeBlockDialog";

type TaskProps = { item: SpaceItem; spaceId: string; currentUserId: string; canAssign: boolean; dateConfig?: DateContext; day?: string };
export const isAssignedPerson = (item: SpaceItem, userId: string | undefined) =>
  (item.assignees ?? []).some((person) => person.kind === "user" && person.id === userId);
export function TimeBlockAction(props: TaskProps) {
  const t = useTimeBlockMessages();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [retry, setRetry] = createSignal<() => Promise<void>>();
  const assign = async () => {
    if (busy()) return;
    setBusy(true);
    setError(undefined);
    try {
      // Add the reader without removing any existing responsibility or claim.
      const response = await apiClient[":id"].items[":itemId"].$patch({
        param: { id: props.spaceId, itemId: props.item.id },
        json: { assigneeIds: [...new Set([...(props.item.assignees ?? []).map((p) => p.id), props.currentUserId])] },
      });
      if (!response.ok) throw new Error(await readResponseError(response, t.assignFailed));
      await invalidateSpacesData();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setRetry(() => assign);
    } finally {
      setBusy(false);
    }
  };
  const open = async () => {
    const block = await openTimeBlockDialog(props);
    if (!block) return;
    toast.success(t.saved, { action: { label: t.undo, onClick: () => void undo(block.id) } });
    try {
      await invalidateSpacesData();
    } catch (cause) {
      setError(String(cause));
      setRetry(() => invalidateSpacesData);
    }
  };
  const undo = async (id: string) => {
    setError(undefined);
    try {
      await deleteTimeBlock(id, t.deleteFailed);
      await invalidateSpacesData();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setRetry(() => () => undo(id));
    }
  };
  return (
    <div class="flex flex-col gap-1">
      <Button
        size="sm"
        variant="secondary"
        disabled={busy() || (!isAssignedPerson(props.item, props.currentUserId) && !props.canAssign)}
        title={!isAssignedPerson(props.item, props.currentUserId) ? t.assignedFirst : undefined}
        onClick={() => void (isAssignedPerson(props.item, props.currentUserId) ? open() : assign())}
      >
        <i
          class={`ti ${busy() ? "ti-loader-2 animate-spin" : isAssignedPerson(props.item, props.currentUserId) ? "ti-calendar-plus" : "ti-user-plus"}`}
          aria-hidden="true"
        />
        {busy() ? t.assigning : isAssignedPerson(props.item, props.currentUserId) ? t.block : t.assign}
      </Button>
      <Show when={error()}>
        <div role="alert" class="text-sm text-danger">
          {error()}
          <Button variant="ghost" size="sm" disabled={busy()} onClick={() => void retry()?.()}>
            {t.retry}
          </Button>
        </div>
      </Show>
    </div>
  );
}
export function TimeBlocksSection(props: TaskProps & { blocks: SpaceTimeBlock[]; selectedBlockId?: string }) {
  const t = useTimeBlockMessages();
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal<string>();
  const [retry, setRetry] = createSignal<() => Promise<void>>();
  const remove = async (block: SpaceTimeBlock) => {
    setBusy(block.id);
    setError(undefined);
    try {
      await deleteTimeBlock(block.id, t.deleteFailed);
      await invalidateSpacesData();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setRetry(() => () => remove(block));
    } finally {
      setBusy(undefined);
    }
  };
  const edit = async (block: SpaceTimeBlock) => {
    if (await openTimeBlockDialog({ ...props, block })) {
      try {
        await invalidateSpacesData();
      } catch (cause) {
        setError(String(cause));
        setRetry(() => invalidateSpacesData);
      }
    }
  };
  return (
    <Show when={props.blocks.length > 0}>
      <DetailPanel.Section title={t.blocks} icon="ti ti-calendar-time" tone="neutral">
        <For each={props.blocks}>
          {(block) => (
            <div
              id={`time-block-${block.id}`}
              data-selected={props.selectedBlockId === block.id || undefined}
              class="spaces-time-block-row flex items-center gap-2 rounded-lg p-2"
            >
              <i class={`ti ${block.taskState === "done" ? "ti-circle-check" : "ti-calendar-time"} text-dimmed`} aria-hidden="true" />
              <div class="min-w-0 flex-1 text-sm">
                <div>
                  {dates.formatDate(block.startsAt, props.dateConfig)} · {dates.formatTime(block.startsAt, props.dateConfig)}–
                  {dates.formatTime(block.endsAt, props.dateConfig)}
                </div>
                <div class="text-xs text-dimmed">
                  {block.ownerName}
                  <Show when={block.title !== props.item.title}> · {block.title}</Show>
                </div>
              </div>
              <Show when={block.canWrite}>
                <Button size="sm" variant="ghost" disabled={busy() === block.id} onClick={() => void edit(block)}>
                  {t.edit}
                </Button>
              </Show>
              <Show when={block.canDelete}>
                <Dropdown.Root
                  items={[{ label: t.delete, icon: "ti ti-trash", action: () => void remove(block), disabled: busy() === block.id }]}
                >
                  <Dropdown.Trigger iconOnly label={t.actions}>
                    <i class="ti ti-dots" aria-hidden="true" />
                  </Dropdown.Trigger>
                </Dropdown.Root>
              </Show>
            </div>
          )}
        </For>
        <Show when={error()}>
          <div role="alert" class="text-sm text-danger">
            {error()}
            <Button variant="ghost" size="sm" onClick={() => void retry()?.()}>
              {t.retry}
            </Button>
          </div>
        </Show>
      </DetailPanel.Section>
    </Show>
  );
}
export const openOrphanTimeBlock = (block: SpaceTimeBlock) =>
  dialogCore.open((close) => {
    const t = useTimeBlockMessages();
    const [error, setError] = createSignal<string>();
    const [busy, setBusy] = createSignal(false);
    const remove = async () => {
      setBusy(true);
      try {
        await deleteTimeBlock(block.id, t.deleteFailed);
        await invalidateSpacesData();
        close();
      } catch (cause) {
        setError(String(cause));
      } finally {
        setBusy(false);
      }
    };
    return (
      <PanelDialog>
        <PanelDialog.Header title={block.taskState === "deleted" ? t.deleted : t.noAccess} subtitle={block.title} />
        <PanelDialog.Body>
          <p>{block.taskState === "deleted" ? t.deletedHelp : t.noAccessHelp}</p>
          <Show when={error()}>
            <p role="alert">{error()}</p>
          </Show>
        </PanelDialog.Body>
        <PanelDialog.Footer>
          <Show when={block.canDelete}>
            <Button variant="ghost" disabled={busy()} onClick={() => void remove()}>
              {t.delete}
            </Button>
          </Show>
          <Button onClick={() => close()}>{t.close}</Button>
        </PanelDialog.Footer>
      </PanelDialog>
    );
  }, panelDialogOptions);
