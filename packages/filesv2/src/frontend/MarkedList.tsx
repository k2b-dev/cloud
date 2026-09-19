import { AppWorkspace, Button, DataTable, Format, Placeholder, toast } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { apiClient } from "../api/client";
import type { MarkedEntry } from "../contracts";
import { useBrowserMessages } from "./browser-messages";
import { apiFailure, fileIcon } from "./file-preview";
import { useFilesMessages } from "./messages";

/** Recently opened entries or favorites across every reachable base; opening one jumps to its folder. */
export default function MarkedList(props: { kind: "recent" | "favorites"; items: MarkedEntry[]; onOpen: (item: MarkedEntry) => void }) {
  const b = useBrowserMessages();
  const t = useFilesMessages();
  const [removed, setRemoved] = createSignal<ReadonlySet<string>>(new Set());
  const key = (item: MarkedEntry) => `${item.base.id}\n${item.entry.path}`;
  const items = () => props.items.filter((item) => !removed().has(key(item)));
  const unmark = async (item: MarkedEntry) => {
    try {
      const response = await apiClient.bases[":baseId"].favorite.$post({ param: { baseId: item.base.id }, json: { path: item.entry.path, favorite: false } });
      if (!response.ok) await apiFailure(response, t().unavailable);
      setRemoved((current) => new Set([...current, key(item)]));
      toast.success(b().favoriteRemoved);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().unavailable);
    }
  };
  return (
    <AppWorkspace.Main scroll class="filesv2-browser">
      <header class="filesv2-browser__header">
        <div class="min-w-0">
          <h1 class="truncate text-base font-semibold text-primary">{props.kind === "recent" ? b().recent : b().favorites}</h1>
        </div>
      </header>
      <Show
        when={items().length}
        fallback={
          <Placeholder
            class="mx-3 flex-1"
            variant="panel"
            icon={props.kind === "recent" ? "ti ti-history" : "ti ti-star"}
            title={props.kind === "recent" ? b().recent : b().favorites}
            description={props.kind === "recent" ? b().noRecent : b().noFavorites}
          />
        }
      >
        <DataTable
          class="mx-3 mb-3"
          rows={items()}
          getRowId={key}
          density="compact"
          highlightColumns={false}
          ariaLabel={props.kind === "recent" ? b().recent : b().favorites}
          onRowClick={(row) => props.onOpen(row)}
          columns={[
            { id: "name", header: t().name },
            { id: "location", header: b().location },
            ...(props.kind === "recent" ? [{ id: "opened", header: b().openedAt }] : []),
            { id: "actions", header: <span class="sr-only">{t().actions}</span>, align: "right" as const },
          ]}
          renderCell={({ row, col }) => {
            if (col.id === "name")
              return (
                <span class="flex min-w-0 items-center gap-2">
                  <i class={`${fileIcon(row.entry)} text-lg text-secondary`} aria-hidden="true" />
                  <span class="truncate font-medium">{row.entry.name}</span>
                </span>
              );
            if (col.id === "location") return <span class="truncate text-xs text-dimmed">{`${row.base.name} / ${row.entry.path}`}</span>;
            if (col.id === "opened") return <Format.DateTime value={row.markedAt} />;
            return (
              <Show when={props.kind === "favorites"}>
                <Button size="xs" variant="ghost" aria-label={b().removeFavorite} onClick={(event: MouseEvent) => (event.stopPropagation(), void unmark(row))}>
                  <i class="ti ti-star-off" aria-hidden="true" />
                </Button>
              </Show>
            );
          }}
        />
      </Show>
    </AppWorkspace.Main>
  );
}
