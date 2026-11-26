import { query } from "@k2b/stdlib/solid";
import { toast, useLocale } from "@k2b/ui";
import { Button, Failed, Icon, Inline, type OnNavigate, Pane, StatusRow, Table, Text } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { apiClient } from "../api/client";
import type { MarkedEntry } from "../contracts";
import { useBrowserMessages } from "./browser-messages";
import { entryIcon } from "./entry-icon";
import { favoritePlace } from "./favorite-place";
import { apiFailure } from "./file-preview";
import { formatWhen } from "./history-actions";
import { loadFavorites } from "./history-api";
import { useHistoryMessages } from "./history-messages";
import { filesUrl } from "./urls";

const keyOf = (item: MarkedEntry) => `${item.base.id}\n${item.entry.path}`;

/** Where a favorite opens: a folder itself, a file beside its folder's listing. */
export const favoriteHref = (item: MarkedEntry) =>
  item.entry.directory
    ? filesUrl(item.base.id, item.entry.path)
    : filesUrl(item.base.id, item.entry.path.split("/").slice(0, -1).join("/"), null, item.entry.path);

/**
 * Every favorite this person may still reach, across storage, with its place and last change. The star takes one off
 * the list at once; a failed removal brings it back and says so.
 */
export default function FavoritesPane(props: {
  /** The server's authorized list for the first picture; without it the pane loads its own. */
  initial: readonly MarkedEntry[] | null;
  bases: readonly { id: string; label: string }[];
  now: string;
  timeZone: string;
  onNavigate: OnNavigate;
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
  const rows = () => (favorites.data() ?? []).filter((item) => !removed().has(keyOf(item)));
  const when = (item: MarkedEntry) => formatWhen(item.entry.modified, locale(), h(), { now: props.now, timeZone: props.timeZone });
  const remove = async (item: MarkedEntry) => {
    setRemoved((current) => new Set([...current, keyOf(item)]));
    try {
      const response = await apiClient.bases[":baseId"].favorite.$post({
        param: { baseId: item.base.id },
        json: { path: item.entry.path, favorite: false },
      });
      if (!response.ok) await apiFailure(response, b().loadFailed);
    } catch (error) {
      setRemoved((current) => new Set([...current].filter((value) => value !== keyOf(item))));
      toast.error(error instanceof Error && error.message ? error.message : h().actionFailed);
    }
  };
  return (
    <Pane
      label={b().favorites}
      scrollKey="filesv2-favorites"
      status={
        <StatusRow lead={favorites.data() ? b().v2Favorites({ count: rows().length }) : b().favorites} loading={favorites.loading()} />
      }
    >
      <Show
        when={!(favorites.error() && !favorites.data())}
        fallback={<Failed text={b().favoritesFailed} onRetry={() => void favorites.refresh()} />}
      >
        <Table
          label={b().favorites}
          rows={rows()}
          rowKey={keyOf}
          loading={favorites.data() ? undefined : { rows: 6, lines: 2 }}
          empty={{ icon: "star", text: b().noFavoritesText }}
          open={(item) => ({ href: favoriteHref(item), onNavigate: props.onNavigate })}
          phone={(item) => ({ lines: [item.entry.name, favoritePlace(item, props.bases)], time: when(item) })}
          columns={[
            {
              title: b().v2Name,
              width: { min: 200, default: 300 },
              cell: (item) => (
                <Inline>
                  <Icon name={entryIcon(item.entry)} />
                  <Text>{item.entry.name}</Text>
                </Inline>
              ),
            },
            { title: b().v2Place, width: { min: 160, default: 260 }, drop: true, cell: (item) => favoritePlace(item, props.bases) },
            { title: b().v2Changed, width: { min: 110, default: 150 }, drop: true, cell: when },
            {
              title: b().v2Deeds,
              cell: (item) => <Button variant="ghost" icon="star" pressed label={b().removeFavorite} onClick={() => void remove(item)} />,
            },
          ]}
        />
      </Show>
    </Pane>
  );
}
