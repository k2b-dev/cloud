import type { SaveStatusState } from "@k2b/ui";
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";

/**
 * A settings form saves with the button in its level head, outside the form island. Both islands read this store: the
 * form registers its state and actions, `SettingsSaveStatus` renders them. One form per page registers at a time.
 */
export type SettingsSaveControls = {
  state: SaveStatusState;
  savedAt?: string;
  invalidCount?: number;
  save: () => void;
  discard: () => void;
};

const [controls, setControls] = createSignal<SettingsSaveControls | null>(null);
export const settingsSaveControls = controls;

/** A save that did not succeed: refused with a reason, or with an unclear outcome. */
export type SettingsDraftOutcome = { kind: "failed" | "unknown"; message: string };

/** Thrown by `save` when the server refused the write; anything else counts as an unclear outcome. */
export class SaveRejected extends Error {}

/**
 * The error for a non-OK save response. A 4xx refused the write. A 5xx can come after the value was stored (for
 * example when a follow-up step failed), so its outcome stays unclear and the person checks the current state.
 */
export const saveFailure = (status: number, message: string): Error =>
  status >= 400 && status < 500 ? new SaveRejected(message) : new Error(message);

/**
 * For endpoints that write in one step and answer afterwards: an error body with a message comes from the handler,
 * which did not store the value, so the save is refused and can be tried again. A response without one (a proxy
 * page, a crash) leaves the outcome unclear.
 */
export const oneStepFailure = (status: number, body: { message?: string } | null, fallback: string): Error =>
  body?.message ? new SaveRejected(body.message) : saveFailure(status, fallback);

type Options<T> = {
  initial: T;
  /** Field errors of a draft; Save stays disabled while there are any. */
  validate?: (value: T) => Record<string, string>;
  /** True when saving is needed although the values did not change, such as a confirmed replacement. */
  pending?: () => boolean;
  /**
   * Writes the draft and returns what is stored now. A save that writes several values one after another reports
   * each stored step with `commit`, so a later failure keeps what already reached the server as the saved state.
   */
  save: (value: T, commit: (stored: T) => void) => Promise<T>;
  locale: () => string;
};

/**
 * A settings form that saves with a button: the draft, its field errors and the outcome of the last save. It registers
 * with the level head, which shows the status with Discard and Save. A failed save keeps the draft; when the
 * connection breaks, the outcome stays unclear and the person checks the current state instead of saving twice.
 */
export const createSettingsDraft = <T>(options: Options<T>) => {
  const [stored, setStored] = createSignal<T>(options.initial);
  const [draft, setDraft] = createSignal<T>(options.initial);
  const [saving, setSaving] = createSignal(false);
  const [outcome, setOutcome] = createSignal<SettingsDraftOutcome | null>(null);
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
    if (saving() || !dirty() || Object.keys(errors()).length > 0 || outcome()?.kind === "unknown") return;
    setSaving(true);
    setOutcome(null);
    const submitted = draft();
    // Edits made while the request runs stay; only an untouched draft takes the stored values.
    const settle = (next: T) => {
      setStored(() => next);
      if (draft() === submitted) setDraft(() => next);
    };
    try {
      // A step only moves the saved state; the draft keeps the values still on their way.
      settle(await options.save(submitted, (step) => setStored(() => step)));
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

  // Leaving the page with unsaved changes asks first, as the settings pages did before.
  if (typeof window !== "undefined") {
    const guard = (event: BeforeUnloadEvent) => {
      if (state() === "saved") return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    onCleanup(() => window.removeEventListener("beforeunload", guard));
  }

  createEffect(() =>
    setControls({
      state: state(),
      savedAt: savedAt(),
      invalidCount: Object.keys(errors()).length,
      save: () => void save(),
      discard,
    }),
  );
  onCleanup(() => setControls(null));

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
