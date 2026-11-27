import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import { navigate } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { Band, Bar, Disclosure, Empty, Failed, Input, List, Loading, Menu, Notice, Row, Section, useLocale } from "@k2b/ui/v2";
import { defineListQuery, field } from "@k2b/ui/v2/list-query";
import { createMemo, createSignal, For, type JSX, Match, Show, Switch } from "solid-js";
import type { z } from "zod";
import { chatMessages } from "../../messages";
import type { ConversationSchema } from "../../service/contracts";
import { channelLine } from "../ChatList";
import { viewIcon } from "../ChatThreads";
import { listTime } from "../chat-format";
import { createChannelCatalog, type DiscoverChannelsProps } from "../DiscoverChannels";
import { createForYouList, type ForYouItem, forYouPlace, forYouTitle } from "../ForYou";
import { createDirectoryPages } from "../SystemThreadDirectory";
import { activeThreads, archivedThreads, type Thread, type ThreadList, type ThreadView, threadHref, threadIcon } from "../threads";

type Conversation = z.infer<typeof ConversationSchema>;

import { CHAT_COLOR, iconName } from "./ChatListV2";
import { chatV2Messages } from "./chat-v2-messages";

/**
 * "For you" on v2: mentions of and replies to the reader in every chat they may read, newest first, one row each
 * with who wrote, where, and when. A row opens its thread at the message; reading it there clears it.
 */
export function ForYouV2(props: {
  initial?: Parameters<typeof createForYouList>[0]["initial"];
  revision: number;
  basePath: string;
  dateConfig: DateContext;
  now: () => Date;
  onOpen: (item: ForYouItem) => Promise<void> | void;
}): JSX.Element {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  const list = createForYouList(props);
  const config = () => ({ ...props.dateConfig, locale: locale() });
  return (
    <Switch>
      <Match when={list.status() === "failed" && list.items().length === 0}>
        <Failed text={t().forYouFailed} onRetry={() => void list.load()} />
      </Match>
      <Match when={list.status() === "loading" && list.items().length === 0}>
        <Loading rows={6} lines={2} />
      </Match>
      <Match when={list.items().length === 0 && !list.incomplete()}>
        <Empty icon="at" text={t().forYouEmpty} />
      </Match>
      <Match when={true}>
        <Show when={list.incomplete() || list.status() === "failed"}>
          <Notice tone={list.status() === "failed" ? "bad" : "warn"} actions={[{ label: t().retry, onClick: () => void list.load() }]}>
            {list.status() === "failed" ? t().forYouFailed : t().discussionsIncomplete}
          </Notice>
        </Show>
        <Section
          title={t().forYouSubtitle}
          count={list.items().filter((item) => item.unread).length || undefined}
          more={
            list.cursor() && !list.incomplete()
              ? { label: t().showMoreForYou, icon: "dots", disabled: list.loadingMore(), onClick: () => void list.load(true) }
              : undefined
          }
        >
          <List label={t().forYou}>
            <For each={list.items()}>
              {(item) => (
                <Row
                  avatar={{ name: item.message.author.name }}
                  lines={[forYouTitle(item, t()), forYouPlace(item)]}
                  unread={item.unread}
                  time={listTime(item.message.createdAt, props.now(), config())}
                  href={threadHref(item.conversation.id, item.thread.id, item.message.id, props.basePath)}
                  onNavigate={() => props.onOpen(item)}
                />
              )}
            </For>
          </List>
        </Section>
      </Match>
    </Switch>
  );
}

/**
 * A chat's threads as the phone's page between the chats and one thread (v1's threads page): "All threads",
 * "General", the threads by last activity with their last message, and the archived ones folded away at the end.
 */
export function ThreadsPageV2(props: {
  conversation: Conversation;
  basePath: string;
  threads: ThreadList | null;
  status: "loading" | "ready" | "failed";
  viewerId: string;
  dateConfig: DateContext;
  now: () => Date;
  onOpen: (view: ThreadView, navigation: LinkNavigateEvent) => void | Promise<void>;
  onRetry: () => void;
}): JSX.Element {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  const config = () => ({ ...props.dateConfig, locale: locale() });
  const preview = (message: Thread["lastMessage"], fallback: string) => {
    if (!message) return fallback;
    const name = message.author.id === props.viewerId ? t().you : (message.author.name.trim().split(/\s+/u)[0] ?? "");
    return `${name}: ${message.preview}`;
  };
  const row = (view: ThreadView, name: string, unread: number, last: Thread["lastMessage"], fallback: string) => (
    <Row
      icon={iconName(viewIcon(view, props.threads))}
      color={CHAT_COLOR}
      lines={[name, preview(last, fallback)]}
      meta={unread > 0 ? unread.toLocaleString(locale()) : undefined}
      unread={unread > 0}
      time={last ? listTime(last.createdAt, props.now(), config()) : undefined}
      href={threadHref(props.conversation.id, view, null, props.basePath)}
      onNavigate={(navigation) => props.onOpen(view, navigation)}
    />
  );
  const thread = (entry: Thread) => row(entry.id, entry.name, entry.unread, entry.lastMessage, entry.description ?? t().noMessagesYet);
  return (
    <Switch>
      <Match when={props.status === "failed"}>
        <Failed text={t().threadsLoadFailed} onRetry={props.onRetry} />
      </Match>
      <Match when={true}>
        <Section title={chatV2Messages.resolve([locale()]).t.threads} count={activeThreads(props.threads).length || undefined}>
          <List label={t().threadsIn({ title: props.conversation.title })}>
            {row("all", t().allThreads, props.conversation.unread, props.conversation.lastMessage, t().allThreadsHint)}
            {row("general", t().general, props.threads?.general.unread ?? 0, props.threads?.general.lastMessage ?? null, t().generalHint)}
            <For each={activeThreads(props.threads)}>{thread}</For>
          </List>
          {/* The archived ones fold away at the end, as v1 folds them. */}
          <Show when={archivedThreads(props.threads).length > 0}>
            <Disclosure title={t().archivedThreads({ count: archivedThreads(props.threads).length })}>
              <List label={t().archivedThreads({ count: archivedThreads(props.threads).length })}>
                <For each={archivedThreads(props.threads)}>{thread}</For>
              </List>
            </Disclosure>
          </Show>
        </Section>
        <Show when={props.status === "ready" && activeThreads(props.threads).length === 0}>
          <Empty icon="hash" text={props.conversation.permission === "admin" ? t().noThreadsYetAdmin : t().noThreadsYet} />
        </Show>
      </Match>
    </Switch>
  );
}

/**
 * A place's discussions on v2 (the directory of a system chat): "All threads", then each discussion with its state, its
 * last message and its unread count, newest first. The search and the state filter live in the address through one
 * list-query declaration, so reload, back and forward show the same; the server filters and pages.
 */
export function SystemThreadDirectoryV2(props: {
  conversation: Conversation;
  basePath: string;
  viewerId: string;
  dateConfig: DateContext;
  now: () => Date;
  revision: number;
  onOpen: (view: ThreadView, navigation: LinkNavigateEvent) => void | Promise<void>;
}): JSX.Element {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  const config = () => ({ ...props.dateConfig, locale: locale() });
  const query = createMemo(() =>
    defineListQuery({
      key: "discussions",
      fields: {
        filter: field.choice({
          label: chatV2Messages.resolve([locale()]).t.discussionState,
          multiple: false,
          common: true,
          options: [
            { value: "open", label: t().threadsOpen },
            { value: "done", label: t().threadsDone },
            { value: "unread", label: t().threadsUnread },
          ],
        }),
      },
      search: { label: t().searchThreads },
      // The server orders discussions by their last activity; there is no other order to choose.
      sort: {
        options: { activity: { label: chatV2Messages.resolve([locale()]).t.recentActivity } },
        default: { field: "activity", direction: "desc" },
      },
    }),
  );
  // The page code loads in the browser, so the address is there to read; the bar writes it, the search below too.
  const [state, setState] = createSignal(query().parse(location.search).state);
  /** One change of the search or the state: the declaration derives the state and writes the address. */
  const change = (next: ReturnType<typeof state> | undefined) => {
    if (!next) return;
    setState(next);
    const params = query().serialize(next, location.search).toString();
    navigate(`${location.pathname}${params ? `?${params}` : ""}`, { replace: true, scroll: "preserve", viewTransition: false });
  };
  const [mounted] = createSignal(true);
  const pages = createDirectoryPages(props, () => ({ q: state().search ?? "", filter: state().filters.filter }), mounted);
  const preview = (thread: Thread) =>
    [
      thread.resource?.status,
      thread.lastMessage
        ? `${thread.lastMessage.author.id === props.viewerId ? t().you : thread.lastMessage.author.name.split(" ")[0]}: ${thread.lastMessage.preview}`
        : t().noMessagesYet,
    ]
      .filter(Boolean)
      .join(" · ");
  return (
    <>
      {/* k2b-ui gap: `FilterBar` is reached only through the `@k2b/ui/v2` barrel, and the bundler then hoists it (with
          Lookup and DatePicker) into the chunk every page of Chat loads (+57 KB over Chat's v2 budget). Until it has a
          path of its own, the search and the one state stand as one row; the address is the declaration's.
          k2b-ui gap: a v2 `Select` used only in this lazy page still moves its listbox behaviour through the `@k2b/ui/v2` barrel into the chunk every Chat page loads (+47 KB over Chat's v2 budget). The choice is a menu with a tick (menu behaviour is loaded already) until the barrel splits. */}
      <Bar
        start={
          <Input
            type="search"
            icon="search"
            label={t().searchThreads}
            placeholder={t().searchThreads}
            value={state().search ?? ""}
            onInput={(text) => change(query().set(state(), "q", text))}
          />
        }
        end={
          <Menu
            label={chatV2Messages.resolve([locale()]).t.discussionState}
            items={[
              {
                title: chatV2Messages.resolve([locale()]).t.discussionState,
                choice: state().filters.filter ?? "any",
                onChoose: (value: string) =>
                  change(
                    value === "open" || value === "done" || value === "unread"
                      ? query().set(state(), "filter", value)
                      : query().clear(state(), "filter"),
                  ),
                items: [
                  { label: t().allThreads, value: "any" },
                  { label: t().threadsOpen, value: "open" },
                  { label: t().threadsDone, value: "done" },
                  { label: t().threadsUnread, value: "unread" },
                ],
              },
            ]}
          >
            {state().filters.filter === "open"
              ? t().threadsOpen
              : state().filters.filter === "done"
                ? t().threadsDone
                : state().filters.filter === "unread"
                  ? t().threadsUnread
                  : t().allThreads}
          </Menu>
        }
      />
      <List label={t().threadsIn({ title: props.conversation.title })}>
        <Row
          icon="messages"
          color={CHAT_COLOR}
          lines={[t().allThreads]}
          href={threadHref(props.conversation.id, "all", null, props.basePath)}
          onNavigate={(navigation) => props.onOpen("all", navigation)}
        />
      </List>
      <Switch>
        <Match when={pages.status() === "failed" && !pages.page()}>
          <Failed text={t().threadsLoadFailed} onRetry={() => void pages.load()} />
        </Match>
        <Match when={!pages.page()}>
          <Loading rows={5} lines={2} />
        </Match>
        <Match when={pages.status() === "ready" && pages.page()?.items.length === 0 && pages.page()?.nextCursor == null}>
          <Empty icon="messages" text={state().search || state().filters.filter ? t().noThreadMatches : t().noItemThreads} />
        </Match>
        <Match when={true}>
          <Section
            title={t().systemChats}
            more={
              pages.page()?.nextCursor != null
                ? { label: t().moreThreads, icon: "dots", disabled: pages.status() === "loading", onClick: () => void pages.load(true) }
                : undefined
            }
          >
            <List label={t().systemChats}>
              <For each={pages.page()?.items ?? []}>
                {(thread) => (
                  <Row
                    icon={iconName(threadIcon(thread))}
                    color={CHAT_COLOR}
                    lines={[thread.name, preview(thread)]}
                    meta={thread.unread > 0 ? thread.unread.toLocaleString(locale()) : undefined}
                    unread={thread.unread > 0}
                    time={listTime(thread.lastActivityAt, props.now(), config())}
                    href={threadHref(props.conversation.id, thread.id, null, props.basePath)}
                    onNavigate={(navigation) => props.onOpen(thread.id, navigation)}
                  />
                )}
              </For>
            </List>
            <Show when={pages.page()?.incomplete && pages.status() === "ready"}>
              <Notice tone="warn" actions={[{ label: t().retry, onClick: () => void pages.load() }]}>
                {t().discussionsIncomplete}
              </Notice>
            </Show>
            <Show when={pages.status() === "failed" && pages.page()}>
              <Notice tone="bad" actions={[{ label: t().retry, onClick: () => void pages.load(pages.appending()) }]}>
                {t().threadsLoadFailed}
              </Notice>
            </Show>
          </Section>
        </Match>
      </Switch>
    </>
  );
}

/**
 * "Discover channels" on v2: the search, then every channel the reader may find, with its purpose and how many follow
 * it; one deed per row: subscribe, or open a channel already subscribed.
 */
export function DiscoverChannelsV2(props: DiscoverChannelsProps): JSX.Element {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  const catalog = createChannelCatalog(props);
  return (
    <>
      <Band label={t().searchChannels}>
        <Input
          type="search"
          icon="search"
          label={t().searchChannels}
          placeholder={t().searchChannels}
          value={catalog.search()}
          onInput={catalog.setSearch}
        />
      </Band>
      <Switch>
        <Match when={catalog.error() && catalog.rows.length === 0}>
          <Failed text={t().channelListFailed} onRetry={catalog.retry} />
        </Match>
        <Match when={catalog.busy() && catalog.rows.length === 0}>
          <Loading rows={6} lines={2} />
        </Match>
        <Match when={catalog.rows.length === 0}>
          <Empty icon="speakerphone" text={props.query ? t().channelSearchEmpty({ query: props.query }) : t().noChannels} />
        </Match>
        <Match when={true}>
          <Show when={catalog.error()}>
            <Notice tone="bad" actions={[{ label: t().retry, onClick: catalog.retry }]}>
              {t().channelListFailed}
            </Notice>
          </Show>
          <Section
            title={t().channels}
            count={catalog.rows.length}
            more={
              catalog.cursor()
                ? { label: t().showMoreChannels, icon: "dots", disabled: catalog.busy(), onClick: () => void catalog.load(true) }
                : undefined
            }
          >
            <List label={t().channels}>
              <For each={catalog.rows}>
                {(row) => (
                  <Row
                    icon={iconName(row.icon ?? "ti ti-speakerphone")}
                    color={CHAT_COLOR}
                    lines={[row.title, channelLine(row, t())]}
                    action={
                      row.member
                        ? { label: t().subscribed, icon: "check", onClick: () => void props.onOpen(row.id) }
                        : {
                            label: t().subscribe,
                            icon: "bell-plus",
                            disabled: catalog.pending().includes(row.id),
                            onClick: () => void catalog.subscribe(row.id),
                          }
                    }
                  />
                )}
              </For>
            </List>
          </Section>
        </Match>
      </Switch>
    </>
  );
}
