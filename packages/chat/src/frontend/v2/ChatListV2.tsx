import type { DateContext } from "@k2b/stdlib";
import {
  type Action,
  Empty,
  Failed,
  Icon,
  List,
  Loading,
  Menu,
  type MenuEntry,
  Notice,
  type OnNavigate,
  Row,
  Section,
  type TwoActions,
  useLocale,
} from "@k2b/ui/v2";
import { type Accessor, createMemo, For, type JSX, Match, Show, Switch } from "solid-js";
import type { z } from "zod";
import { chatMessages } from "../../messages";
import type { ConversationSchema } from "../../service/contracts";
import { type ChatDeviceNoticeProps, createDeviceNotice, NOTIFICATION_HELP_HREF } from "../ChatDeviceNotice";
import { channelLine, notificationMarks } from "../ChatList";
import { lastMessageLine, listTime } from "../chat-format";
import type { ChatSearchState } from "../chat-search-state";
import type { SearchHit } from "../search-api";
import { threadHref } from "../threads";
import { chatV2Messages } from "./chat-v2-messages";

type Conversation = z.infer<typeof ConversationSchema>;

/** The colour of Chat, the app that owns channels and the chats' own symbols. */
export const CHAT_COLOR = "#7c3aed";

/** A Tabler class of v1 ("ti ti-speakerphone") as the name v2 takes ("speakerphone"). */
export const iconName = (icon: string) => icon.replace(/^ti ti-/, "");

/** What every chat row needs: where it leads, what is open, and its deeds. */
export type ChatRowsContext = {
  label: string;
  activeId: string | null;
  viewerId: string;
  dateConfig: DateContext;
  now: () => Date;
  href: (row: Conversation) => string;
  onNavigate: (row: Conversation) => OnNavigate;
  /** The deeds of one chat, the same behind its "…" and on a right-click or long press. */
  menu: (row: Conversation, section: string) => readonly MenuEntry[];
};

export type ChatListSection = {
  key: string;
  title: string;
  rows: readonly Conversation[];
  count?: number | string;
  actions?: TwoActions;
  /** Shown in place of the rows when the section has none. */
  empty?: string;
  /** The way to more of them, such as the next page of chats. */
  more?: Action;
  /** The person folded this group away (v1's remembered sections). */
  folded?: boolean;
};

/** What a row shows of its unread state: the count, a dot for a chat marked unread without new messages, or nothing. */
const unreadMark = (row: Conversation): number | true | undefined =>
  row.unread > 0 ? row.unread : row.read?.unreadFromSeq != null ? true : undefined;

/** A chat's sign: a person's or a group's initials, a channel's or a place's symbol in Chat's colour. */
const sign = (row: Conversation): { icon?: string; color?: string; avatar?: { name: string } } => {
  if (row.kind === "system") return { icon: iconName(row.icon ?? "ti ti-messages"), color: CHAT_COLOR };
  if (row.icon) return { icon: iconName(row.icon), color: CHAT_COLOR };
  if (row.channel) return { icon: "speakerphone", color: CHAT_COLOR };
  return { avatar: { name: row.title } };
};

/**
 * One chat as a row of two lines: its sign, its name with the unread count, its last message and the time. The open
 * chat shows no count while it is being read, as in v1; after "Mark unread" it shows it like any other.
 */
export function ChatRowV2(props: { row: Conversation; section: string; context: ChatRowsContext }): JSX.Element {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  const row = () => props.row;
  const line = () =>
    row().kind === "system" && !row().lastMessage
      ? t().systemMembers
      : row().channel
        ? channelLine(row(), t())
        : lastMessageLine(row(), props.context.viewerId, locale());
  const marks = () =>
    notificationMarks(row(), row().id === props.context.activeId && row().read?.unreadFromSeq == null ? undefined : unreadMark(row()));
  const count = (): string | undefined => {
    if (row().summaryCursor != null || row().incomplete) return row().unread > 0 ? `${row().unread}+` : "…";
    const mark = marks();
    return typeof mark.unread === "number" ? `${mark.mention ? "@" : ""}${mark.unread.toLocaleString(locale())}` : undefined;
  };
  const menu = () => props.context.menu(row(), props.section);
  return (
    <Menu.Context items={menu()}>
      <Row
        icon={sign(row()).icon}
        color={sign(row()).color}
        avatar={sign(row()).avatar}
        lines={[row().title, line()]}
        meta={
          <Show when={marks().muted} fallback={count()}>
            <Icon name="bell-off" label={t().notificationsOffMark} />
            {count()}
          </Show>
        }
        unread={marks().unread !== undefined && !marks().muted}
        current={row().id === props.context.activeId}
        time={listTime(row().lastActivityAt, props.context.now(), { ...props.context.dateConfig, locale: locale() })}
        href={props.context.href(row())}
        onNavigate={props.context.onNavigate(row())}
        end={<Menu label={t().chatActions({ title: row().title })} items={menu()} />}
      />
    </Menu.Context>
  );
}

/** Chat's list on v2: one section per kind (pinned, chats, channels, discussions), each chat one row. */
export default function ChatListV2(props: { sections: Accessor<readonly ChatListSection[]>; context: ChatRowsContext }): JSX.Element {
  // Sections and rows stay by their key and ID while the live list replaces their data, so a row keeps its focus,
  // its open menu and its place when its count or last message changes.
  const keys = createMemo(() => props.sections().map((section) => section.key), undefined, { equals: sameKeys });
  // One section alone needs no heading: the nav already names the list.
  const alone = () => keys().length === 1;
  return (
    <For each={keys()}>
      {(key) => {
        const section = createMemo<ChatListSection>(
          (previous) => props.sections().find((entry) => entry.key === key) ?? previous,
          props.sections().find((entry) => entry.key === key)!,
        );
        const ids = createMemo(() => section().rows.map((row) => row.id), undefined, { equals: sameKeys });
        const byId = createMemo(() => new Map(section().rows.map((row) => [row.id, row])));
        const rows = (
          <Show when={ids().length > 0} fallback={<Show when={section().empty}>{(empty) => <Row lines={[empty()]} />}</Show>}>
            <List label={`${props.context.label}: ${section().title}`}>
              <For each={ids()}>
                {(id) => {
                  const row = createMemo<Conversation>((previous) => byId().get(id) ?? previous, byId().get(id)!);
                  return <ChatRowV2 row={row()} section={key} context={props.context} />;
                }}
              </For>
              <Show when={alone() ? section().more : undefined}>
                {(more) => <Row icon={more().icon ?? "dots"} lines={[more().label]} onOpen={() => more().onClick?.()} />}
              </Show>
            </List>
          </Show>
        );
        return (
          // k2b-ui gap: v1 folded every section and remembered it (`collapsed`). `Section` cannot fold, and `Group` is
          // a framed box (a box in the list pane, a double line under the status row); a `Section` that folds with a
          // controlled `open`/`onOpenChange` is asked for. Until then the sections stay open; `folded` is ready for it.
          <Show when={!alone()} fallback={rows}>
            <Section title={section().title} count={section().count} actions={section().actions} more={section().more}>
              {rows}
            </Section>
          </Show>
        );
      }}
    </For>
  );
}

const sameKeys = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((key, index) => key === b[index]);

/**
 * The one line about this device above the chats, as v1 draws it: do not disturb with "End", the offer to turn
 * notifications on (once per device), or that iPhone needs Cloud on the Home Screen.
 */
export function ChatDeviceNoticeV2(props: ChatDeviceNoticeProps): JSX.Element {
  const notice = createDeviceNotice(props);
  const t = notice.t;
  return (
    <Switch>
      <Match when={notice.quiet()}>
        {(state) => (
          <Notice
            tone="note"
            icon="moon"
            actions={
              state().reason === "doNotDisturb"
                ? [{ label: t().endDoNotDisturb, disabled: notice.busy(), onClick: () => void notice.endQuiet() }]
                : undefined
            }
          >
            {notice.quietLine(state())}
          </Notice>
        )}
      </Match>
      <Match when={notice.notice().kind === "ask"}>
        <Notice
          tone="note"
          icon="bell"
          actions={[{ label: t().notNow, disabled: notice.busy(), onClick: notice.notNow }]}
          primary={{ label: t().enableNotifications, disabled: notice.busy(), onClick: () => void notice.enable() }}
        >
          {t().enableAsk}
        </Notice>
      </Match>
      <Match when={notice.notice().kind === "home-screen"}>
        <Notice tone="note" icon="device-mobile" actions={[{ label: t().howItWorks, href: NOTIFICATION_HELP_HREF }]}>
          {t().iphoneHint}
        </Notice>
      </Match>
    </Switch>
  );
}

/**
 * A chat the reader may not see, or one that does not exist: it says so in one sentence (never naming the chat or
 * whether it exists) and leads back to the chats.
 */
export function NoAccessV2(props: { back: Action }): JSX.Element {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  return <Empty icon="lock" text={t().noAccessDescription} action={props.back} />;
}

type ThreadHit = Extract<SearchHit, { kind: "thread" }>;
type SystemHit = Extract<SearchHit, { kind: "system" }>;

/**
 * What the head's search finds, in place of the list: chats and channels as their ordinary rows, threads with their
 * chat, and places whose discussion nobody has started yet. The last answer stays while the next one loads, so typing
 * moves nothing; a place that cannot answer says so under the hits.
 */
export function ChatSearchV2(props: {
  search: ChatSearchState;
  basePath: string;
  active: { chatId: string | null; view: string };
  context: ChatRowsContext;
  /** The list's own row of a hit, once the list holds it, so pinning and reading show at once. */
  known: (row: Conversation) => Conversation;
  onThread: (chatId: string, thread: string) => OnNavigate;
  onSystem: (ref: SystemHit["ref"]) => void;
}): JSX.Element {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  const v2 = () => chatV2Messages.resolve([locale()]).t;
  const answer = () => props.search.answer();
  const items = () => answer()?.result.items ?? [];
  const threadIcon = (hit: ThreadHit) => iconName(hit.thread.resource?.icon ?? "ti ti-hash");
  return (
    <Switch>
      <Match when={props.search.status() === "failed"}>
        <Failed text={t().searchFailed} onRetry={() => props.search.retry()} />
      </Match>
      <Match when={answer() === null}>
        <Loading rows={4} lines={2} />
      </Match>
      <Match when={items().length === 0}>
        <Empty icon="search" text={t().searchNoResults({ q: answer()?.q ?? "" })} />
      </Match>
      <Match when={true}>
        <Section title={v2().searchResults} count={items().length}>
          <List label={v2().searchResults}>
            <For each={items()}>
              {(hit) => (
                <Switch>
                  <Match when={hit.kind === "chat" && hit}>
                    {(chat) => <ChatRowV2 row={props.known(chat().conversation)} section="search" context={props.context} />}
                  </Match>
                  <Match when={hit.kind === "system" && hit.conversation}>
                    {(conversation) => <ChatRowV2 row={props.known(conversation())} section="search" context={props.context} />}
                  </Match>
                  <Match when={hit.kind === "system" && hit}>
                    {(system) => (
                      <Row
                        icon={iconName(system().icon)}
                        color={CHAT_COLOR}
                        lines={[system().name, t().systemMembers]}
                        onOpen={() => props.onSystem(system().ref)}
                      />
                    )}
                  </Match>
                  <Match when={hit.kind === "thread" && hit}>
                    {(thread) => (
                      <Row
                        icon={threadIcon(thread())}
                        color={CHAT_COLOR}
                        lines={[thread().thread.name, t().searchThreadIn({ title: thread().conversation.title })]}
                        current={props.active.chatId === thread().conversation.id && props.active.view === thread().thread.id}
                        href={threadHref(thread().conversation.id, thread().thread.id, null, props.basePath)}
                        onNavigate={props.onThread(thread().conversation.id, thread().thread.id)}
                      />
                    )}
                  </Match>
                </Switch>
              )}
            </For>
          </List>
        </Section>
        <Show when={answer()?.result.systemUnavailable || answer()?.result.incomplete}>
          <Notice
            tone={answer()?.result.systemUnavailable ? "bad" : "warn"}
            actions={[{ label: t().retry, onClick: () => props.search.retry() }]}
          >
            {answer()?.result.systemUnavailable ? t().searchSystemUnavailable : t().discussionsIncomplete}
          </Notice>
        </Show>
      </Match>
    </Switch>
  );
}
