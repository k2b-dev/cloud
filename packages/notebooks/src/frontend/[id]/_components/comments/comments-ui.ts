import { clipboard } from "@k2b/stdlib/browser";
import { announce, personColor, prompts, toast } from "@k2b/ui";
import { type Accessor, batch, createMemo, createSignal } from "solid-js";
import type { Annotation } from "../../../../lib/annotation-contracts";
import { type CommentDraft, CommentRequestError, type CommentsStore } from "./comments-store";
import type { commentMessages } from "./messages";

type Words = ReturnType<typeof commentMessages.resolve>["t"];

/** Context the composer takes around a passage, as the server's contract counts it (UTF-16 units). */
export const CONTEXT_LENGTH = 32;
/** The author may change or delete their comment this long after writing it, like a Chat message. */
export const MUTATION_WINDOW_MS = 10 * 60 * 1000;

export type CommentsUi = ReturnType<typeof createCommentsUi>;

export const isOpen = (item: Annotation) => item.state === "open";

/**
 * What the margin and the editor share: which comment is open or pointed at, the comment being written, the
 * suggestion previewed in the text, and every action with its feedback. The store holds the data.
 */
export const createCommentsUi = (options: {
  store: CommentsStore;
  canWrite: Accessor<boolean>;
  me: { id: string; name: string };
  t: Accessor<Words>;
  /** The note's current text, to take a passage and its context for a new comment. */
  text: () => string;
  /** A link to this note with one comment open, for "Copy link". */
  linkTo: (id: string) => string;
  /** Puts the caret back into the text, at a position of the passage a comment was written for. */
  focusText: (pos: number) => void;
  /** Marks a passage's replacement green for a moment after its suggestion was accepted, before the reload moves it. */
  flash: (id: string, length: number) => void;
}) => {
  const { store } = options;
  const [active, setActive] = createSignal<string | null>(null);
  const [hover, setHover] = createSignal<string | null>(null);
  /** The suggestion previewed in the text: a thread's own, or one a reply carries. */
  const [preview, setPreview] = createSignal<{ id: string; replyId?: string } | null>(null);
  const [draft, setDraft] = createSignal<CommentDraft | null>(null);
  const [showResolved, setShowResolved] = createSignal(false);
  const [editing, setEditing] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<ReadonlySet<string>>(new Set());
  /** Counts each request to show every comment, from the toolbar: a list on a phone, the first one elsewhere. */
  const [listRequest, setListRequest] = createSignal(0);
  const myColor = personColor(options.me.name);

  const counts = createMemo(() => {
    const items = store.items();
    const open = items.filter(isOpen).length;
    return { open, resolved: items.length - open };
  });
  /** The comments the margin and the text show now, in text order. */
  const visible = createMemo(() =>
    store
      .items()
      .filter((item) => isOpen(item) || showResolved())
      .sort((a, b) => a.from - b.from || a.to - b.to),
  );
  const byId = (id: string | null) => (id ? store.items().find((item) => item.id === id) : undefined);

  const working = async (id: string, run: () => Promise<void>) => {
    setBusy((previous) => new Set(previous).add(id));
    try {
      await run();
    } finally {
      setBusy((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
    }
  };
  const failed = (error: unknown) => toast.error(error instanceof CommentRequestError ? error.message : options.t().actionFailed);

  const startDraft = (from: number, to: number) => {
    if (!options.canWrite() || to <= from) return false;
    const text = options.text();
    batch(() => {
      setActive(null);
      setEditing(null);
      setDraft({
        from,
        to,
        quote: text.slice(from, to),
        prefix: text.slice(Math.max(0, from - CONTEXT_LENGTH), from),
        suffix: text.slice(to, to + CONTEXT_LENGTH),
        body: "",
        suggestion: null,
        idempotencyKey: crypto.randomUUID(),
        saving: false,
        failed: false,
      });
    });
    return true;
  };

  const saveDraft = async () => {
    const current = draft();
    if (!current || current.saving) return;
    const suggestion = current.suggestion !== null && current.suggestion !== current.quote ? current.suggestion : null;
    if (!current.body.trim() && suggestion === null) return;
    setDraft({ ...current, saving: true, failed: false });
    try {
      const created = await store.create({ ...current, suggestion }, current.from);
      await store.reload();
      batch(() => {
        setDraft(null);
        setActive(created.id);
      });
    } catch {
      // The text stays in the composer; the button now says "Try again" with the same key.
      setDraft((latest) => latest && { ...latest, saving: false, failed: true });
    }
  };

  const resolve = (item: Annotation, resolved: boolean) =>
    working(item.id, async () => {
      if (resolved) {
        store.hide(item.id, !showResolved());
        if (active() === item.id) setActive(null);
      }
      try {
        await store.resolve(item.id, resolved);
        await store.reload();
        if (resolved)
          toast(options.t().resolvedToast, {
            action: { label: options.t().undo, onClick: () => void resolve(item, false) },
          });
        else setActive(item.id);
      } catch (error) {
        failed(error);
      } finally {
        store.hide(item.id, false);
      }
    });

  const remove = (item: Annotation) =>
    working(item.id, async () => {
      store.hide(item.id, true);
      if (active() === item.id) setActive(null);
      try {
        await store.remove(item.id);
        await store.reload();
        toast(options.t().deleted, {
          action: {
            label: options.t().undo,
            onClick: () =>
              void store
                .restore(item.id)
                .then(() => store.reload())
                .catch(failed),
          },
        });
      } catch (error) {
        failed(error);
      } finally {
        store.hide(item.id, false);
      }
    });

  /**
   * Accept and undo are durable operations: an outcome the server could not confirm keeps its operation ID, so trying
   * again finishes that same operation instead of starting a second one. A new ID starts only after a clear answer.
   */
  const operations = new Map<string, string>();
  const operationId = (key: string) => {
    const known = operations.get(key);
    if (known) return known;
    const id = crypto.randomUUID();
    operations.set(key, id);
    return id;
  };
  const uncertain = (error: unknown) => error instanceof CommentRequestError && error.status >= 500;
  const retryToast = (retry: () => void) => toast.error(options.t().actionFailed, { action: { label: options.t().retry, onClick: retry } });

  const undoAccept = (item: Annotation) =>
    working(item.id, async () => {
      const key = `undo:${item.id}`;
      try {
        await store.undoAccept(item.id, operationId(key));
        operations.delete(key);
        await store.reload();
      } catch (error) {
        if (uncertain(error)) return void retryToast(() => void undoAccept(item));
        operations.delete(key);
        if (error instanceof CommentRequestError && error.status === 409) toast.error(options.t().undoFailed);
        else failed(error);
      }
    });

  /** The suggestion a thread or one of its replies carries. */
  const suggestionOf = (item: Annotation, replyId?: string) =>
    (replyId ? item.replies.find((reply) => reply.id === replyId)?.suggestion : item.suggestion) ?? null;

  const accept = (item: Annotation, expectedText?: string, replyId?: string): Promise<void> =>
    working(item.id, async () => {
      setPreview(null);
      const key = `accept:${item.id}:${replyId ?? ""}:${expectedText ?? ""}`;
      try {
        await store.accept(item.id, operationId(key), expectedText, replyId);
        operations.delete(key);
        options.flash(item.id, (suggestionOf(item, replyId) ?? "").length);
        await store.reload();
        if (active() === item.id) setActive(null);
        announce(options.t().accepted);
        toast(options.t().accepted, { action: { label: options.t().undo, onClick: () => void undoAccept(item) } });
      } catch (error) {
        if (uncertain(error)) return void retryToast(() => void accept(item, expectedText, replyId));
        operations.delete(key);
        const current = error instanceof CommentRequestError ? error.details?.currentText : undefined;
        if (error instanceof CommentRequestError && error.status === 409 && typeof current === "string" && expectedText === undefined) {
          const again = await prompts.confirm(`${options.t().acceptChanged}\n\n„${current}“`, {
            title: options.t().accept,
            confirmText: options.t().acceptCurrent,
          });
          if (again === true) await accept(item, current, replyId);
          return;
        }
        failed(error);
      }
    });

  /** Rejects a suggestion without touching the text; the toast takes it back. */
  const reject = (item: Annotation, replyId?: string, rejected = true): Promise<void> =>
    working(item.id, async () => {
      setPreview(null);
      try {
        await store.reject(item.id, rejected, replyId);
        await store.reload();
        if (rejected)
          toast(options.t().rejected, { action: { label: options.t().undo, onClick: () => void reject(item, replyId, false) } });
      } catch (error) {
        failed(error);
      }
    });

  const reply = async (item: Annotation, body: string, key: string) => {
    await store.reply(item.id, body.trim(), key);
    await store.reload();
  };

  const edit = async (item: Annotation, body: string) => {
    await store.edit(item.id, body.trim());
    await store.reload();
    setEditing(null);
  };

  const copyLink = async (item: Annotation) => {
    await clipboard.copy(options.linkTo(item.id));
    toast(options.t().linkCopied);
  };

  /** A click on overlapping passages opens the next of them each time. */
  const activateFrom = (ids: string[]) => {
    const current = active();
    const index = current ? ids.indexOf(current) : -1;
    batch(() => {
      setDraft(null);
      setActive(ids[(index + 1) % ids.length] ?? null);
    });
  };

  return {
    store,
    me: options.me,
    myColor,
    canWrite: options.canWrite,
    t: options.t,
    active,
    setActive,
    hover,
    setHover,
    preview,
    setPreview,
    draft,
    setDraft,
    showResolved,
    setShowResolved,
    editing,
    setEditing,
    busy,
    counts,
    visible,
    byId,
    startDraft,
    saveDraft,
    /** Drops the comment being written and returns to its passage. */
    cancelDraft: () => {
      const current = draft();
      setDraft(null);
      if (current) options.focusText(current.to);
    },
    resolve,
    remove,
    accept,
    reject,
    suggestionOf,
    reply,
    edit,
    copyLink,
    activateFrom,
    listRequest,
    requestList: () => setListRequest((value) => value + 1),
  };
};
