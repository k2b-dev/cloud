import { query } from "@k2b/stdlib/solid";
import { For, Show } from "solid-js";
import { isServer } from "solid-js/web";
import { revision } from "./probe-store";

export type FeedItem = { id: string; label?: string };
type FeedProps = { feed: string; items: FeedItem[] };

/** Renders like a list row that trusts the server's shape: an item without a label throws while the list updates. */
const Row = (props: { item: FeedItem }) => <li>{props.item.label!.toUpperCase()}</li>;

/** A server-rendered list that reloads through a query whenever the shared revision changes. */
export default function Feed(props: FeedProps) {
  const url = () => `/probe/${props.feed}?revision=${revision()}`;
  const feed = query.create({
    source: url,
    initial: { source: `/probe/${props.feed}?revision=1`, data: props.items },
    load: async (source, { abortSignal }) => (await fetch(source, { signal: abortSignal })).json() as Promise<FeedItem[]>,
  });
  return (
    <section data-feed={props.feed} data-mounted={isServer ? undefined : ""}>
      <Show when={feed.data()}>
        {(items) => (
          <ul>
            <For each={items()}>{(item) => <Row item={item} />}</For>
          </ul>
        )}
      </Show>
    </section>
  );
}
