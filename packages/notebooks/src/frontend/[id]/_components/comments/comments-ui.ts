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
  /** Marks a passage's replacement green for a moment after its suggestion was accepted, before the reload moves it. */
  flash: (id: string, length: number) => void;
}) => {
  const { store } = options;
  const [active, setActive] = createSignal<string | null>(null);
  const [hover, setHover] = createSignal<string | null>(null);
  const [preview, setPreview] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal<CommentDraft | null>(null);
  const [showResolved, setShowResolved] = createSignal(false);
  const [editing, setEditing] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<ReadonlySet<string>>(new Set());
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

  const accept = (item: Annotation, expectedText?: string): Promise<void> =>
    working(item.id, async () => {
      setPreview(null);
      try {
        await store.accept(item.id, crypto.randomUUID(), expectedText);
        options.flash(item.id, (item.suggestion ?? "").length);
        await store.reload();
        if (active() === item.id) setActive(null);
        announce(options.t().accepted);
        toast(options.t().accepted, {
          action: {
            label: options.t().undo,
            onClick: () =>
              void store
                .undoAccept(item.id, crypto.randomUUID())
                .then(() => store.reload())
                .catch((error) =>
                  error instanceof CommentRequestError && error.status === 409 ? toast.error(options.t().undoFailed) : failed(error),
                ),
          },
        });
      } catch (error) {
        const current = error instanceof CommentRequestError ? error.details?.currentText : undefined;
        if (error instanceof CommentRequestError && error.status === 409 && typeof current === "string" && expectedText === undefined) {
          const again = await prompts.confirm(`${options.t().acceptChanged}\n\n„${current}“`, {
            title: options.t().accept,
            confirmText: options.t().acceptCurrent,
          });
          if (again === true) await accept(item, current);
          return;
        }
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
    resolve,
    remove,
    accept,
    reply,
    edit,
    copyLink,
    activateFrom,
  };
};
