import { For, Show, createUniqueId } from "solid-js";

export type ChatTask = { id: string; content: string; status: "pending" | "in_progress" | "completed" | "cancelled" };
export type ChatTasksProps = {
  items: readonly ChatTask[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  progressLabel: string;
  statusLabels: Record<ChatTask["status"], string>;
};

/** Presentation only. The host owns the plan and execution state. */
export function ChatTasks(props: ChatTasksProps) {
  const id = createUniqueId();
  const active = () => props.items.find(item => item.status === "in_progress");
  const icon = (status: ChatTask["status"]) => status === "completed" ? "ti ti-check" : status === "cancelled" ? "ti ti-minus" : status === "in_progress" ? "ti ti-wave-saw-tool" : "ti ti-circle";
  return <Show when={props.items.length}>
    <section class="k2b-chat-tasks">
      <button type="button" class="k2b-chat-tasks__header" aria-expanded={props.open} aria-controls={id} onClick={() => props.onOpenChange(!props.open)}>
        <i class="ti ti-list-check" aria-hidden="true" />
        <span class="k2b-chat-tasks__title">{props.label}<Show when={active()}> · {active()!.content}</Show></span>
        <span class="k2b-chat-tasks__count">{props.progressLabel}</span>
        <span class="k2b-chat-tasks__segments" aria-hidden="true"><For each={props.items}>{item => <span data-status={item.status} />}</For></span>
        <i class={props.open ? "ti ti-chevron-up" : "ti ti-chevron-down"} aria-hidden="true" />
      </button>
      <Show when={props.open}><ol id={id} class="k2b-chat-tasks__list"><For each={props.items}>{item =>
        <li data-status={item.status}><i class={icon(item.status)} aria-hidden="true" /><span class="k2b-chat-tasks__content">{item.content}</span><span class="k2b-chat-tasks__status">{props.statusLabels[item.status]}</span></li>
      }</For></ol></Show>
    </section>
  </Show>;
}
