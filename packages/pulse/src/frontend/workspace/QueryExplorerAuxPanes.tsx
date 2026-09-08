import { Button, IconButton, ScrollArea, Tooltip } from "@k2b/ui";
import { type Accessor, For, Show } from "solid-js";
import type { PulseSavedQuery } from "../../contracts";
import { usePulseMessages } from "../use-messages";
import { compactDateWithDelta, type PulseDateContext } from "./helpers";
import type { QueryHistoryEntry } from "./types";

export function SavedQueriesPane(props: {
  queries: Accessor<PulseSavedQuery[]>;
  currentQuery: Accessor<string>;
  loading: Accessor<boolean>;
  onSelect: (query: string) => void;
  onSaveCurrent: () => void | Promise<void>;
  onRemove: (query: PulseSavedQuery) => void | Promise<void>;
}) {
  const t = usePulseMessages();
  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden">
      <div class="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <span class="text-label text-xs">{t().savedQueries}</span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={!props.currentQuery() || props.loading()}
          onClick={() => void props.onSaveCurrent()}
        >
          <i class="ti ti-device-floppy" /> {t().saveCurrent}
        </Button>
      </div>
      <ScrollArea class="min-h-0 flex-1 px-2 pb-2">
        <Show when={props.queries().length > 0} fallback={<p class="px-1 py-2 text-xs text-dimmed">{t().noSavedQueries}</p>}>
          <For each={props.queries()}>
            {(item) => (
              <div class="group flex items-start gap-2 rounded px-2 py-2 hover:bg-zinc-100 dark:hover:bg-zinc-900">
                <button type="button" class="min-w-0 flex-1 text-left" onClick={() => props.onSelect(item.query)}>
                  <span class="block truncate text-sm font-medium text-secondary">{item.name}</span>
                  <code class="block truncate font-mono text-[11px] text-dimmed">{item.query}</code>
                </button>
                <Tooltip.Anchor content={t().removeSavedQuery}>
                  <IconButton
                    label={t().removeNamedSavedQuery({ name: item.name })}
                    variant="ghost"
                    size="xs"
                    class="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                    onClick={() => void props.onRemove(item)}
                  >
                    <i class="ti ti-trash" />
                  </IconButton>
                </Tooltip.Anchor>
              </div>
            )}
          </For>
        </Show>
      </ScrollArea>
    </div>
  );
}

export function QueryHistoryPane(props: {
  history: Accessor<QueryHistoryEntry[]>;
  dateContext: Accessor<PulseDateContext>;
  onSelect: (query: string) => void;
}) {
  const t = usePulseMessages();
  return (
    <ScrollArea class="h-full min-h-0 p-2">
      <Show when={props.history().length > 0} fallback={<p class="px-1 py-2 text-xs text-dimmed">{t().noRunsYet}</p>}>
        <For each={props.history()}>
          {(item) => (
            <button
              type="button"
              class="block w-full rounded px-2 py-2 text-left hover:bg-zinc-100 dark:hover:bg-zinc-900"
              onClick={() => props.onSelect(item.query)}
            >
              <code class="block truncate font-mono text-[11px] text-secondary">{item.query}</code>
              <span class="text-[11px] text-dimmed">{compactDateWithDelta(item.ranAt, props.dateContext())}</span>
            </button>
          )}
        </For>
      </Show>
    </ScrollArea>
  );
}
