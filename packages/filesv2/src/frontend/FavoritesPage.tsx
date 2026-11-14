import { query } from "@k2b/stdlib/solid";
import { AppWorkspace, Button, FileGrid, FileTypeIcon, IconButton, Placeholder, Skeleton, toast, useLocale } from "@k2b/ui";
import { createSignal, For, Match, Switch } from "solid-js";
import { apiClient } from "../api/client";
import type { MarkedEntry } from "../contracts";
import { useBrowserMessages } from "./browser-messages";
import { apiFailure } from "./file-preview";
import { formatWhen, type HistoryEnvironment } from "./history-actions";
import { loadFavorites } from "./history-api";
import { useHistoryMessages } from "./history-messages";

/** Where a favorite sits: its storage label, then its folders. */
export const favoritePlace = (item: MarkedEntry, bases: readonly { id: string; label: string }[]) =>
  [
    bases.find((base) => base.id === item.base.id)?.label ?? item.base.name,
    ...item.entry.path.split("/").filter(Boolean).slice(0, -1),
  ].join(" / ");

/**
 * The favorites page: every favorite this person may still reach, by name, with its place and last change. The star
 * takes one off the list at once; a failed removal brings it back and says so.
 */
export default function FavoritesPage(props: {
  /** The server's authorized list for the first view; without it the page loads its own. */
  initial: readonly MarkedEntry[] | null;
  bases: readonly { id: string; label: string }[];
  timeZone: string;
  now: string;
  onOpen: (item: MarkedEntry) => void;
  onChanged?: () => void;
}) {
  const b = useBrowserMessages();
  const h = useHistoryMessages();
  const locale = useLocale();
  const favorites = query.create({
    source: () => "favorites",
    initial: props.initial ? { source: "favorites", data: props.initial } : undefined,
    load: (_, { abortSignal }) => loadFavorites(abortSignal, b().favoritesFailed),
  });
  const [removed, setRemoved] = createSignal<ReadonlySet<string>>(new Set());
  const key = (item: MarkedEntry) => `${item.base.id}\n${item.entry.path}`;
  const rows = () => (favorites.data() ?? []).filter((item) => !removed().has(key(item)));
  const env = (): HistoryEnvironment => ({ now: props.now, timeZone: props.timeZone });
  const remove = async (item: MarkedEntry) => {
    setRemoved((current) => new Set([...current, key(item)]));
    try {
      const response = await apiClient.bases[":baseId"].favorite.$post({
        param: { baseId: item.base.id },
        json: { path: item.entry.path, favorite: false },
      });
      if (!response.ok) await apiFailure(response, b().loadFailed);
      props.onChanged?.();
    } catch (error) {
      setRemoved((current) => new Set([...current].filter((value) => value !== key(item))));
      toast.error(error instanceof Error && error.message ? error.message : h().actionFailed);
    }
  };
  return (
    <AppWorkspace.Main scroll class="filesv2-favorites">
      <Switch>
        <Match when={favorites.error() && !favorites.data()}>
          <Placeholder
            variant="panel"
            state="error"
            title={b().favoritesFailed}
            action={
              <Button variant="secondary" onClick={() => void favorites.refresh()}>
                <i class="ti ti-refresh" aria-hidden="true" />
                {b().retry}
              </Button>
            }
          />
        </Match>
        <Match when={!favorites.data()}>
          <p class="sr-only" role="status">
            {h().loading}
          </p>
          <div class="filesv2-favorites__skeleton" aria-hidden="true">
            <For each={[0, 1, 2, 3, 4, 5]}>{() => <Skeleton class="filesv2-favorites__skeleton-row" />}</For>
          </div>
        </Match>
        <Match when={rows().length === 0}>
          <Placeholder variant="panel" icon="ti ti-star" title={b().noFavoritesTitle} description={b().noFavoritesText} />
        </Match>
        <Match when={rows().length > 0}>
          <FileGrid
            layout="list"
            label={b().favorites}
            rows={rows()}
            getRowId={key}
            renderPreview={(item) => <FileTypeIcon name={item.entry.name} folder={item.entry.directory} />}
            renderLabel={(item) => item.entry.name}
            renderMeta={(item) => `${favoritePlace(item, props.bases)} · ${formatWhen(item.entry.modified, locale(), h(), env())}`}
            actionVisibility="always"
            renderActions={(item) => (
              // The same star as in the details: gold while saved, an X on hover and focus says what a click does.
              <IconButton
                size="sm"
                variant="ghost"
                class="filesv2-favorite"
                data-favorite="true"
                aria-pressed={true}
                label={b().removeFavorite}
                onClick={() => void remove(item)}
              >
                <i class="ti ti-star filesv2-favorite__star" aria-hidden="true" />
                <i class="ti ti-x filesv2-favorite__remove" aria-hidden="true" />
              </IconButton>
            )}
            onOpen={props.onOpen}
          />
        </Match>
      </Switch>
    </AppWorkspace.Main>
  );
}
