import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Avatar, Band, Button, Chip, Cut, Empty, Failed, Icon, List, Notice, Row, Text } from "@k2b/ui/v2";
import { Show } from "solid-js";
import type { MailListItem } from "../../../service/workspace";
import { mailRowSnoozeDay, mailRowSuggestedBy } from "../MailConversationRow";
import { mailConversationUiMessages } from "../mail-conversation-ui-messages";
import { mailListRowKey } from "../mail-list-projection";
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
  /** While conversations are being selected: each row's box, in the place of its lead. */
  selection?: { selected: (item: MailListItem) => boolean; toggle: (item: MailListItem) => void };
  /** A plain click on a row opens its conversation in place; the row stays a link for a new tab. */
  onOpen: (nav: LinkNavigateEvent, item: MailListItem) => void | Promise<void>;
  onRetry: () => void;
  onLoadMore: () => void;
}) {
  const locale = useLocale();
  const t = () => mailConversationUiMessages.resolve([locale()]).t;
  const requestUrl = () => mailRouteUrl(props.requestPath);
  const sender = (item: MailListItem) => {
    const label = item.participantLabels[0] || item.participantSummary || t().unknownSender;
    // a sender known only by an address is cut in the middle, so its domain stays readable
    return /^[^\s@]+@[^\s@]+$/.test(label) ? <Cut text={label} keep="domain" /> : label;
  };
  const snoozeDay = (item: MailListItem) =>
    item.snoozedUntil && Date.parse(item.snoozedUntil) > Date.now()
      ? mailRowSnoozeDay(item.snoozedUntil, new Date(), locale(), props.dateConfig.timeZone)
      : null;

  const marks = (item: MailListItem) => {
    const tag = item.localTags[0];
    const assignee = props.assigneeNames(item.assigneeUserIds)[0];
    const drafted = item.drafts.count > 0;
    const suggested = drafted && mailRowSuggestedBy(item.drafts) !== null;
    // In the order they give way when the row has no room (the row keeps its marks to half its width): the lone
    // symbols leave first (the row puts them last), then the person, the tag, and the words of the state last.
    const day = snoozeDay(item);
    const parts = [
      item.workStatus === "waiting" ? <Text>{props.text.waiting}</Text> : null,
      day ? (
        <Text>
          <Icon name="clock" /> {t().snoozedUntilDay({ day })}
        </Text>
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
      tag ? (
        <Chip tag color={tag.color}>
          {tag.name}
        </Chip>
      ) : null,
      assignee ? <Avatar name={assignee} /> : null,
      item.attachmentCount ? <Icon name="paperclip" label={t().attachmentCount({ count: item.attachmentCount })} /> : null,
      item.kept ? <Icon name="lock" label={t().keptConversation} /> : null,
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
        {/* Rows of a list of items: only those in view are in the page, so a mailbox of any size stays fast. */}
        <List
          label={props.label}
          items={props.items}
          rowKey={mailListRowKey}
          row={(item) => (
            <Row
              href={buildMailSelectionHref(requestUrl(), item)}
              onNavigate={(nav) => props.onOpen(nav, item)}
              lines={[sender(item), item.subject || t().noSubject, item.preview || " "]}
              meta={item.selectionKind === "conversation" && item.messageCount > 1 ? String(item.messageCount) : undefined}
              time={mailV2RowTime(item.latestMessageAt, props.dateConfig)}
              unread={item.unread}
              current={isMailListItemActive(item, props.selectedConversationId, props.selectedMessageId)}
              select={
                props.selection && item.conversationId
                  ? { selected: props.selection.selected(item), onChange: () => props.selection?.toggle(item) }
                  : undefined
              }
              marks={marks(item)}
            />
          )}
        />
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
