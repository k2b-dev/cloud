import { createEffect, createMemo, createSignal, createUniqueId, Index, on, onCleanup, onMount, Show } from "solid-js";

export type ChatTask = { id: string; content: string; status: "pending" | "in_progress" | "completed" | "cancelled" };
export type ChatTasksProps = {
  items: readonly ChatTask[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  progressLabel: string;
  statusLabels: Record<ChatTask["status"], string>;
  /** The work is interrupted: the current step keeps its place and weight, but its ring stands still. */
  paused?: boolean;
};

export type ChatTaskListProps = {
  items: readonly ChatTask[];
  statusLabels: Record<ChatTask["status"], string>;
  "aria-label"?: string;
  "aria-labelledby"?: string;
};

/** The tasks whose status just became `completed`; only these play the check. A first render plays nothing. */
const createFreshChecks = (items: () => readonly ChatTask[]) => {
  let last = new Map<string, ChatTask["status"]>();
  return createMemo(() => {
    const next = new Map(items().map((item) => [item.id, item.status] as const));
    const fresh = new Set<string>();
    for (const [id, status] of next) {
      const before = last.get(id);
      if (before && before !== status && status === "completed") fresh.add(id);
    }
    last = next;
    return fresh;
  });
};

function TaskRow(props: { item: ChatTask; statusLabel: string; fresh: boolean }) {
  return (
    <li class="k2b-chat-task" data-status={props.item.status}>
      <span class="k2b-chat-task__mark" aria-hidden="true">
        <Show when={props.item.status === "completed"}>
          <i class="ti ti-check" data-fresh={props.fresh ? "" : undefined} />
        </Show>
        <Show when={props.item.status === "cancelled"}>
          <i class="ti ti-x" />
        </Show>
      </span>
      <span class="k2b-chat-task__content">{props.item.content}</span>
      <span class="k2b-sr-only">{props.statusLabel}</span>
    </li>
  );
}

/**
 * The working plan above the composer. Presentation only: the host owns the plan, its execution state, and every
 * label. The header stays at the composer; the list opens upwards, and only its height moves.
 */
export function ChatTasks(props: ChatTasksProps) {
  const id = createUniqueId();
  const fresh = createFreshChecks(() => props.items);
  const active = () => props.items.find((item) => item.status === "in_progress");
  const progress = () => {
    const counted = props.items.filter((item) => item.status !== "cancelled");
    if (!counted.length) return 0;
    return Math.round((counted.filter((item) => item.status === "completed").length / counted.length) * 100);
  };
  let list: HTMLOListElement | undefined;
  // The white highlight follows the measured current row; rows wrap, so their height is read, never assumed.
  const [glide, setGlide] = createSignal<{ top: number; height: number }>();
  const [glideReady, setGlideReady] = createSignal(false);
  const measure = () => {
    const row = list?.querySelector<HTMLElement>(':scope > li[data-status="in_progress"]');
    if (!list || !row || !row.offsetHeight) return setGlide(undefined);
    const next = { top: row.offsetTop, height: row.offsetHeight };
    const current = glide();
    if (current?.top !== next.top || current.height !== next.height) setGlide(next);
    // Keep the current row inside the list's own scroll area; the page never scrolls for it.
    if (next.top < list.scrollTop) list.scrollTop = next.top;
    else if (next.top + next.height > list.scrollTop + list.clientHeight) list.scrollTop = next.top + next.height - list.clientHeight;
  };
  onMount(() => {
    if (typeof ResizeObserver === "undefined" || !list) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(list);
    onCleanup(() => observer.disconnect());
  });
  createEffect(
    on(
      () => [props.items.map((item) => `${item.id}:${item.status}`).join("|"), props.open] as const,
      () => {
        measure();
        // The first placement appears in place; only later changes glide.
        if (glide() && !glideReady()) requestAnimationFrame(() => setGlideReady(true));
      },
    ),
  );
  return (
    <Show when={props.items.length}>
      <section
        class="k2b-chat-tasks"
        data-open={props.open ? "true" : "false"}
        data-paused={props.paused ? "" : undefined}
        aria-label={props.label}
      >
        <button
          type="button"
          class="k2b-chat-tasks__header"
          aria-expanded={props.open}
          aria-controls={id}
          onClick={() => props.onOpenChange(!props.open)}
        >
          <span class="k2b-chat-tasks__ring" style={{ "--k2b-chat-tasks-progress": `${progress()}%` }} aria-hidden="true" />
          <span class="k2b-chat-tasks__title">{props.label}</span>
          <span class="k2b-chat-tasks__now" aria-hidden={props.open ? "true" : undefined}>
            {active()?.content}
          </span>
          <span class="k2b-chat-tasks__count">{props.progressLabel}</span>
          <i class={props.open ? "ti ti-chevron-up" : "ti ti-chevron-down"} aria-hidden="true" />
        </button>
        <div class="k2b-chat-tasks__fold" id={id} inert={!props.open}>
          <div class="k2b-chat-tasks__clip">
            <ol ref={list} class="k2b-chat-tasks__list">
              <Show when={active() && glide()}>
                {(place) => (
                  <span
                    class="k2b-chat-tasks__glide"
                    data-ready={glideReady() ? "" : undefined}
                    style={{ transform: `translateY(${place().top}px)`, height: `${place().height}px` }}
                    aria-hidden="true"
                  />
                )}
              </Show>
              <Index each={props.items}>
                {(item) => <TaskRow item={item()} statusLabel={props.statusLabels[item().status]} fresh={fresh().has(item().id)} />}
              </Index>
            </ol>
          </div>
        </div>
      </section>
    </Show>
  );
}

/** A finished or stopped plan as a still list: the same marks on the same axis, without header, ring, or fold. */
export function ChatTaskList(props: ChatTaskListProps) {
  const fresh = createFreshChecks(() => props.items);
  return (
    <ol class="k2b-chat-task-list" aria-label={props["aria-label"]} aria-labelledby={props["aria-labelledby"]}>
      <Index each={props.items}>
        {(item) => <TaskRow item={item()} statusLabel={props.statusLabels[item().status]} fresh={fresh().has(item().id)} />}
      </Index>
    </ol>
  );
}
