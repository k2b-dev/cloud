import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import { type DateContext, dates } from "@k2b/stdlib";
import { ButtonLink, Placeholder, ScrollArea, useLocale } from "@k2b/ui";
import { createMemo, For, Show } from "solid-js";
import type { DraftFolderItem, DraftFolderPage } from "../../contracts";
import { mailDraftHref } from "./mail-compose-route";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";

const recipients = (item: DraftFolderItem, t: ReturnType<typeof mailConversationUiMessages.resolve>["t"]): string => {
  const all = [...item.to, ...item.cc, ...item.bcc];
  if (all.length === 0) return t.noRecipients;
  const first = all[0]!;
  const label = first.name || first.address;
  return all.length === 1 ? label : t.moreRecipients({ first: label, count: all.length - 1 });
};

/** The Drafts folder: the mailbox's drafts, each opening in the composer for members who may edit them. */
export default function MailDraftsView(props: {
  mailboxId: string;
  /** Only members who may write open the composer; readers see the drafts without a link. */
  canWrite: boolean;
  title: string;
  /** The workspace route the composer returns to. */
  returnHref: string;
  page: DraftFolderPage;
  error: string | null;
  dateConfig: DateContext;
  loading: boolean;
  onNavigate: (event: LinkNavigateEvent) => void | Promise<void>;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailConversationUiMessages.resolve([locale()]).t);
  const listHref = (cursor: string | null) => {
    const target = new URL(props.returnHref, "http://mail.local");
    if (cursor) target.searchParams.set("cursor", cursor);
    else target.searchParams.delete("cursor");
    return `${target.pathname}${target.search}`;
  };

  return (
    <section class="flex h-full min-h-0 flex-1 flex-col overflow-hidden" aria-busy={props.loading}>
      <h1 class="sr-only">{props.title}</h1>
      <ScrollArea class="flex-1">
        <Show when={!props.error} fallback={<Placeholder state="error" title={t().draftsUnavailable} description={props.error!} />}>
          <Show
            when={props.page.items.length > 0}
            fallback={<Placeholder icon="ti ti-file-pencil" title={t().noDrafts} description={t().noDraftsDescription} />}
          >
            <div class="mail-drafts-list">
              <For each={props.page.items}>
                {(item) => {
                  const card = (
                    <>
                      <span class="mail-draft-row__icon">
                        <i class={`ti ${item.intent === "new" ? "ti-file-pencil" : "ti-arrow-back-up"}`} aria-hidden="true" />
                      </span>
                      <h2 class="mail-draft-row__subject">{item.subject || t().noSubject}</h2>
                      <p class="mail-draft-row__recipients">
                        {t().to} {recipients(item, t())}
                      </p>
                      <time
                        class="mail-draft-row__time"
                        dateTime={item.updatedAt}
                        title={dates.formatDateTime(item.updatedAt, props.dateConfig)}
                      >
                        {t().edited({ value: dates.formatDateTimeRelative(item.updatedAt, props.dateConfig) })}
                      </time>
                      <p class="mail-draft-row__preview">{item.bodyPreview || t().noMessageBody}</p>
                      <p class="mail-draft-row__owner">{t().draftStartedBy({ name: item.createdByDisplayName })}</p>
                    </>
                  );
                  return (
                    <Show when={props.canWrite} fallback={<article class="mail-draft-row">{card}</article>}>
                      <a
                        href={mailDraftHref(props.mailboxId, item.id, listHref(null))}
                        aria-label={t().openDraft({ subject: item.subject || t().noSubject })}
                        class="mail-draft-row"
                      >
                        {card}
                      </a>
                    </Show>
                  );
                }}
              </For>
              <Show when={props.page.nextCursor}>
                {(cursor) => (
                  <ButtonLink
                    href={listHref(cursor())}
                    variant="secondary"
                    size="sm"
                    class="self-center"
                    navigation="enhanced"
                    onNavigate={props.onNavigate}
                    scroll="preserve"
                  >
                    {t().loadMore}
                  </ButtonLink>
                )}
              </Show>
            </div>
          </Show>
        </Show>
      </ScrollArea>
    </section>
  );
}
