import type { FloatingWindowRect, FloatingWindowState } from "@k2b/ui";
import { createSignal } from "solid-js";
import type { MailDraft } from "../../contracts";

/**
 * Drafts open as floating windows over the mailbox. The open windows are a state of this tab and mailbox: they live in
 * `sessionStorage`, so a reload or a return from another app (which loads the page again) opens them again. Nothing is
 * stored on the server; the drafts themselves are.
 */
export type StoredComposeWindow = { draftId: string; state: FloatingWindowState; rect?: FloatingWindowRect };

export const composeWindowsKey = (mailboxId: string): string => `cloud:mail:compose-windows:${mailboxId}`;

const states: readonly FloatingWindowState[] = ["normal", "minimized", "maximized"];
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const draftIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

const readRect = (value: unknown): FloatingWindowRect | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const { x, y, width, height } = value as Record<string, unknown>;
  return finite(x) && finite(y) && finite(width) && finite(height) && width > 0 && height > 0 ? { x, y, width, height } : undefined;
};

/** The windows this tab had open in the mailbox, in the order they opened. Anything unreadable is left out. */
export const readComposeWindows = (storage: Pick<Storage, "getItem">, mailboxId: string): StoredComposeWindow[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(storage.getItem(composeWindowsKey(mailboxId)) ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const windows: StoredComposeWindow[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const { draftId, state, rect } = entry as Record<string, unknown>;
    if (typeof draftId !== "string" || !draftIdPattern.test(draftId) || seen.has(draftId)) continue;
    seen.add(draftId);
    const stored: StoredComposeWindow = { draftId, state: states.includes(state as FloatingWindowState) ? (state as FloatingWindowState) : "normal" };
    const place = readRect(rect);
    if (place) stored.rect = place;
    windows.push(stored);
  }
  return windows;
};

/** Remembers the open windows; a failing storage (private mode, quota) only costs the restore after a reload. */
export const writeComposeWindows = (storage: Pick<Storage, "setItem" | "removeItem">, mailboxId: string, windows: StoredComposeWindow[]) => {
  try {
    if (windows.length === 0) storage.removeItem(composeWindowsKey(mailboxId));
    else storage.setItem(composeWindowsKey(mailboxId), JSON.stringify(windows));
  } catch {
    // The windows stay open; only the restore after a reload is lost.
  }
};

export type DraftWindowOpenOptions = {
  /** The draft as the caller already has it; the window then skips loading it once more. */
  initialDraft?: MailDraft;
  /** True when this click created the draft: closing it unchanged discards it again. */
  fresh?: boolean;
  /** Where the focus returns when the window closes; defaults to the element focused when it opened. */
  returnFocus?: HTMLElement | null;
};

/** The mailbox's window host; the open mailbox registers it while it is mounted. */
export type DraftWindowHost = {
  mailboxId: string;
  open: (draftId: string, options: DraftWindowOpenOptions) => void;
  isOpen: (draftId: string) => boolean;
  recall: (draftId: string) => Promise<boolean>;
};

const [host, setHost] = createSignal<DraftWindowHost | null>(null);
/** Opens asked for before the mailbox mounted its host, such as a draft named by the first URL. */
let pending: { mailboxId: string | null; draftId: string; options: DraftWindowOpenOptions }[] = [];

export const registerDraftWindowHost = (next: DraftWindowHost): (() => void) => {
  setHost(() => next);
  const waiting = pending.filter((entry) => entry.mailboxId === null || entry.mailboxId === next.mailboxId);
  pending = [];
  for (const entry of waiting) next.open(entry.draftId, entry.options);
  return () => {
    if (host() === next) setHost(null);
  };
};

/**
 * Opens a draft of the open mailbox as a floating window, or brings its window back when it is already open. A reply
 * draft opens with its recipients as for a reply. `mailboxId` guards against a mailbox switch in between: a draft of
 * another mailbox never opens here. Before the mailbox mounted, the request waits for it.
 */
export const openDraftWindow = (draftId: string, options: DraftWindowOpenOptions & { mailboxId?: string } = {}): void => {
  const current = host();
  const mailboxId = options.mailboxId ?? null;
  if (!current) {
    pending.push({ mailboxId, draftId, options });
    return;
  }
  if (mailboxId !== null && current.mailboxId !== mailboxId) return;
  current.open(draftId, options);
};

/** Whether a draft is open in a window of this tab; reactive, so a reply box can show "Opened in a window". */
export const draftWindowOpen = (draftId: string): boolean => host()?.isOpen(draftId) ?? false;

/**
 * Takes a draft back out of its window, such as into the reply box: the window saves the draft, releases it, and closes
 * without a notice. Resolves `false` when no window held it or the draft could not be released (the window then stays).
 */
export const recallDraftWindow = (draftId: string): Promise<boolean> => host()?.recall(draftId) ?? Promise.resolve(false);
