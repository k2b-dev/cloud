import type { DateContext } from "@k2b/stdlib";
import { Avatar, Band, Button, Dialog, Empty, Failed, Icon, List, Menu, Row, Text } from "@k2b/ui/v2";
import { createSignal, For, Show } from "solid-js";
import type { ScheduledSendPage } from "../../../contracts";
import { createMailScheduledCancel, type MailScheduledDisposition } from "../mail-scheduled-cancel";
import type { MailV2Text } from "./mail-v2-messages";
import { mailV2DueTime } from "./mail-v2-time";

type ScheduledSend = ScheduledSendPage["items"][number];

/**
 * The Outbox on UI v2: one row of three lines per message that waits for its time, with when it goes, to whom, who
 * queued it, and a failed try or a missing sign-in. Members who may write cancel a send from its row; they choose
 * whether it goes back to Drafts or goes away.
 */
export default function MailScheduledListV2(props: {
  mailboxId: string;
  canWrite: boolean;
  page: ScheduledSendPage;
  error: string | null;
  dateConfig: DateContext;
  label: string;
  text: MailV2Text;
  onRefresh: () => Promise<void>;
  onRetry: () => void;
  onLoadMore: () => void;
}) {
  // The question of a cancel: open while it waits for the answer, which ends it.
  const [asking, setAsking] = createSignal<((disposition: MailScheduledDisposition) => void) | null>(null);
  const answer = (disposition: MailScheduledDisposition) => {
    asking()?.(disposition);
    setAsking(null);
  };
  const scheduled = createMailScheduledCancel({
    mailboxId: () => props.mailboxId,
    onRefresh: () => props.onRefresh(),
    choose: () => new Promise<MailScheduledDisposition>((resolve) => setAsking(() => resolve)),
  });
  const t = scheduled.t;
  const recipients = (item: ScheduledSend) => {
    const all = [...item.to, ...item.cc, ...item.bcc];
    if (all.length === 0) return t().noRecipients;
    const first = all[0]!.name || all[0]!.address;
    return `${t().to} ${all.length === 1 ? first : t().moreRecipients({ first, count: all.length - 1 })}`;
  };
  // A send that waits for the mailbox's sign-in says so; a failed try says when it tries again.
  const state = (item: ScheduledSend) =>
    item.lastErrorCode === "MAILBOX_AUTH_REQUIRED" ? (
      <Text tone="warn">
        <Icon name="lock" /> {t().waitingForSignIn}
      </Text>
    ) : item.lastError ? (
      <Text tone="bad">
        <Icon name="alert-circle" />{" "}
        {item.nextAttemptAt ? t().retryAt({ value: mailV2DueTime(item.nextAttemptAt, props.dateConfig) }) : t().retryPending}
      </Text>
    ) : null;

  return (
    <>
      <Show when={!props.error} fallback={<Failed text={`${t().scheduledUnavailable}. ${props.error}`} onRetry={props.onRetry} />}>
        <Show
          when={props.page.items.length > 0}
          fallback={<Empty icon="calendar-check" text={`${t().noScheduled}. ${t().noScheduledDescription}`} />}
        >
          <List label={props.label}>
            <For each={props.page.items}>
              {(item) => {
                const menu = () => [
                  {
                    label: props.text.cancelDelivery,
                    icon: "calendar-cancel",
                    danger: true,
                    disabled: scheduled.cancellingId() !== null,
                    onClick: () => scheduled.cancel(item.id),
                  },
                ];
                const row = () => (
                  <Row
                    lines={[recipients(item), item.subject || t().noSubject, item.bodyPreview || t().noMessageBody]}
                    time={mailV2DueTime(item.scheduledAt, props.dateConfig)}
                    marks={
                      <>
                        {state(item)}
                        <Avatar name={item.scheduledBy.displayName} />
                      </>
                    }
                    // the "…" shows on hover and focus only; on the phone a long press on the row opens the same menu
                    end={
                      props.canWrite ? <Menu label={t().actionsFor({ name: item.subject || t().noSubject })} items={menu()} /> : undefined
                    }
                    endOnHover
                  />
                );
                return (
                  <Show when={props.canWrite} fallback={row()}>
                    <Menu.Context items={menu()}>{row()}</Menu.Context>
                  </Show>
                );
              }}
            </For>
          </List>
          <Show when={props.page.nextCursor}>
            <Band>
              <Button variant="text" onClick={() => props.onLoadMore()}>
                {props.text.loadMore}
              </Button>
            </Band>
          </Show>
        </Show>
      </Show>
      <Dialog
        title={t().cancelScheduledTitle}
        open={asking() !== null}
        onOpenChange={(open) => {
          if (!open) answer(null);
        }}
        foot={
          // waiting on is closing the question (its button, Escape): the foot holds the two ways to cancel
          <>
            <Button onClick={() => answer("discard")}>{t().discardMessage}</Button>
            <Button variant="primary" onClick={() => answer("draft")}>
              {t().keepAsDraft}
            </Button>
          </>
        }
      >
        <Text>{t().cancelScheduledDescription}</Text>
      </Dialog>
    </>
  );
}
