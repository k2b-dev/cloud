import type { SaveStatusState } from "@k2b/ui";
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { setAreaSaveControls } from "./save-controls";

/** Thrown by `save` when the server answered with a reason; anything else counts as an unclear outcome. */
export class SaveRejected extends Error {}

type Options<T> = {
  initial: T;
  /** Field errors of a draft; Save stays disabled while there are any. */
  validate?: (value: T) => Record<string, string>;
  /** True when saving is needed although the values did not change, such as a confirmed replacement. */
  pending?: () => boolean;
  /** True while Save must wait for the person, for example to confirm replacing an unreadable value. */
  blocked?: () => boolean;
  /** Writes the draft and returns what is stored now. */
  save: (value: T) => Promise<T>;
  locale: () => string;
};

/**
 * A settings form that saves with a button: the draft, its field errors and the outcome of the last save. It registers
 * with the level head, which shows the status with Discard and Save. A failed save keeps the draft; when the
 * connection breaks, the outcome stays unclear and the person checks the current state instead of saving twice.
 */
export const createDraftForm = <T>(options: Options<T>) => {
  const [stored, setStored] = createSignal<T>(options.initial);
  const [draft, setDraft] = createSignal<T>(options.initial);
  const [saving, setSaving] = createSignal(false);
  const [outcome, setOutcome] = createSignal<{ kind: "failed" | "unknown"; message: string } | null>(null);
  const [savedAt, setSavedAt] = createSignal<string | undefined>(undefined);
  const errors = createMemo(() => options.validate?.(draft()) ?? {});
  const dirty = createMemo(() => JSON.stringify(draft()) !== JSON.stringify(stored()) || options.pending?.() === true);
  const state = createMemo<SaveStatusState>(() => {
    if (saving()) return "saving";
    if (outcome()?.kind === "unknown") return "unknown";
    if (Object.keys(errors()).length > 0) return "invalid";
    if (outcome()?.kind === "failed") return "failed";
    return dirty() ? "draft" : "saved";
  });

  const save = async () => {
    if (saving() || !dirty() || Object.keys(errors()).length > 0 || outcome()?.kind === "unknown" || options.blocked?.()) return;
    setSaving(true);
    setOutcome(null);
    try {
      const next = await options.save(draft());
      setStored(() => next);
      setDraft(() => next);
      setSavedAt(new Intl.DateTimeFormat(options.locale(), { hour: "2-digit", minute: "2-digit" }).format(new Date()));
    } catch (error) {
      setOutcome({
        kind: error instanceof SaveRejected ? "failed" : "unknown",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };
  const discard = () => {
    setDraft(() => stored());
    setOutcome((current) => (current?.kind === "unknown" ? current : null));
  };

  createEffect(() =>
    setAreaSaveControls({
      state: state(),
      savedAt: savedAt(),
      invalidCount: Object.keys(errors()).length,
      saveDisabled: options.blocked?.() === true,
      save: () => void save(),
      discard,
    }),
  );
  onCleanup(() => setAreaSaveControls(null));

  return {
    draft,
    update: (change: Partial<T>) => setDraft((current) => ({ ...current, ...change })),
    errors,
    outcome,
    saving,
    save,
    discard,
  };
};
