import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { Button, IconButtonLink, InlineGuidance, ScrollArea, Skeleton, useLocale } from "@k2b/ui";
import { createEffect, createSignal, For, type JSX, on, onCleanup, Show } from "solid-js";
import type { z } from "zod";
import { chatMessages } from "../messages";
import type { ForYouItemSchema, ForYouPageSchema } from "../service/contracts";
import { listTime } from "./chat-format";
import { createForYouApi } from "./for-you-api";
import { threadHref } from "./threads";

type Page = z.infer<typeof ForYouPageSchema>;
export type ForYouItem = z.infer<typeof ForYouItemSchema>;

/**
 * Mentions of and replies to the reader in every chat they may read, Space and notebook chats included, newest first.
 * A row opens its thread at the message; reading it there clears its unread state, and the page reads again.
 */
export default function ForYou(props: {
  /** The server's first page; `null` when it could not be read, absent when the page opened in the browser. */
  initial?: Page | null;
  /** Changes when a mention or reply arrives or is read. */
  revision: number;
  basePath: string;
  dateConfig: DateContext;
  now: () => Date;
  /** Opens the item's thread at its message in place; a modified click opens the link as usual. */
  onOpen: (item: ForYouItem) => Promise<void> | void;
  onBack: (navigation: LinkNavigateEvent) => Promise<void>;
}): JSX.Element {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  const api = createForYouApi();
  const [items, setItems] = createSignal<readonly ForYouItem[]>(props.initial?.items ?? []);
  const [cursor, setCursor] = createSignal(props.initial?.nextCursor ?? null);
  const [status, setStatus] = createSignal<"loading" | "ready" | "failed">(
    props.initial === undefined ? "loading" : props.initial === null ? "failed" : "ready",
  );
  const [loadingMore, setLoadingMore] = createSignal(false);
  let request: AbortController | undefined;
  onCleanup(() => request?.abort());
  /** Reads as deep as the reader has loaded, so a refresh keeps the rows they scrolled to. */
  const load = async (more = false) => {
    request?.abort();
    const current = new AbortController();
    request = current;
    if (more) setLoadingMore(true);
    else if (items().length === 0) setStatus("loading");
    try {
      if (more) {
        const next = cursor();
        if (!next) return;
        const page = await api.list(next, current.signal);
        setItems((rows) => [...rows, ...page.items]);
        setCursor(page.nextCursor);
      } else {
        const depth = Math.max(items().length, 1);
        let page = await api.list(undefined, current.signal);
        const rows = [...page.items];
        while (rows.length < depth && page.nextCursor && !current.signal.aborted) {
          page = await api.list(page.nextCursor, current.signal);
          rows.push(...page.items);
        }
        setItems(rows);
        setCursor(page.nextCursor);
      }
      setStatus("ready");
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) setStatus("failed");
    } finally {
      if (request === current) setLoadingMore(false);
    }
  };
  createEffect(
    on(
      () => props.revision,
      () => void load(),
      { defer: props.initial !== undefined },
    ),
  );
  const config = () => ({ ...props.dateConfig, locale: locale() });
  const title = (item: ForYouItem) =>
    item.kind === "mention" ? t().mentionedYou({ name: firstName(item) }) : t().repliedToYou({ name: firstName(item) });
  // A message in General names only its chat; one in a thread names the thread first, as the chat list does.
  const place = (item: ForYouItem) =>
    item.thread.id === "general" ? item.conversation.title : `${item.thread.name} · ${item.conversation.title}`;

  return (
    <section class="chat-discover chat-for-you" aria-label={t().forYou}>
      <header class="chat-conversation__header">
        <span class="chat-conversation__back">
          <IconButtonLink href={props.basePath} navigation="enhanced" onNavigate={props.onBack} label={t().backToChats} tooltip={false}>
            <i class="ti ti-arrow-left" aria-hidden="true" />
          </IconButtonLink>
        </span>
        <div class="min-w-0">
          <h1 class="text-lg font-semibold">{t().forYou}</h1>
          <p class="text-sm text-secondary">{t().forYouSubtitle}</p>
        </div>
      </header>
      <ScrollArea class="chat-discover__body">
        <div class="chat-discover__content" aria-busy={status() === "loading"}>
          <Show when={status() === "loading" && items().length === 0}>
            <div role="status" aria-label={t().forYou} class="chat-for-you__loading">
              <For each={[0, 1, 2]}>{() => <Skeleton class="h-12 w-full" />}</For>
            </div>
          </Show>
          <Show when={status() === "failed"}>
            <InlineGuidance tone="danger" icon="ti ti-alert-circle" role="alert">
              {t().forYouFailed}{" "}
              <Button variant="text" size="xs" onClick={() => void load()}>
                {t().retry}
              </Button>
            </InlineGuidance>
          </Show>
          <Show when={status() === "ready" && items().length === 0}>
            <p class="py-2 text-sm text-secondary" role="status">
              {t().forYouEmpty}
            </p>
          </Show>
          <ul class="chat-for-you__list" aria-label={t().forYou}>
            <For each={items()}>
              {(item) => (
                <li>
                  <a
                    class="chat-for-you__row"
                    data-unread={item.unread ? "" : undefined}
                    href={threadHref(item.conversation.id, item.thread.id, item.message.id, props.basePath)}
                    onClick={(event) => {
                      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
                        return;
                      event.preventDefault();
                      void props.onOpen(item);
                    }}
                  >
                    <span class="chat-for-you__icon" aria-hidden="true">
                      <i class="ti ti-at" />
                    </span>
                    <span class="chat-for-you__copy">
                      <span class="chat-for-you__title">{title(item)}</span>
                      <span class="chat-for-you__place">{place(item)}</span>
                    </span>
                    <span class="chat-for-you__meta">
                      <time datetime={item.message.createdAt}>{listTime(item.message.createdAt, props.now(), config())}</time>
                      {/* The count's place stays reserved, so a row that is read moves nothing. */}
                      <span class="chat-for-you__count" aria-hidden={item.unread ? undefined : "true"}>
                        1
                      </span>
                    </span>
                  </a>
                </li>
              )}
            </For>
          </ul>
          <Show when={cursor()}>
            <Button variant="text" size="sm" loading={loadingMore()} disabled={status() !== "ready"} onClick={() => void load(true)}>
              {t().showMoreForYou}
            </Button>
          </Show>
        </div>
      </ScrollArea>
    </section>
  );
}

const firstName = (item: ForYouItem) => item.message.author.name.trim().split(/\s+/u)[0] ?? item.message.author.name;
