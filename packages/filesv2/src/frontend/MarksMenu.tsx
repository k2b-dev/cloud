import { AppWorkspace, Button, Format, IconButton, Placeholder, prompts, ScrollArea } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../api/client";
import type { MarkedEntry } from "../contracts";
import { useBrowserMessages } from "./browser-messages";
import { apiFailure, fileIcon } from "./file-preview";

export type MarksKind = "recent" | "favorites";
type MarksOptions = { kind: MarksKind; onOpen: (entry: MarkedEntry) => void; revision?: number };

/** The same authorized, lazily loaded catalog is used by desktop previews and the mobile dialog. */
export function MarksMenu(props: MarksOptions & { open: boolean; close: () => void; modal?: boolean }) {
  const b = useBrowserMessages();
  const [items, setItems] = createSignal<MarkedEntry[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal(false);
  const [now, setNow] = createSignal(new Date());
  const [retry, setRetry] = createSignal(0);
  createEffect(() => {
    if (!props.open) return;
    props.revision;
    retry();
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 60_000);
    void (async () => {
      try {
        const response = props.kind === "recent"
          ? await apiClient.recent.$get({}, { init: { signal: controller.signal } })
          : await apiClient.favorites.$get({}, { init: { signal: controller.signal } });
        if (!response.ok) await apiFailure(response, b().loadFailed);
        const result = await response.json();
        if (!controller.signal.aborted) setItems(result);
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    onCleanup(() => { controller.abort(); clearInterval(timer); });
  });
  const ordered = createMemo(() => [...items()].sort((a, c) => props.kind === "recent"
    ? c.markedAt.localeCompare(a.markedAt)
    : a.entry.name.localeCompare(c.entry.name, undefined, { numeric: true, sensitivity: "base" }) || a.base.name.localeCompare(c.base.name)));
  const duplicates = createMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items()) counts.set(item.entry.name, (counts.get(item.entry.name) ?? 0) + 1);
    return counts;
  });
  return <div class="flex min-w-0 flex-col gap-2">
    <div class="flex items-center justify-between gap-2">
      <strong>{props.kind === "recent" ? b().recent : b().favorites}</strong>
      <Show when={props.modal}><IconButton size="xs" label={b().close} onClick={props.close}><i class="ti ti-x" aria-hidden="true" /></IconButton></Show>
    </div>
    <Show when={!loading()} fallback={<Placeholder state="loading" description={b().loadingDetails} />}>
      <Show when={!error()} fallback={<Placeholder state="error" description={b().loadFailed} action={<Button size="sm" onClick={() => setRetry(value => value + 1)}>{b().retry}</Button>} />}>
        <For each={ordered()} fallback={<p class="px-2 py-1 text-xs text-dimmed">{props.kind === "recent" ? b().noRecent : b().noFavorites}</p>}>
          {item => <AppWorkspace.SidebarItem icon={fileIcon(item.entry)} title={item.entry.name}
            onClick={() => { props.close(); props.onOpen(item); }}
            description={(duplicates().get(item.entry.name) ?? 0) > 1 ? `${item.base.name} / ${item.entry.path}` : undefined}
            meta={props.kind === "recent" ? <Format.RelativeTime value={item.markedAt} base={now()} title={new Date(item.markedAt).toLocaleString()} /> : undefined}>
            <AppWorkspace.SidebarItemLabel marquee={false}>{item.entry.name}</AppWorkspace.SidebarItemLabel>
          </AppWorkspace.SidebarItem>}
        </For>
      </Show>
    </Show>
  </div>;
}

export function MarksSidebarItem(props: MarksOptions) {
  const b = useBrowserMessages();
  const [open, setOpen] = createSignal(false);
  const label = () => props.kind === "recent" ? b().recent : b().favorites;
  return <AppWorkspace.SidebarItem icon={props.kind === "recent" ? "ti ti-history" : "ti ti-star"}
    preview={{ label: label(), trigger: "row", onOpenChange: setOpen, content: close => <MarksMenu {...props} open={open()} close={close} /> }}>
    {label()}
  </AppWorkspace.SidebarItem>;
}

export function openMarksDialog(options: MarksOptions & { title: string; signal?: AbortSignal }) {
  return prompts.dialog<void>(close => <ScrollArea style={{ "max-height": "60dvh" }}>
    <MarksMenu {...options} open close={close} modal />
  </ScrollArea>, { title: options.title, header: false, size: "medium", signal: options.signal });
}
