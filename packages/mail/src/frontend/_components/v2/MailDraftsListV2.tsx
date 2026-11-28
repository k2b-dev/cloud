import type { DateContext } from "@k2b/stdlib";
import { announce } from "@k2b/ui";
import { Avatar, Band, Button, Dialog, Empty, Failed, Icon, List, Menu, type OnNavigate, Row, Text } from "@k2b/ui/v2";
import { createEffect, For, Show } from "solid-js";
import type { DraftFolderItem, DraftFolderPage } from "../../../contracts";
import { mailDraftFolderHref } from "../mail-compose-route";
import { createMailDraftDelete } from "../mail-draft-delete";
import { mailRouteUrl } from "../mail-navigation";
import type { MailV2Text } from "./mail-v2-messages";
import { mailV2RowTime } from "./mail-v2-time";

/** Who receives the draft, in the order the composer lists them: To, then Cc, then Bcc. */
const recipients = (item: DraftFolderItem): string[] =>
  [...item.to, ...item.cc, ...item.bcc].map((recipient) => recipient.name || recipient.address);

/**
 * The Drafts folder on UI v2: one row of three lines per draft, its recipients where a conversation shows its sender.
 * A new message opens as a window over the list, a reply in its conversation; members who may write delete a draft
 * from the row's menu (on the phone a long press), after the question the composer asks too.
 */
export default function MailDraftsListV2(props: {
  mailboxId: string;
  /** Only members who may write open or delete a draft; readers see the drafts without a link. */
  canWrite: boolean;
  /** The list's route, which a reply's composer returns to. */
  requestPath: string;
  page: DraftFolderPage;
  error: string | null;
  dateConfig: DateContext;
  label: string;
  text: MailV2Text;
  /** Opens a new message's window over the list in place. */
  onOpenWindow: OnNavigate;
  onRefresh: () => Promise<void>;
  onRetry: () => void;
  onLoadMore: () => void;
}) {
  const listPath = () => {
    const url = mailRouteUrl(props.requestPath);
    url.searchParams.delete("cursor");
    url.searchParams.delete("draft");
    return `${url.pathname}${url.search}`;
  };
  const href = (item: DraftFolderItem) => mailDraftFolderHref(props.mailboxId, item, listPath());
  // The row that leaves gives the focus to the next draft, else the one before it.
  const keepFocus = (id: string) => {
    const item = props.page.items.find((entry) => entry.id === id);
    const link = item && document.querySelector(`[data-k2-part="Row"] a[href="${CSS.escape(href(item))}"]`);
    const row = link?.closest('[data-k2-part="Row"]');
    const active = document.activeElement;
    if (!row || (active && active !== document.body && !row.contains(active))) return;
    const neighbour = [row.nextElementSibling, row.previousElementSibling]
      .map((entry) => entry?.querySelector<HTMLElement>("a[href]"))
      .find(Boolean);
    neighbour?.focus({ preventScroll: true });
  };
  const drafts = createMailDraftDelete({
    mailboxId: () => props.mailboxId,
    onRefresh: () => props.onRefresh(),
    confirm: (item) =>
      Dialog.confirm({
        title: drafts.t().deleteDraftQuestion,
        description: drafts.t().deleteDraftDescription({ subject: item.subject || drafts.t().noSubject }),
        confirm: drafts.t().deleteDraft,
      }),
    onLeave: keepFocus,
  });
  const t = drafts.t;
  // the delete runs once the person agreed: assistive technology hears it, as the row stays until it is done
  createEffect(() => {
    if (drafts.pendingId()) announce(t().deletingDraft);
  });
  const items = () => drafts.shown(props.page.items);
  const menu = (item: DraftFolderItem) => [
    { label: t().continueEditing, icon: "pencil", href: href(item), onNavigate: item.conversationId ? undefined : props.onOpenWindow },
    {
      label: t().deleteDraft,
      icon: "trash",
      danger: true,
      disabled: drafts.pendingId() !== null,
      onClick: () => void drafts.requestDelete(item),
    },
  ];

  return (
    <>
      <Show when={!props.error} fallback={<Failed text={`${t().draftsUnavailable}. ${props.error}`} onRetry={props.onRetry} />}>
        <Show when={items().length > 0} fallback={<Empty icon="file-pencil" text={`${t().noDrafts}. ${t().noDraftsDescription}`} />}>
          <List label={props.label}>
            <For each={items()}>
              {(item) => {
                const names = () => recipients(item);
                const row = () => (
                  <Row
                    href={props.canWrite ? href(item) : undefined}
                    onNavigate={props.canWrite && !item.conversationId ? props.onOpenWindow : undefined}
                    lines={[names()[0] ?? t().noRecipients, item.subject || t().noSubject, item.bodyPreview || " "]}
                    meta={names().length > 1 ? `+${names().length - 1}` : undefined}
                    time={mailV2RowTime(item.updatedAt, props.dateConfig)}
                    marks={
                      <>
                        <Text tone="draft">{t().draftTag}</Text>
                        <Show when={item.attachmentCount > 0}>
                          <Icon name="paperclip" label={t().attachmentCount({ count: item.attachmentCount })} />
                        </Show>
                        <Avatar name={item.createdByDisplayName} />
                      </>
                    }
                    end={
                      props.canWrite ? (
                        <Menu label={t().actionsFor({ name: item.subject || t().noSubject })} items={menu(item)} />
                      ) : undefined
                    }
                    endOnHover
                  />
                );
                return (
                  <Show when={props.canWrite} fallback={row()}>
                    <Menu.Context items={menu(item)}>{row()}</Menu.Context>
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
    </>
  );
}
