import { query } from "@k2b/stdlib/solid";
import { Button, Format, NoticeCard, Placeholder } from "@k2b/ui";
import { createSignal, createUniqueId, For, Show } from "solid-js";
import { usePulseMessages } from "../use-messages";
import { type SavedQuery, sqlClient } from "./sql-client";

export default function SavedQueriesView(props: {
  base: { id: string; name: string };
  onSelect: (query: SavedQuery) => void;
  onBackToConsole: () => void;
}) {
  const t = usePulseMessages();
  const [offset, setOffset] = createSignal(0);
  const saved = query.create({
    source: () => ({ baseId: props.base.id, offset: offset() }),
    isSameSource: (a, b) => a.baseId === b.baseId && a.offset === b.offset,
    load: (source, { abortSignal }) => sqlClient.list(source.baseId, { limit: 50, offset: source.offset }, abortSignal),
  });
  return (
    <section class="flex min-h-80 flex-col gap-3">
      <p class="text-sm text-secondary">{t().sqlSavedListHint({ base: props.base.name })}</p>
      <Show when={saved.error()}>
        <NoticeCard tone="danger" title={t().sqlSavedLoadFailed}>
          <Button variant="secondary" onClick={() => void saved.refresh()}>
            {t().retry}
          </Button>
        </NoticeCard>
      </Show>
      <Show when={saved.loading()}>
        <p role="status" class="text-sm text-secondary">
          {t().sqlSavedLoading}
        </p>
      </Show>
      <ul
        class="m-0 flex max-w-[860px] list-none flex-col gap-0.5 p-0"
        aria-label={t().sqlSavedQueries}
        aria-busy={saved.loading() || undefined}
      >
        <For each={saved.data()?.items ?? []}>
          {(row) => {
            const descriptionId = createUniqueId();
            const excerpt = () =>
              row.sql
                .split("\n")
                .find((line) => /^\s*SELECT\b/i.test(line))
                ?.trim() ??
              row.sql.trim().split("\n")[0] ??
              "";
            return (
              <li class="min-w-0">
                <Button
                  variant="ghost"
                  align="start"
                  wrap
                  class="min-h-16 w-full rounded-[10px] px-2.5 py-1.5"
                  aria-label={row.name}
                  aria-describedby={descriptionId}
                  onClick={() => props.onSelect(row)}
                >
                  <span class="grid w-full min-w-0 grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3">
                    <i class="ti ti-file-code text-lg text-secondary" aria-hidden="true" />
                    <span class="min-w-0">
                      <span class="block text-[14.5px] font-semibold">{row.name}</span>
                      <span id={descriptionId} class="block text-[12.5px] font-normal text-secondary">
                        <span class="block truncate font-mono!">{excerpt()}</span>
                        <span class="block">
                          {t().sqlSavedUpdatedLabel} <Format.DateTime value={row.updatedAt} />
                        </span>
                      </span>
                    </span>
                    <i class="ti ti-chevron-right text-lg text-secondary" aria-hidden="true" />
                  </span>
                </Button>
              </li>
            );
          }}
        </For>
      </ul>
      <Show when={!saved.loading() && !saved.error() && saved.data()?.items.length === 0}>
        <Placeholder
          icon="ti ti-bookmark"
          title={t().sqlSavedEmpty({ base: props.base.name })}
          description={t().sqlSavedEmptyHint}
          action={
            <Button variant="secondary" onClick={props.onBackToConsole}>
              {t().sqlBackToConsole}
            </Button>
          }
        />
      </Show>
      <Show when={offset() > 0 || saved.data()?.nextOffset != null}>
        <div class="flex gap-2">
          <Button variant="secondary" disabled={offset() === 0 || saved.loading()} onClick={() => setOffset(Math.max(0, offset() - 50))}>
            {t().sqlPrevious}
          </Button>
          <Button
            variant="secondary"
            disabled={saved.data()?.nextOffset == null || saved.loading()}
            onClick={() => setOffset(saved.data()?.nextOffset ?? offset())}
          >
            {t().sqlNext}
          </Button>
        </div>
      </Show>
    </section>
  );
}
