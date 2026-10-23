import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import { Button, IconButtonLink, InlineGuidance, ScrollArea, Skeleton, TextInput, toast, useLocale } from "@k2b/ui";
import { createEffect, createSignal, For, type JSX, on, onCleanup, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { z } from "zod";
import { chatMessages } from "../messages";
import type { ConversationPageSchema } from "../service/contracts";
import { createChannelApi } from "./channel-api";

type Page = z.infer<typeof ConversationPageSchema>;

/** The discoverable catalog is a reloadable workspace page; membership changes refresh the canonical sidebar. */
export default function DiscoverChannels(props: {
  initial?: Page | null;
  query: string;
  revision: number;
  onQuery: (query: string) => void;
  onSubscribe: (id: string) => Promise<void>;
  onOpen: (id: string) => Promise<void>;
  onBack: (navigation: LinkNavigateEvent) => Promise<void>;
}): JSX.Element {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  const api = createChannelApi();
  const initial = props.initial;
  const [search, setSearch] = createSignal(props.query);
  const [rows, setRows] = createStore<Page["items"]>(initial?.items ?? []);
  const [cursor, setCursor] = createSignal(initial?.nextCursor ?? null);
  const [busy, setBusy] = createSignal(initial === undefined);
  const [error, setError] = createSignal(initial === null);
  const [pending, setPending] = createSignal<readonly string[]>([]);
  let generation = 0;
  let request: AbortController | undefined;
  let retryMore = false;
  let disposed = false;
  const notices = new Set<ReturnType<typeof toast>>();
  const load = async (more = false) => {
    const mine = ++generation;
    request?.abort();
    request = new AbortController();
    const signal = request.signal;
    retryMore = more;
    const depth = rows.length;
    setBusy(true);
    setError(false);
    try {
      let page = await api.browse(props.query, more ? (cursor() ?? undefined) : undefined, signal);
      const items = [...page.items];
      // A membership refresh preserves the pages the person already opened.
      while (!more && items.length < depth && page.nextCursor && !signal.aborted) {
        page = await api.browse(props.query, page.nextCursor, signal);
        items.push(...page.items);
      }
      if (mine !== generation) return;
      setRows(reconcile(more ? [...rows, ...items] : items, { key: "id" }));
      setCursor(page.nextCursor);
    } catch {
      if (mine === generation) setError(true);
    } finally {
      if (mine === generation) setBusy(false);
    }
  };
  createEffect(
    on(search, (value) => {
      if (value.trim() === props.query) return;
      const timer = setTimeout(() => props.onQuery(value.trim()), 250);
      onCleanup(() => clearTimeout(timer));
    }),
  );
  let first = true;
  createEffect(
    on(
      () => [props.query, props.revision] as const,
      ([query], previous) => {
        setSearch(query);
        if (first && initial !== undefined) {
          first = false;
          return;
        }
        first = false;
        if (!previous || previous[0] !== query) {
          setRows([]);
          setCursor(null);
        }
        void load();
      },
    ),
  );
  onCleanup(() => {
    disposed = true;
    generation++;
    request?.abort();
    for (const notice of notices) notice.dismiss();
  });
  const subscribe = async (id: string) => {
    if (pending().includes(id)) return;
    setPending([...pending(), id]);
    try {
      await props.onSubscribe(id);
    } catch {
      if (disposed) return;
      const notice = toast.error(t().requestFailed, {
        action: {
          label: t().retry,
          onClick: () => {
            notice.dismiss();
            void subscribe(id);
          },
        },
      });
      notices.add(notice);
      for (const older of notices) {
        if (notices.size <= 3) break;
        notices.delete(older);
      }
    } finally {
      if (!disposed) setPending(pending().filter((known) => known !== id));
    }
  };
  return (
    <section class="chat-discover" aria-label={t().browseChannels}>
      <header class="chat-conversation__header">
        <span class="chat-conversation__back">
          <IconButtonLink href="/app/chat" navigation="enhanced" onNavigate={props.onBack} label={t().backToChats} tooltip={false}>
            <i class="ti ti-arrow-left" aria-hidden="true" />
          </IconButtonLink>
        </span>
        <div class="min-w-0">
          <h1 class="text-lg font-semibold">{t().browseChannels}</h1>
          <p class="text-sm text-secondary">{t().discoverSubtitle}</p>
        </div>
      </header>
      <ScrollArea class="chat-discover__body">
        <TextInput type="search" label={t().searchChannels} icon="ti ti-search" maxLength={100} value={search} onValueChange={setSearch} />
        <div aria-busy={busy()}>
          <Show when={busy() && rows.length === 0}>
            <div role="status" aria-label={t().loadingChats} class="flex flex-col gap-6 py-6">
              <For each={[0, 1, 2]}>
                {() => (
                  <div class="flex items-center gap-3">
                    <Skeleton class="h-10 w-10 rounded-full" />
                    <Skeleton class="h-10 flex-1" />
                    <Skeleton class="h-9 w-32" />
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Show when={error()}>
            <InlineGuidance tone="danger" role="alert">
              {t().channelListFailed}{" "}
              <Button variant="text" onClick={() => void load(retryMore)}>
                {t().retry}
              </Button>
            </InlineGuidance>
          </Show>
          <Show when={!busy() && !error() && rows.length === 0}>
            <p class="py-6 text-sm text-secondary" role="status">
              {props.query ? t().channelSearchEmpty({ query: props.query }) : t().noChannels}
            </p>
          </Show>
          <ul aria-label={t().channels} class="flex flex-col py-3">
            <For each={rows}>
              {(row) => {
                const member = () => row.member;
                return (
                  <li class="chat-discover__row">
                    <span class="chat-discover__icon" aria-hidden="true">
                      <i class={row.icon ?? "ti ti-hash"} />
                    </span>
                    <div class="min-w-0 flex-1">
                      <p class="truncate font-medium">{row.title}</p>
                      <p class="text-sm text-secondary">{row.purpose}</p>
                    </div>
                    <Button
                      class="chat-discover__subscribe"
                      size="sm"
                      variant={member() ? "secondary" : "primary"}
                      loading={pending().includes(row.id)}
                      onClick={() => (member() ? void props.onOpen(row.id) : void subscribe(row.id))}
                    >
                      <Show when={member()}>
                        <i class="ti ti-check" aria-hidden="true" />
                      </Show>
                      {member() ? t().subscribed : t().subscribe}
                    </Button>
                  </li>
                );
              }}
            </For>
          </ul>
          <Show when={cursor()}>
            <Button variant="text" loading={busy()} onClick={() => void load(true)}>
              {t().showMoreChannels}
            </Button>
          </Show>
        </div>
      </ScrollArea>
    </section>
  );
}
