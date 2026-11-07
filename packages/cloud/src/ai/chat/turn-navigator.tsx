import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { AiConversationTimelineEntry } from "../types";
import { adjacentTimelineEntry, isTimelineRailScrollable } from "./turn-navigator-utils";

type TurnNavigatorProps = {
  entries: AiConversationTimelineEntry[];
  activeSeq: number | null;
  loadingSeq: number | null;
  height: number;
  onSelect: (entry: AiConversationTimelineEntry) => void;
};

const countLabel = (count: number, singular: string, plural = `${singular}s`) => `${count} ${count === 1 ? singular : plural}`;

export function TurnNavigator(props: TurnNavigatorProps) {
  let navRef: HTMLElement | undefined;
  let markerViewportRef: HTMLDivElement | undefined;
  const markerRefs = new Map<number, HTMLButtonElement>();
  const [previewSeq, setPreviewSeq] = createSignal<number | null>(null);
  const [previewTop, setPreviewTop] = createSignal(8);
  const [railHovered, setRailHovered] = createSignal(false);
  let wheelDelta = 0;
  let wheelLockedUntil = 0;

  const preview = createMemo(() => props.entries.find((entry) => entry.seq === previewSeq()) ?? null);
  const scrollable = () => isTimelineRailScrollable(props.entries.length, props.height);
  const revealMarker = (marker: HTMLButtonElement | undefined) => {
    const viewport = markerViewportRef;
    if (!marker || !viewport) return;
    const viewportRect = viewport.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    if (markerRect.top < viewportRect.top) viewport.scrollTop -= viewportRect.top - markerRect.top;
    else if (markerRect.bottom > viewportRect.bottom) viewport.scrollTop += markerRect.bottom - viewportRect.bottom;
  };
  const showPreview = (entry: AiConversationTimelineEntry, marker: HTMLButtonElement) => {
    setPreviewSeq(entry.seq);
    const navRect = navRef?.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    if (!navRect) return;
    setPreviewTop(Math.max(8, Math.min(props.height - 176, markerRect.top - navRect.top - 68)));
  };

  createEffect(() => {
    const active = props.activeSeq;
    if (active === null || railHovered()) return;
    revealMarker(markerRefs.get(active));
  });

  const selectAdjacent = (direction: -1 | 1) => {
    const current = previewSeq() ?? props.activeSeq;
    const next = adjacentTimelineEntry(props.entries, current, direction);
    if (!next || next.seq === current) return;
    const marker = markerRefs.get(next.seq);
    if (marker) showPreview(next, marker);
    props.onSelect(next);
  };

  const handleWheel = (event: WheelEvent) => {
    event.preventDefault();
    wheelDelta += event.deltaY;
    const now = performance.now();
    if (Math.abs(wheelDelta) < 28 || now < wheelLockedUntil) return;
    const direction = wheelDelta > 0 ? 1 : -1;
    wheelDelta = 0;
    wheelLockedUntil = now + 90;
    selectAdjacent(direction);
  };

  return (
    <nav
      ref={navRef}
      aria-label="Conversation turns"
      class="pointer-events-auto relative block w-8"
      style={{ height: `${props.height}px` }}
      onMouseEnter={() => setRailHovered(true)}
      onMouseLeave={() => {
        setRailHovered(false);
        setPreviewSeq(null);
        wheelDelta = 0;
      }}
      onWheel={handleWheel}
    >
      <div
        ref={markerViewportRef}
        class={`flex h-full w-8 flex-col items-center gap-1 overflow-y-auto py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${
          scrollable() ? "justify-start" : "justify-center"
        }`}
      >
        <For each={props.entries}>
          {(entry) => {
            const active = () => entry.seq === props.activeSeq;
            const loading = () => entry.seq === props.loadingSeq;
            return (
              <button
                ref={(node) => markerRefs.set(entry.seq, node)}
                type="button"
                class="group/marker flex h-3 w-8 shrink-0 items-center justify-center focus-ui"
                aria-label={`${entry.isSteer ? "Steering message" : "User message"}: ${entry.userPreview}`}
                aria-current={active() ? "location" : undefined}
                onMouseEnter={(event) => showPreview(entry, event.currentTarget)}
                onFocus={(event) => showPreview(entry, event.currentTarget)}
                onClick={() => props.onSelect(entry)}
              >
                <span
                  class={`block h-0.5 rounded-full transition-[width,background-color] ${
                    loading()
                      ? "w-5 animate-pulse bg-[var(--k2b-ai-accent)]"
                      : active()
                        ? "w-6 bg-zinc-700 dark:bg-zinc-100"
                        : entry.isSteer
                          ? "w-2 bg-zinc-300 group-hover/marker:w-4 group-hover/marker:bg-zinc-500 dark:bg-zinc-700 dark:group-hover/marker:bg-zinc-400"
                          : "w-3 bg-zinc-300 group-hover/marker:w-5 group-hover/marker:bg-zinc-500 dark:bg-zinc-700 dark:group-hover/marker:bg-zinc-400"
                  }`}
                />
              </button>
            );
          }}
        </For>
      </div>

      <Show when={preview()}>
        {(entry) => (
          <div
            class="pointer-events-none absolute left-10 z-30 w-80 max-w-[min(20rem,calc(100vw-6rem))] rounded-md border border-zinc-200 bg-white p-3 text-left shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
            style={{ top: `${previewTop()}px` }}
          >
            <p class="line-clamp-2 text-sm font-medium leading-5 text-primary">{entry().userPreview}</p>
            <Show when={entry().assistantPreview}>
              <p class="mt-1 line-clamp-3 text-xs leading-5 text-dimmed">{entry().assistantPreview}</p>
            </Show>
            <Show when={entry().isSteer || entry().inputFileCount > 0 || entry().outputFileCount > 0 || entry().toolCount > 0}>
              <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-dimmed">
                <Show when={entry().isSteer}>
                  <span class="inline-flex items-center gap-1">
                    <i class="ti ti-route" aria-hidden="true" />
                    Steered
                  </span>
                </Show>
                <Show when={entry().inputFileCount > 0}>
                  <span class="inline-flex items-center gap-1">
                    <i class="ti ti-paperclip" aria-hidden="true" />
                    {countLabel(entry().inputFileCount, "file")}
                  </span>
                </Show>
                <Show when={entry().outputFileCount > 0}>
                  <span class="inline-flex items-center gap-1">
                    <i class="ti ti-file-export" aria-hidden="true" />
                    {countLabel(entry().outputFileCount, "output file")}
                  </span>
                </Show>
                <Show when={entry().toolCount > 0}>
                  <span class="inline-flex items-center gap-1">
                    <i class="ti ti-tool" aria-hidden="true" />
                    {countLabel(entry().toolCount, "tool")}
                  </span>
                </Show>
              </div>
            </Show>
          </div>
        )}
      </Show>
    </nav>
  );
}
