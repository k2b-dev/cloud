import { mutation } from "@k2b/stdlib/solid";
import { toast, useLocale } from "@k2b/ui";
import { createMemo, createSignal, onCleanup } from "solid-js";
import { apiClient } from "../../api/client";
import type { DraftFolderItem, DraftLeaseErrorCode } from "../../contracts";
import { MailApiError, readApiFailure } from "./api-response";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";
import { createRetryToasts } from "./mail-feedback";

/** An open composer holds the draft. The contracts module carries Zod, so the mailbox island imports only its types. */
const LEASE_HELD = "DRAFT_LEASE_HELD" satisfies DraftLeaseErrorCode;

/** The collapse of a deleted row (`mail-list-row-leave`); the list drops the row once it ends. */
const LEAVE_MS = 160;

/** What the person confirmed: the draft as its row showed it, not as a later reload may change it meanwhile. */
type DeleteTarget = Pick<DraftFolderItem, "id" | "revision">;

/**
 * Deleting a draft from the Drafts folder, for the v1 list and the v2 list alike: the question first (`confirm`, in the
 * look of the view), then the delete with the revision the person saw. An open composer that holds the draft, or a
 * change since the list loaded, keeps it. A deleted draft stays out of the list even when the reload that drops it
 * fails.
 */
export function createMailDraftDelete(props: {
  mailboxId: () => string;
  /** Reloads the folder after a delete. */
  onRefresh: () => Promise<void>;
  /** Asks before the delete; `true` deletes, anything else (also a question closed without answer) keeps the draft. */
  confirm: (item: DraftFolderItem) => Promise<boolean | undefined>;
  /** The row is about to leave: the view moves the focus off it. */
  onLeave?: (id: string) => void;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailConversationUiMessages.resolve([locale()]).t);
  const [pendingId, setPendingId] = createSignal<string | null>(null);
  const [leaving, setLeaving] = createSignal<ReadonlySet<string>>(new Set());
  const [deleted, setDeleted] = createSignal<ReadonlySet<string>>(new Set());
  const timers = new Set<ReturnType<typeof setTimeout>>();
  onCleanup(() => {
    for (const timer of timers) clearTimeout(timer);
  });
  const add = (set: ReadonlySet<string>, id: string) => new Set([...set, id]);
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

  const deleteDraft = mutation.create<true, DeleteTarget, { item: DeleteTarget }>({
    onBefore: (item) => {
      setPendingId(item.id);
      return { item };
    },
    mutation: async (item, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].drafts[":draftId"].discard.$post(
        { param: { mailboxId: props.mailboxId(), draftId: item.id }, json: { expectedRevision: item.revision } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw await readApiFailure(response, t().deleteDraftFailed);
      return true;
    },
    onSuccess: (_removed, context) => {
      const id = context?.item.id;
      if (!id) return;
      toast.success(t().draftDeleted);
      props.onLeave?.(id);
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
      if (await props.confirm(item)) void deleteDraft.mutate(target);
    } finally {
      confirming = false;
    }
  };

  return {
    t,
    pendingId,
    leaving,
    /** The drafts of the page without those deleted here. */
    shown: (items: readonly DraftFolderItem[]) => items.filter((item) => !deleted().has(item.id)),
    requestDelete,
  };
}
