import { query } from "@k2b/stdlib/solid";
import { Button, Format, NoticeCard, Placeholder } from "@k2b/ui";
import { createSignal, createUniqueId, For, Show } from "solid-js";
import { usePulseMessages } from "../use-messages";
import { type SavedQuery, SqlClientError, sqlClient } from "./sql-client";

export default function SavedQueriesView(props: {
  base: { id: string; name: string };
  onSelect: (query: SavedQuery) => void;
  onBackToConsole: () => void;
}) {
  const t = usePulseMessages();
  const [offset, setOffset] = createSignal(0);
  const [accessLost, setAccessLost] = createSignal(false);
  const saved = query.create({
    source: () => ({ baseId: props.base.id, offset: offset() }),
    isSameSource: (a, b) => a.baseId === b.baseId && a.offset === b.offset,
    load: async (source, { abortSignal }) => {
      try {
        const result = await sqlClient.list(source.baseId, { limit: 50, offset: source.offset }, abortSignal);
        if (!abortSignal.aborted) setAccessLost(false);
        return result;
      } catch (error) {
        if (!abortSignal.aborted && error instanceof SqlClientError && [401, 403, 404].includes(error.status)) setAccessLost(true);
        throw error;
      }
    },
  });
  const reading = () => saved.loading() || saved.refreshing();
  const protectedRows = () => {
    const error = saved.error();
    return accessLost() || (error instanceof SqlClientError && [401, 403, 404].includes(error.status)) ? [] : (saved.data()?.items ?? []);
  };
  return (
    <section class="flex min-h-80 flex-col gap-3">
      <p class="text-sm text-secondary">{t().sqlSavedListHint({ base: props.base.name })}</p>
      <Show when={saved.error()}>
        <NoticeCard tone="danger" title={t().sqlSavedLoadFailed}>
          <Button variant="secondary" onClick={() => void saved.refresh().catch(() => undefined)}>
            {t().retry}
          </Button>
        </NoticeCard>
      </Show>
      <Show when={reading()}>
        <p role="status" class="text-sm text-secondary">
          {t().sqlSavedLoading}
        </p>
      </Show>
      <ul class="m-0 flex max-w-[860px] list-none flex-col gap-0.5 p-0" aria-label={t().sqlSavedQueries} aria-busy={reading() || undefined}>
        <For each={protectedRows()}>
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
      <Show when={!reading() && !saved.error() && saved.data()?.items.length === 0}>
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
      <Show when={!accessLost() && (offset() > 0 || saved.data()?.nextOffset != null)}>
        <div class="flex gap-2">
          <Button variant="secondary" disabled={offset() === 0 || reading()} onClick={() => setOffset(Math.max(0, offset() - 50))}>
            {t().sqlPrevious}
          </Button>
          <Button
            variant="secondary"
            disabled={saved.data()?.nextOffset == null || reading()}
            onClick={() => setOffset(saved.data()?.nextOffset ?? offset())}
          >
            {t().sqlNext}
          </Button>
        </div>
      </Show>
    </section>
  );
}
