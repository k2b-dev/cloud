import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import { AppWorkspace, Button, ButtonLink, Format, InlineGuidance, Placeholder, prompts, toast } from "@k2b/ui";
import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../api/client";
import type { BaseSummary, TrashEntry } from "../contracts";
import { useBrowserMessages } from "./browser-messages";
import { apiFailure } from "./file-preview";
import { useFilesMessages } from "./messages";
import { useTrashMessages } from "./trash-messages";
import { filesUrl } from "./urls";

/** Trash is recoverable; permanent deletion belongs exclusively to administration. */
export default function TrashView(props: {
  base: BaseSummary;
  onRestored: (path: string) => void;
  onNavigate?: (event: LinkNavigateEvent) => void;
}) {
  const b = useBrowserMessages();
  const t = useFilesMessages();
  const text = useTrashMessages();
  const [version, setVersion] = createSignal(0);
  const baseKey = () => props.base.locationKey ?? props.base.id;
  const [after, setAfter] = createSignal<{ baseKey: string; value: string } | null>(null);
  let pending: AbortController | undefined;
  const lifetime = new AbortController();
  let accumulated: { baseKey: string; entries: TrashEntry[] } = { baseKey: "", entries: [] };
  const [page] = createResource(
    () => ({
      baseId: props.base.id,
      baseKey: baseKey(),
      after: after()?.baseKey === baseKey() ? after()?.value : undefined,
      version: version(),
    }),
    async ({ baseId, baseKey, after }) => {
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      const response = await apiClient.bases[":baseId"].trash.$get(
        { param: { baseId }, query: { after } },
        { init: { signal: controller.signal } },
      );
      if (!response.ok) await apiFailure(response, t().unavailable);
      const result = await response.json();
      controller.signal.throwIfAborted();
      const entries = after && accumulated.baseKey === baseKey ? [...accumulated.entries, ...result.entries] : result.entries;
      accumulated = { baseKey, entries: [...new Map(entries.map((entry) => [entry.id, entry])).values()] };
      return { ...accumulated, next: result.next };
    },
  );
  onCleanup(() => {
    pending?.abort();
    lifetime.abort();
  });
  const refresh = () => {
    setAfter(null);
    setVersion((value) => value + 1);
  };
  const [busy, setBusy] = createSignal<string | null>(null);
  const restore = async (entry: TrashEntry) => {
    if (busy()) return;
    const baseId = props.base.id;
    const sourceKey = baseKey();
    setBusy(entry.id);
    try {
      const values = await prompts.form({
        title: b().restore,
        signal: lifetime.signal,
        fields: {
          path: {
            type: "text",
            label: text().restorePath,
            description: text().restoreHint,
            default: entry.original ?? entry.name,
            required: true,
            maxLength: 4096,
          },
        },
      });
      if (!values || baseKey() !== sourceKey) return;
      const response = await apiClient.bases[":baseId"].trash[":id"].restore.$post(
        { param: { baseId, id: entry.id }, query: { path: values.path } },
        { init: { signal: lifetime.signal } },
      );
      if (!response.ok) await apiFailure(response, t().unavailable);
      const result = await response.json();
      if (baseKey() !== sourceKey || lifetime.signal.aborted) return;
      toast.success(b().restored(entry.name));
      props.onRestored(result.entry.path);
      refresh();
    } catch (error) {
      if (baseKey() === sourceKey && !lifetime.signal.aborted) {
        toast.error(error instanceof Error ? error.message : t().unavailable);
        refresh();
      }
    } finally {
      setBusy(null);
    }
  };
  const visible = () => (page()?.baseKey === baseKey() ? page()?.entries : undefined);
  return (
    <AppWorkspace.Main class="filesv2-browser" scroll>
      <header class="filesv2-browser__header">
        <div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <div class="min-w-0">
            <h1 class="truncate text-base font-semibold text-primary">{b().trashTitle}</h1>
            <p class="mt-0.5 text-xs text-dimmed">{b().trashDescription}</p>
          </div>
          <div class="flex items-center gap-2">
            <Button size="sm" variant="secondary" loading={page.loading} onClick={refresh}>
              {text().retry}
            </Button>
            <ButtonLink size="sm" variant="secondary" href={filesUrl(props.base.id)} navigation="enhanced" onNavigate={props.onNavigate}>
              <i class="ti ti-arrow-left" aria-hidden="true" />
              {b().backToFiles}
            </ButtonLink>
          </div>
        </div>
      </header>
      <Show
        when={!page.loading || visible()}
        fallback={<Placeholder class="flex-1" variant="panel" state="loading" description={t().loadingFiles} />}
      >
        <Show when={!page.error} fallback={<Placeholder class="flex-1" variant="panel" state="error" description={b().loadFailed} />}>
          <Show
            when={visible()?.length}
            fallback={<Placeholder class="flex-1" variant="panel" icon="ti ti-trash" title={b().trashEmpty} />}
          >
            <div class="filesv2-list" role="list">
              <For each={visible()}>
                {(entry) => (
                  <div role="listitem" class="filesv2-list__row">
                    <span class="filesv2-list__cell filesv2-list__cell--info">
                      <i class={entry.directory ? "ti ti-folder" : "ti ti-file"} aria-hidden="true" />
                    </span>
                    <span class="filesv2-list__cell filesv2-list__cell--name">
                      <span class="flex min-w-0 flex-col gap-1">
                        <span class="filesv2-list__name">{entry.name}</span>
                        <span class="text-xs text-dimmed">
                          {entry.original ? `${b().originalLocation}: /${entry.original}` : text().unknownOriginal}
                        </span>
                        <Show when={entry.state === "pending" || entry.state === "restoring"}>
                          <InlineGuidance tone="warning">{text().unresolved}</InlineGuidance>
                        </Show>
                      </span>
                    </span>
                    <span class="filesv2-list__cell filesv2-list__cell--modified">
                      <Show when={entry.deletedAt} fallback={<span class="text-xs text-dimmed">{text().unknownDate}</span>}>
                        {(date) => <Format.DateTime value={date()} />}
                      </Show>
                    </span>
                    <span class="filesv2-list__cell">
                      <Button
                        size="xs"
                        variant="secondary"
                        loading={busy() === entry.id}
                        disabled={Boolean(busy()) || entry.state === "pending"}
                        onClick={() => void restore(entry)}
                      >
                        <i class="ti ti-arrow-back-up" aria-hidden="true" />
                        {b().restore}
                      </Button>
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Show when={page()?.next}>
            {(next) => (
              <div class="flex justify-center p-3">
                <Button variant="secondary" loading={page.loading} onClick={() => setAfter({ baseKey: baseKey(), value: next() })}>
                  {b().more}
                </Button>
              </div>
            )}
          </Show>
        </Show>
      </Show>
    </AppWorkspace.Main>
  );
}
