import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Avatar, Band, Button, Chip, Empty, Failed, Icon, List, Notice, Row, Text } from "@k2b/ui/v2";
import { For, Show } from "solid-js";
import type { MailListItem } from "../../../service/workspace";
import { mailRowSnoozeDay, mailRowSuggestedBy } from "../MailConversationRow";
import { mailConversationUiMessages } from "../mail-conversation-ui-messages";
import { buildMailSelectionHref, isMailListItemActive, mailRouteUrl } from "../mail-navigation";
import type { MailV2Text } from "./mail-v2-messages";
import { mailV2RowTime } from "./mail-v2-time";

/**
 * The conversation list of Mail's v2 pilot: one `Row` of three lines per conversation, as in the mockup. Each row is
 * a real link to its conversation, which a plain click opens in place (`onOpen`).
 */
export default function MailListV2(props: {
  items: readonly MailListItem[];
  requestPath: string;
  selectedConversationId: string | null;
  selectedMessageId: string | null;
  dateConfig: DateContext;
  error: string | null;
  nextCursor: string | null | undefined;
  assigneeNames: (userIds: readonly string[]) => string[];
  text: MailV2Text;
  label: string;
  /** A plain click on a row opens its conversation in place; the row stays a link for a new tab. */
  onOpen: (nav: LinkNavigateEvent, item: MailListItem) => void | Promise<void>;
  onRetry: () => void;
  onLoadMore: () => void;
}) {
  const locale = useLocale();
  const t = () => mailConversationUiMessages.resolve([locale()]).t;
  const requestUrl = () => mailRouteUrl(props.requestPath);
  const sender = (item: MailListItem) => item.participantLabels[0] || item.participantSummary || t().unknownSender;
  const snoozeDay = (item: MailListItem) =>
    item.snoozedUntil && Date.parse(item.snoozedUntil) > Date.now()
      ? mailRowSnoozeDay(item.snoozedUntil, new Date(), locale(), props.dateConfig.timeZone)
      : null;

  const marks = (item: MailListItem) => {
    const tag = item.localTags[0];
    const assignee = props.assigneeNames(item.assigneeUserIds)[0];
    const drafted = item.drafts.count > 0;
    const suggested = drafted && mailRowSuggestedBy(item.drafts) !== null;
    const parts = [
      item.workStatus === "waiting" ? props.text.waiting : null,
      tag ? (
        <Chip tag color={tag.color}>
          {tag.name}
        </Chip>
      ) : null,
      snoozeDay(item) ? (
        <>
          <Icon name="clock" />
          {t().snoozedUntilDay({ day: snoozeDay(item)! })}
        </>
      ) : null,
      drafted ? (
        suggested ? (
          <Text tone="ai">
            <Icon name="sparkles" /> {t().suggestionMark}
          </Text>
        ) : (
          <Text tone="draft">{props.text.draft}</Text>
        )
      ) : null,
      item.attachmentCount ? <Icon name="paperclip" label={t().attachmentCount({ count: item.attachmentCount })} /> : null,
      item.kept ? <Icon name="lock" label={t().keptConversation} /> : null,
      assignee ? <Avatar name={assignee} /> : null,
    ].filter((part) => part !== null);
    return parts.length > 0 ? <>{parts}</> : undefined;
  };

  return (
    <>
      {/* A failed refresh keeps the rows it has and says so above them; without rows the failure takes their place. */}
      <Show when={props.items.length > 0 ? props.error : null}>
        {(error) => (
          <Notice tone="bad" actions={[{ label: props.text.retry, onClick: props.onRetry }]}>
            {error()}
          </Notice>
        )}
      </Show>
      <Show
        when={props.items.length > 0}
        fallback={
          <Show when={props.error} fallback={<Empty icon="inbox" text={props.text.empty} />}>
            {(error) => <Failed text={error()} onRetry={props.onRetry} />}
          </Show>
        }
      >
        <List label={props.label}>
          <For each={props.items}>
            {(item) => (
              <Row
                href={buildMailSelectionHref(requestUrl(), item)}
                onNavigate={(nav) => props.onOpen(nav, item)}
                lines={[sender(item), item.subject || t().noSubject, item.preview || " "]}
                meta={item.selectionKind === "conversation" && item.messageCount > 1 ? String(item.messageCount) : undefined}
                time={mailV2RowTime(item.latestMessageAt, props.dateConfig)}
                unread={item.unread}
                selected={isMailListItemActive(item, props.selectedConversationId, props.selectedMessageId)}
                marks={marks(item)}
              />
            )}
          </For>
        </List>
      </Show>
      <Show when={props.nextCursor}>
        <Band>
          <Button variant="text" onClick={() => props.onLoadMore()}>
            {props.text.loadMore}
          </Button>
        </Band>
      </Show>
    </>
  );
}
