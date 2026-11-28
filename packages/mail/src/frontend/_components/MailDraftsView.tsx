import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { ButtonLink, Placeholder, prompts, ScrollArea, useLocale } from "@k2b/ui";
import { createMemo, For, Show } from "solid-js";
import type { DraftFolderItem, DraftFolderPage } from "../../contracts";
import MailDraftRow from "./MailDraftRow";
import { mailDraftFolderHref } from "./mail-compose-route";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";
import { createMailDraftDelete } from "./mail-draft-delete";

/**
 * The Drafts folder: the mailbox's drafts as conversation rows, each opening in the composer for members who may edit
 * them. Members who may write also delete a draft from its row, after the same confirmation the composer asks.
 */
export default function MailDraftsView(props: {
  mailboxId: string;
  /** Only members who may write open the composer or delete; readers see the drafts without a link. */
  canWrite: boolean;
  title: string;
  /** The workspace route the composer returns to. */
  returnHref: string;
  page: DraftFolderPage;
  error: string | null;
  dateConfig: DateContext;
  loading: boolean;
  onNavigate: (event: LinkNavigateEvent) => void | Promise<void>;
  /** Reloads the folder after a delete. */
  onRefresh: () => Promise<void>;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailConversationUiMessages.resolve([locale()]).t);
  const listHref = (cursor: string | null) => {
    const target = new URL(props.returnHref, "http://mail.local");
    if (cursor) target.searchParams.set("cursor", cursor);
    else target.searchParams.delete("cursor");
    return `${target.pathname}${target.search}`;
  };
  const draftHref = (item: DraftFolderItem) => mailDraftFolderHref(props.mailboxId, item, listHref(null));

  let list: HTMLDivElement | undefined;
  let heading: HTMLHeadingElement | undefined;
  /** A leaving row can hold no focus: it moves to the next draft, the previous one, or the folder's heading. */
  const keepFocus = (id: string) => {
    const row = list?.querySelector<HTMLElement>(`[data-draft-id="${id}"]`);
    const active = document.activeElement;
    if (!row || (active && active !== document.body && !row.contains(active))) return;
    const neighbour = [row.nextElementSibling, row.previousElementSibling]
      .map((entry) => entry?.querySelector<HTMLElement>("a.mail-list-row"))
      .find(Boolean);
    (neighbour ?? heading)?.focus({ preventScroll: true });
  };
  const { pendingId, leaving, shown, requestDelete } = createMailDraftDelete({
    mailboxId: () => props.mailboxId,
    onRefresh: () => props.onRefresh(),
    confirm: (item) =>
      prompts.confirm(t().deleteDraftDescription({ subject: item.subject || t().noSubject }), {
        title: t().deleteDraftQuestion,
        confirmText: t().deleteDraft,
        variant: "danger",
      }),
    onLeave: keepFocus,
  });
  const items = createMemo(() => shown(props.page.items));

  return (
    <section class="mail-list-column flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[var(--ui-surface)]" aria-busy={props.loading}>
      <h1 ref={heading} tabIndex={-1} class="sr-only">
        {props.title}
      </h1>
      <Show when={pendingId()}>
        <span class="sr-only" role="status">
          {t().deletingDraft}
        </span>
      </Show>
      <ScrollArea class="flex-1 pb-2" inset>
        <Show
          when={!props.error}
          fallback={<Placeholder state="error" variant="panel" title={t().draftsUnavailable} description={props.error!} />}
        >
          <Show
            when={items().length > 0}
            fallback={<Placeholder icon="ti ti-file-pencil" variant="panel" title={t().noDrafts} description={t().noDraftsDescription} />}
          >
            <div
              class="flex flex-col gap-0.5"
              ref={list}
              role="list"
              aria-label={t().draftListLabel({ title: props.title })}
              data-mail-drafts-list
            >
              <For each={items()}>
                {(item) => (
                  <MailDraftRow
                    item={item}
                    href={props.canWrite ? draftHref(item) : null}
                    dateConfig={props.dateConfig}
                    pending={pendingId() === item.id}
                    leaving={leaving().has(item.id)}
                    onDelete={props.canWrite ? requestDelete : undefined}
                  />
                )}
              </For>
            </div>
            <Show when={props.page.nextCursor}>
              {(cursor) => (
                <div class="flex min-h-14 items-center justify-center py-3">
                  <ButtonLink
                    href={listHref(cursor())}
                    variant="secondary"
                    size="sm"
                    navigation="enhanced"
                    onNavigate={props.onNavigate}
                    scroll="preserve"
                  >
                    <i class="ti ti-chevron-down" aria-hidden="true" />
                    {t().loadMore}
                  </ButtonLink>
                </div>
              )}
            </Show>
          </Show>
        </Show>
      </ScrollArea>
    </section>
  );
}
