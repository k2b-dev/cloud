import { type DateContext, dates } from "@k2b/stdlib";
import { query } from "@k2b/stdlib/solid";
import { Button, DetailPanel, Skeleton } from "@k2b/ui";
import { createSignal, For, type JSX, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { readResponseError } from "../../../lib/response";
import { useSpaceMessages } from "../../messages";

/** One page bounds the panel. Oldest first, like the story of the item; the rest waits behind one click. */
const HISTORY_LIMIT = 30;
const COLLAPSED = 4;

type Props = {
  spaceId: string;
  itemId: string;
  /** A newer edit reloads the history. */
  version: string;
  dateConfig?: DateContext;
};

/** Puts the origin's link around its name inside the worded sentence, so every language keeps its own word order. */
const withOriginLink = (sentence: string, origin: { name: string; href: string | null } | undefined): JSX.Element => {
  const at = origin?.href ? sentence.indexOf(origin.name) : -1;
  if (!origin || at < 0) return sentence;
  return (
    <>
      {sentence.slice(0, at)}
      <a class="k2b-link" href={origin.href ?? undefined}>
        {origin.name}
      </a>
      {sentence.slice(at + origin.name.length)}
    </>
  );
};

/** What happened to this item, and who or what did it. */
export default function ItemHistorySection(props: Props) {
  const t = useSpaceMessages();
  const [expanded, setExpanded] = createSignal(false);
  const history = query.create<
    string,
    {
      row: {
        id: string;
        at: string;
        icon: string;
        sentence: string;
        count: number;
        origin?: { name: string; href: string | null; runHref: string | null };
      };
    }[]
  >({
    source: () => `${props.spaceId}/${props.itemId}/${props.version}`,
    load: async (_source, { abortSignal }) => {
      const response = await apiClient[":id"].items[":itemId"].activity.$get(
        { param: { id: props.spaceId, itemId: props.itemId }, query: { limit: String(HISTORY_LIMIT) } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readResponseError(response, t.historyFailed));
      return (await response.json()).data;
    },
  });
  const rows = () => [...(history.data() ?? [])].reverse().map((entry) => entry.row);
  const visible = () => (expanded() ? rows() : rows().slice(0, COLLAPSED));

  return (
    <DetailPanel.Section title={t.history} meta={history.data() ? String(rows().length) : undefined}>
      <Show
        when={history.data()}
        fallback={
          <Show
            when={history.error()}
            fallback={
              <div class="grid gap-2" role="status" aria-label={t.history}>
                <Skeleton class="h-3 w-4/5" />
                <Skeleton class="h-3 w-3/5" />
              </div>
            }
          >
            <div class="flex flex-wrap items-center gap-2 text-sm text-dimmed">
              <span>{t.historyFailed}</span>
              <Button size="sm" variant="secondary" type="button" onClick={() => void history.refresh()}>
                <i class="ti ti-refresh" aria-hidden="true" />
                {t.historyRetry}
              </Button>
            </div>
          </Show>
        }
      >
        <ul class="grid gap-2">
          <For each={visible()}>
            {(row) => (
              <li class="flex items-start gap-2 text-sm">
                <i class={`${row.icon} mt-0.5 text-dimmed`} aria-hidden="true" />
                <span class="min-w-0">
                  {withOriginLink(row.sentence, row.origin)}
                  <span class="block text-xs text-dimmed">
                    {dates.formatDateTime(row.at, props.dateConfig)}
                    <Show when={row.origin?.runHref}>
                      {(href) => (
                        <>
                          {" · "}
                          <a class="k2b-link" href={href()}>
                            {t.historyOpenRun}
                          </a>
                        </>
                      )}
                    </Show>
                  </span>
                </span>
              </li>
            )}
          </For>
        </ul>
        <Show when={!expanded() && rows().length > COLLAPSED}>
          <Button class="mt-2 w-fit" size="sm" variant="ghost" type="button" onClick={() => setExpanded(true)}>
            {t.historyShowAll({ n: rows().length })}
          </Button>
        </Show>
      </Show>
    </DetailPanel.Section>
  );
}
