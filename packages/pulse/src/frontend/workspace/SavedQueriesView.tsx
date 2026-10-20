import { query } from "@k2b/stdlib/solid";
import { Button, DataTable, NoticeCard, Placeholder } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { usePulseMessages } from "../use-messages";
import { type SavedQuery, sqlClient } from "./sql-client";

export default function SavedQueriesView(props: { base: { id: string; name: string }; onSelect: (query: SavedQuery) => void }) {
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
      <DataTable
        rows={saved.data()?.items ?? []}
        columns={[{ id: "name", header: t().name, value: "name" }]}
        loading={saved.loading()}
        surface="plain"
        ariaLabel={t().sqlSavedQueries}
        renderCell={({ row }) => (
          <Button variant="ghost" onClick={() => props.onSelect(row)}>
            {row.name}
          </Button>
        )}
        empty={<Placeholder icon="ti ti-code" title={t().sqlSavedEmpty({ base: props.base.name })} description={t().sqlSavedEmptyHint} />}
      />
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
    </section>
  );
}
