import { type DateContext, dates } from "@k2b/stdlib";
import { StatusBadge, type StatusTone, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";
import type { MailListItem } from "./mail-navigation";
import type { MailQuickLookState } from "./mail-quick-look";

const STATUS: Record<NonNullable<MailListItem["workStatus"]>, { tone: StatusTone; icon: string }> = {
  needs_action: { tone: "warning", icon: "ti ti-message-reply" },
  waiting: { tone: "info", icon: "ti ti-hourglass" },
  done: { tone: "ok", icon: "ti ti-checkbox" },
};

/** Line widths of the text placeholders, in percent; 0 is a paragraph gap. */
const PLACEHOLDER_LINES = [92, 97, 88, 95, 60, 0, 94, 72];

const capitalize = (value: string) => value.charAt(0).toLocaleUpperCase() + value.slice(1);

/**
 * The content of a conversation's quick look card. Facts the list row already
 * has render at once; the assignee name and the text wait for the preview
 * request in the same fixed box, so nothing moves when it answers.
 */
export default function MailConversationQuickLook(props: {
  item: MailListItem;
  state: MailQuickLookState;
  dateConfig: DateContext;
  onOpen: () => void;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailConversationUiMessages.resolve([locale()]).t);
  const data = () => (props.state.status === "ready" ? props.state.data : null);
  const loading = () => props.state.status === "loading";
  const received = () => {
    const at = props.item.latestMessageAt;
    const day = dates.formatDateRelative(at, props.dateConfig);
    const time = dates.formatTime(at, props.dateConfig);
    return day === time ? time : `${capitalize(day)}, ${time}`;
  };
  const statusLabel = () => {
    const status = props.item.workStatus;
    return status === "needs_action" ? t().needsAction : status === "waiting" ? t().waitingForReply : status === "done" ? t().done : null;
  };
  const sender = () => data()?.latestMessage?.from ?? null;
  const senderName = () =>
    sender()?.name ?? sender()?.address ?? props.item.participantLabels[0] ?? (props.item.participantSummary || t().unknownSender);
  const others = () => props.item.participantLabels.filter((label) => label !== senderName());
  const senderDetail = () =>
    [sender()?.name ? sender()?.address : null, others().length > 0 ? t().withParticipants({ names: others().join(", ") }) : null]
      .filter(Boolean)
      .join(" · ");
  const attachments = () => data()?.attachments ?? { count: 0, firstName: null };
  const earlier = () => data()?.earlierMessageCount ?? 0;

  // One line of facts: tags collapse into "+n" from the end until it fits;
  // time, status, and assignee always stay, and the assignee name truncates
  // only when even without tags the line is too long.
  let facts: HTMLDivElement | undefined;
  const [shownTags, setShownTags] = createSignal(props.item.localTags.length);
  const [shrinkAssignee, setShrinkAssignee] = createSignal(false);
  const hiddenTags = () => props.item.localTags.slice(shownTags());
  const overflowing = () => Boolean(facts && facts.scrollWidth > facts.clientWidth);
  createEffect(
    on([() => props.item.localTags.length, () => data()?.assigneeName, loading], ([tagCount]) => {
      setShownTags(tagCount);
      setShrinkAssignee(false);
      // The card is shown once the current task ends; measure it then.
      queueMicrotask(() => {
        while (overflowing() && shownTags() > 0) setShownTags(shownTags() - 1);
        if (overflowing()) setShrinkAssignee(true);
      });
    }),
  );

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users open the conversation with Enter on the focused row.
    // biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut for the row link, which stays the accessible control.
    <div class="mail-quick-look" aria-busy={loading()} onClick={() => props.onOpen()}>
      <div class="mail-quick-look__facts" ref={facts} data-shrink-assignee={shrinkAssignee() ? "" : undefined}>
        <StatusBadge tone="neutral" variant="text" icon={null} label={received()} />
        <Show when={props.item.workStatus}>
          {(status) => <StatusBadge tone={STATUS[status()].tone} icon={STATUS[status()].icon} label={statusLabel()} />}
        </Show>
        <Show
          when={props.item.assigneeUserId}
          fallback={<StatusBadge class="mail-quick-look__assignee" tone="neutral" icon="ti ti-user-off" label={t().unassigned} />}
        >
          <Show when={!loading()} fallback={<span class="mail-quick-look__placeholder mail-quick-look__placeholder--chip" />}>
            <StatusBadge
              class="mail-quick-look__assignee"
              tone="neutral"
              icon="ti ti-user-check"
              label={data()?.assigneeName ?? t().assigned}
            />
          </Show>
        </Show>
        <For each={props.item.localTags.slice(0, shownTags())}>
          {(tag) => (
            <StatusBadge
              tone="neutral"
              icon={null}
              label={
                <>
                  <span class="mail-quick-look__tag-dot" style={{ "background-color": tag.color }} aria-hidden="true" />
                  {tag.name}
                </>
              }
            />
          )}
        </For>
        <Show when={hiddenTags().length > 0}>
          <span
            class="mail-quick-look__more"
            title={hiddenTags()
              .map((tag) => tag.name)
              .join(", ")}
            role="img"
            aria-label={t().moreTags({
              count: hiddenTags().length,
              names: hiddenTags()
                .map((tag) => tag.name)
                .join(", "),
            })}
          >
            <StatusBadge tone="neutral" icon={null} label={`+${hiddenTags().length}`} />
          </span>
        </Show>
      </div>
      <div class="mail-quick-look__head">
        <h3 class="mail-quick-look__subject">{props.item.subject || t().noSubject}</h3>
        <p class="mail-quick-look__from">
          <b>{senderName()}</b>
          <Show when={senderDetail()}>
            <span>{senderDetail()}</span>
          </Show>
        </p>
      </div>
      <Show when={data()?.summary}>
        {(summary) => (
          <div class="mail-quick-look__summary">
            <p>
              <b>{t().summary}</b> {summary()}
            </p>
          </div>
        )}
      </Show>
      <div class="mail-quick-look__text">
        <Show
          when={!loading()}
          fallback={
            <For each={PLACEHOLDER_LINES}>
              {(width) =>
                width ? (
                  <span class="mail-quick-look__placeholder mail-quick-look__placeholder--line" style={{ width: `${width}%` }} />
                ) : (
                  <span class="mail-quick-look__gap" />
                )
              }
            </For>
          }
        >
          <Show
            when={data()?.latestMessage?.excerpt}
            fallback={<p class="mail-quick-look__quiet">{props.state.status === "error" ? t().quickLookUnavailable : t().noMessageBody}</p>}
          >
            {(excerpt) => <p>{excerpt()}</p>}
          </Show>
        </Show>
      </div>
      <Show when={attachments().count > 0 || earlier() > 0}>
        <p class="mail-quick-look__foot">
          <Show when={attachments().count > 0}>
            <span class="mail-quick-look__attachment">
              <i class="ti ti-paperclip" aria-hidden="true" />
              <span class="mail-quick-look__attachment-name">{attachments().firstName ?? t().untitledAttachment}</span>
              <Show when={attachments().count > 1}>
                <span>+{attachments().count - 1}</span>
              </Show>
            </span>
          </Show>
          <Show when={earlier() > 0}>
            <span class="mail-quick-look__earlier">
              <i class="ti ti-messages" aria-hidden="true" />
              {t().earlierMessages({ count: earlier() })}
            </span>
          </Show>
        </p>
      </Show>
    </div>
  );
}
