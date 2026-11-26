import type { DateContext } from "@k2b/stdlib";
import { Band, Empty, Failed, Input, List, Loading, Notice, Row, Section, useLocale } from "@k2b/ui/v2";
import { For, type JSX, Match, Show, Switch } from "solid-js";
import { chatMessages } from "../../messages";
import { channelLine } from "../ChatList";
import { listTime } from "../chat-format";
import { createChannelCatalog, type DiscoverChannelsProps } from "../DiscoverChannels";
import { createForYouList, type ForYouItem, forYouPlace, forYouTitle } from "../ForYou";
import { threadHref } from "../threads";
import { CHAT_COLOR, iconName } from "./ChatListV2";

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
