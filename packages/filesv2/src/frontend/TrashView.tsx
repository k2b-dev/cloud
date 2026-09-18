import { AppWorkspace, Button, ButtonLink, Format, Placeholder, toast } from "@k2b/ui";
import { createResource, createSignal, For, Show } from "solid-js";
import { apiClient } from "../api/client";
import type { BaseSummary, TrashEntry } from "../contracts";
import { useBrowserMessages } from "./browser-messages";
import { apiFailure } from "./file-preview";
import { useFilesMessages } from "./messages";
import { filesUrl } from "./urls";

/** Trashed entries of one base with a single action: put them back. */
export default function TrashView(props: { base: BaseSummary; onRestored: (path: string) => void }) {
  const b = useBrowserMessages();
  const t = useFilesMessages();
  const [version, setVersion] = createSignal(0);
  const [entries] = createResource(
    () => ({ baseId: props.base.id, version: version() }),
    async ({ baseId }) => {
      const response = await apiClient.bases[":baseId"].trash.$get({ param: { baseId } });
      if (!response.ok) await apiFailure(response, t().unavailable);
      return (await response.json()).entries as TrashEntry[];
    },
  );
  const [busy, setBusy] = createSignal<string | null>(null);
  const restore = async (entry: TrashEntry) => {
    setBusy(entry.id);
    try {
      const response = await apiClient.bases[":baseId"].trash[":id"].restore.$post({ param: { baseId: props.base.id, id: entry.id } });
      if (!response.ok) await apiFailure(response, t().unavailable);
      toast.success(b().restored(entry.name));
      props.onRestored((await response.json()).entry.path);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().unavailable);
      setVersion((value) => value + 1);
    } finally {
      setBusy(null);
    }
  };
  return (
    <AppWorkspace.Main class="filesv2-browser" scroll>
      <header class="filesv2-browser__header">
        <div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <div class="min-w-0">
            <h1 class="truncate text-base font-semibold text-primary">{b().trashTitle}</h1>
            <p class="mt-0.5 text-xs text-dimmed">{b().trashDescription}</p>
          </div>
          <ButtonLink size="sm" variant="secondary" href={filesUrl(props.base.id)}>
            <i class="ti ti-arrow-left" aria-hidden="true" />
            {b().backToFiles}
          </ButtonLink>
        </div>
      </header>
      <Show
        when={!entries.loading}
        fallback={<Placeholder class="flex-1" variant="panel" state="loading" description={t().loadingFiles} />}
      >
        <Show when={!entries.error} fallback={<Placeholder class="flex-1" variant="panel" state="error" description={b().loadFailed} />}>
          <Show
            when={entries()?.length}
            fallback={<Placeholder class="flex-1" variant="panel" icon="ti ti-trash" title={b().trashEmpty} />}
          >
            <div class="filesv2-list" role="list">
              <For each={entries()}>
                {(entry) => (
                  <div role="listitem" class="filesv2-list__row">
                    <span class="filesv2-list__cell filesv2-list__cell--info">
                      <i class={entry.directory ? "ti ti-folder" : "ti ti-file"} aria-hidden="true" />
                    </span>
                    <span class="filesv2-list__cell filesv2-list__cell--name">
                      <span class="flex min-w-0 flex-col">
                        <span class="filesv2-list__name">{entry.name}</span>
                        <span class="text-xs text-dimmed">
                          {b().originalLocation}: /{entry.original}
                        </span>
                      </span>
                    </span>
                    <span class="filesv2-list__cell filesv2-list__cell--modified">
                      <Format.DateTime value={entry.deletedAt} />
                    </span>
                    <span class="filesv2-list__cell">
                      <Button size="xs" variant="secondary" loading={busy() === entry.id} onClick={() => void restore(entry)}>
                        <i class="ti ti-arrow-back-up" aria-hidden="true" />
                        {b().restore}
                      </Button>
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>
    </AppWorkspace.Main>
  );
}
