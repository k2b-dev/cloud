import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import { type DateContext, dates } from "@k2b/stdlib";
import { ButtonLink, Paper, Placeholder, ScrollArea, useLocale } from "@k2b/ui";
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

/** The Drafts folder: the mailbox's drafts, each opening in the composer. */
export default function MailDraftsView(props: {
  mailboxId: string;
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
      <header class="flex shrink-0 items-center gap-3 px-4 py-3">
        <span class="flex h-8 w-8 items-center justify-center rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] text-secondary">
          <i class="ti ti-file-pencil" aria-hidden="true" />
        </span>
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-base font-semibold text-primary">{props.title}</h1>
          <p class="text-xs text-dimmed">{t().draftCount({ count: props.page.total })}</p>
        </div>
      </header>
      <ScrollArea class="flex-1 p-3">
        <Show
          when={!props.error}
          fallback={<Placeholder icon="ti ti-alert-circle" title={t().draftsUnavailable} description={props.error!} />}
        >
          <Show
            when={props.page.items.length > 0}
            fallback={<Placeholder icon="ti ti-file-pencil" title={t().noDrafts} description={t().noDraftsDescription} />}
          >
            <div class="flex flex-col gap-2">
              <For each={props.page.items}>
                {(item) => (
                  <Paper
                    as="a"
                    interactive
                    href={mailDraftHref(props.mailboxId, item.id, listHref(null))}
                    aria-label={t().openDraft({ subject: item.subject || t().noSubject })}
                    class="flex min-w-0 items-start gap-3 p-3"
                  >
                    <span class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] text-secondary">
                      <i class={`ti ${item.intent === "new" ? "ti-file-pencil" : "ti-arrow-back-up"}`} aria-hidden="true" />
                    </span>
                    <div class="min-w-0 flex-1">
                      <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <h2 class="min-w-0 flex-1 truncate text-sm font-semibold text-primary">{item.subject || t().noSubject}</h2>
                        <time
                          class="shrink-0 text-xs text-dimmed"
                          dateTime={item.updatedAt}
                          title={dates.formatDateTime(item.updatedAt, props.dateConfig)}
                        >
                          {t().edited({ value: dates.formatDateTimeRelative(item.updatedAt, props.dateConfig) })}
                        </time>
                      </div>
                      <p class="mt-0.5 truncate text-xs text-secondary">
                        {t().to} {recipients(item, t())}
                      </p>
                      <p class="mt-2 line-clamp-2 text-sm leading-5 text-secondary">{item.bodyPreview || t().noMessageBody}</p>
                      <p class="mt-2 text-xs text-dimmed">
                        <i class="ti ti-user mr-1" aria-hidden="true" />
                        {t().draftStartedBy({ name: item.createdByDisplayName })}
                      </p>
                    </div>
                  </Paper>
                )}
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
