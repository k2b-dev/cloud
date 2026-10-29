import { AppWorkspace, Button, Format, IconButton, Placeholder, prompts, ScrollArea, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../api/client";
import type { MarkedEntry } from "../contracts";
import { baseLabel } from "./base-label";
import { useBrowserMessages } from "./browser-messages";
import { apiFailure, fileIcon } from "./file-preview";

export type MarksKind = "recent" | "favorites";
type MarksOptions = { kind: MarksKind; onOpen: (entry: MarkedEntry) => void; revision?: number };

/** The same authorized, lazily loaded catalog is used by desktop previews, the mobile dialog, and the overview. */
export function MarksMenu(props: MarksOptions & { open: boolean; close: () => void; modal?: boolean }) {
  const b = useBrowserMessages();
  return (
    <div class="flex min-w-0 flex-col gap-2">
      <div class="flex items-center justify-between gap-2">
        <strong>{props.kind === "recent" ? b().recent : b().favorites}</strong>
        <Show when={props.modal}>
          <IconButton size="xs" label={b().close} onClick={props.close}>
            <i class="ti ti-x" aria-hidden="true" />
          </IconButton>
        </Show>
      </div>
      <MarksCatalog kind={props.kind} onOpen={props.onOpen} revision={props.revision} active={props.open} onPick={props.close} />
    </div>
  );
}

/**
 * Loads the catalog while `active` and shows its own loading, error, and retry states, so a failure stays inside it.
 * Each entry is authorized against its storage, which can take a while; nothing around it waits for it.
 */
export function MarksCatalog(props: MarksOptions & { active: boolean; onPick?: () => void }) {
  const b = useBrowserMessages();
  const [items, setItems] = createSignal<MarkedEntry[]>([]);
  // Active from the start, server rendering shows the loading state instead of an empty catalog.
  const [loading, setLoading] = createSignal(props.active);
  const [error, setError] = createSignal(false);
  const [retry, setRetry] = createSignal(0);
  createEffect(() => {
    if (!props.active) return;
    props.revision;
    retry();
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    void (async () => {
      try {
        const response =
          props.kind === "recent"
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
    onCleanup(() => {
      controller.abort();
    });
  });
  return (
    <Show when={!loading()} fallback={<Placeholder state="loading" description={b().loadingDetails} />}>
      <Show
        when={!error()}
        fallback={
          <Placeholder
            state="error"
            description={b().loadFailed}
            action={
              <Button size="sm" onClick={() => setRetry((value) => value + 1)}>
                {b().retry}
              </Button>
            }
          />
        }
      >
        <MarksList kind={props.kind} items={items()} onOpen={props.onOpen} onPick={props.onPick} />
      </Show>
    </Show>
  );
}

function MarksList(props: { kind: MarksKind; items: MarkedEntry[]; onOpen: (entry: MarkedEntry) => void; onPick?: () => void }) {
  const b = useBrowserMessages();
  const locale = useLocale();
  const [now, setNow] = createSignal(new Date());
  createEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    onCleanup(() => clearInterval(timer));
  });
  const ordered = createMemo(() =>
    [...props.items].sort((a, c) =>
      props.kind === "recent"
        ? c.markedAt.localeCompare(a.markedAt)
        : a.entry.name.localeCompare(c.entry.name, undefined, { numeric: true, sensitivity: "base" }) ||
          baseLabel(a.base, b(), locale()).localeCompare(baseLabel(c.base, b(), locale())),
    ),
  );
  const duplicates = createMemo(() => {
    const counts = new Map<string, number>();
    for (const item of props.items) counts.set(item.entry.name, (counts.get(item.entry.name) ?? 0) + 1);
    return counts;
  });
  return (
    <For
      each={ordered()}
      fallback={
        <Placeholder
          variant="inline"
          align="left"
          icon={props.kind === "recent" ? "ti ti-clock" : "ti ti-star"}
          description={props.kind === "recent" ? b().noRecent : b().noFavorites}
        />
      }
    >
      {(item) => (
        <AppWorkspace.SidebarItem
          icon={fileIcon(item.entry)}
          title={item.entry.name}
          onClick={() => {
            props.onPick?.();
            props.onOpen(item);
          }}
          description={
            (duplicates().get(item.entry.name) ?? 0) > 1 ? `${baseLabel(item.base, b(), locale())} / ${item.entry.path}` : undefined
          }
          meta={
            props.kind === "recent" ? (
              <Format.RelativeTime value={item.markedAt} base={now()} title={new Date(item.markedAt).toLocaleString()} />
            ) : undefined
          }
        >
          <AppWorkspace.SidebarItemLabel marquee={false}>{item.entry.name}</AppWorkspace.SidebarItemLabel>
        </AppWorkspace.SidebarItem>
      )}
    </For>
  );
}

export function MarksSidebarItem(props: MarksOptions) {
  const b = useBrowserMessages();
  const [open, setOpen] = createSignal(false);
  const label = () => (props.kind === "recent" ? b().recent : b().favorites);
  return (
    <AppWorkspace.SidebarItem
      icon={props.kind === "recent" ? "ti ti-clock" : "ti ti-star"}
      preview={{
        label: label(),
        trigger: "row",
        viewportSize: "compact",
        onOpenChange: setOpen,
        content: (close) => <MarksMenu {...props} open={open()} close={close} />,
      }}
    >
      {label()}
    </AppWorkspace.SidebarItem>
  );
}

export function openMarksDialog(options: MarksOptions & { title: string; signal?: AbortSignal }) {
  return prompts.dialog<void>(
    (close) => (
      <ScrollArea viewportSize="compact">
        <MarksMenu {...options} open close={close} modal />
      </ScrollArea>
    ),
    { title: options.title, header: false, size: "medium", signal: options.signal },
  );
}
