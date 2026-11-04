import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { mutation } from "@k2b/stdlib/solid";
import { ButtonLink, Placeholder, prompts, ScrollArea, toast, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { DraftFolderItem, DraftFolderPage, DraftLeaseErrorCode } from "../../contracts";
import { MailApiError, readApiFailure } from "./api-response";
import MailDraftRow from "./MailDraftRow";
import { mailDraftHref } from "./mail-compose-route";
import { mailConversationListMessages } from "./mail-conversation-list-messages";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";
import { createRetryToasts } from "./mail-feedback";
import { mailTimeColumnSamples, mailTimeColumnSizer } from "./mail-view-mode";

/** An open composer holds the draft. The contracts module carries Zod, so the mailbox island imports only its types. */
const LEASE_HELD = "DRAFT_LEASE_HELD" satisfies DraftLeaseErrorCode;

/** The collapse of a deleted row (`mail-list-row-leave`); the list drops the row once it ends. */
const LEAVE_MS = 160;

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
  /** The person's view: one line per draft in columns, as for conversations, or three-line rows. */
  columns: boolean;
  onNavigate: (event: LinkNavigateEvent) => void | Promise<void>;
  /** Reloads the folder after a delete. */
  onRefresh: () => Promise<void>;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailConversationUiMessages.resolve([locale()]).t);
  const listText = createMemo(() => mailConversationListMessages.resolve([locale()]).t);
  const listHref = (cursor: string | null) => {
    const target = new URL(props.returnHref, "http://mail.local");
    if (cursor) target.searchParams.set("cursor", cursor);
    else target.searchParams.delete("cursor");
    return `${target.pathname}${target.search}`;
  };
  const timeColumnSizer = createMemo(() =>
    props.columns ? mailTimeColumnSizer(mailTimeColumnSamples(props.dateConfig, new Date())) : undefined,
  );

  const [pendingId, setPendingId] = createSignal<string | null>(null);
  const [leaving, setLeaving] = createSignal<ReadonlySet<string>>(new Set());
  // A deleted draft stays out of the list even when the reload that drops it fails.
  const [deleted, setDeleted] = createSignal<ReadonlySet<string>>(new Set());
  const items = createMemo(() => props.page.items.filter((item) => !deleted().has(item.id)));
  const timers = new Set<ReturnType<typeof setTimeout>>();
  onCleanup(() => {
    for (const timer of timers) clearTimeout(timer);
  });
  const add = (set: ReadonlySet<string>, id: string) => new Set([...set, id]);
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
  const retryToast = createRetryToasts();
  /** Only the list is stale after a failed reload, so Retry repeats the reload, never the delete. */
  const refresh = (): void => {
    props.onRefresh().catch((error: unknown) =>
      retryToast(error instanceof Error ? error.message : String(error), {
        title: t().draftsRefreshFailed,
        retryLabel: t().retry,
        retry: async () => refresh(),
      }),
    );
  };

  /** What the person confirmed: the draft as its row showed it, not as a later reload may change it meanwhile. */
  type DeleteTarget = Pick<DraftFolderItem, "id" | "revision">;
  const deleteDraft = mutation.create<true, DeleteTarget, { item: DeleteTarget }>({
    onBefore: (item) => {
      setPendingId(item.id);
      return { item };
    },
    mutation: async (item, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].drafts[":draftId"].discard.$post(
        { param: { mailboxId: props.mailboxId, draftId: item.id }, json: { expectedRevision: item.revision } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw await readApiFailure(response, t().deleteDraftFailed);
      return true;
    },
    onSuccess: (_removed, context) => {
      const id = context?.item.id;
      if (!id) return;
      toast.success(t().draftDeleted);
      keepFocus(id);
      setLeaving((current) => add(current, id));
      const timer = setTimeout(() => {
        timers.delete(timer);
        setDeleted((current) => add(current, id));
      }, LEAVE_MS);
      timers.add(timer);
      refresh();
    },
    onError: (error) => {
      const code = error instanceof MailApiError ? error.code : null;
      // An open composer holds the draft, or someone changed it since the list loaded: the draft stays either way.
      toast.error(code === LEASE_HELD ? t().draftInUse : code === "CONFLICT" ? t().draftChangedBeforeDelete : error.message);
      // The server answered: reload, so the row shows the draft as it is now, or leaves once it was sent meanwhile.
      if (error instanceof MailApiError) refresh();
    },
    onFinally: () => setPendingId(null),
  });
  onCleanup(deleteDraft.abort);
  // The row shows its request only once the person confirmed; one delete runs at a time.
  let confirming = false;
  const requestDelete = async (item: DraftFolderItem) => {
    if (confirming || pendingId()) return;
    confirming = true;
    // A reload during the question may update the row in place; the delete keeps the revision the person saw.
    const target: DeleteTarget = { id: item.id, revision: item.revision };
    try {
      const confirmed = await prompts.confirm(t().deleteDraftDescription({ subject: item.subject || t().noSubject }), {
        title: t().deleteDraftQuestion,
        confirmText: t().deleteDraft,
        variant: "danger",
      });
      if (confirmed) void deleteDraft.mutate(target);
    } finally {
      confirming = false;
    }
  };

  return (
    <section
      class="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[var(--ui-surface)]"
      style={{ "--mail-time-samples": timeColumnSizer() }}
      aria-busy={props.loading}
    >
      <h1 ref={heading} tabIndex={-1} class="sr-only">
        {props.title}
      </h1>
      <Show when={pendingId()}>
        <span class="sr-only" role="status">
          {t().deletingDraft}
        </span>
      </Show>
      <ScrollArea class="mail-columns-area flex-1 pb-2" inset>
        <Show
          when={!props.error}
          fallback={<Placeholder state="error" variant="panel" title={t().draftsUnavailable} description={props.error!} />}
        >
          <Show
            when={items().length > 0}
            fallback={<Placeholder icon="ti ti-file-pencil" variant="panel" title={t().noDrafts} description={t().noDraftsDescription} />}
          >
            <Show when={props.columns}>
              <div class="mail-columns-head mail-columns-personal" aria-hidden="true">
                <span />
                <span class="mail-columns-head-cells">
                  <span>{t().columnTo}</span>
                  <span>{listText().columnSubject}</span>
                  <span class="mail-columns-head-participants">{t().columnStartedBy}</span>
                  <span class="mail-columns-head-time">{listText().columnTime}</span>
                </span>
              </div>
            </Show>
            <div
              class="flex flex-col gap-0.5"
              classList={{ "mail-columns mail-columns-personal": props.columns }}
              style={{ opacity: props.loading ? 0.5 : undefined }}
              ref={list}
              role="list"
              aria-label={t().draftListLabel({ title: props.title })}
              data-mail-drafts-list
            >
              <For each={items()}>
                {(item) => (
                  <MailDraftRow
                    item={item}
                    href={props.canWrite ? mailDraftHref(props.mailboxId, item.id, listHref(null)) : null}
                    columns={props.columns}
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
