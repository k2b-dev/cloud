import { prompts } from "@k2b/ui";

/** The stable codes Cloud answers when new access needs a recent browser sign-in. */
export class SignInNeededError extends Error {
  constructor(readonly code: "REAUTHENTICATE" | "BROWSER_SIGN_IN_REQUIRED") {
    super(code);
  }
}

/** Throws SignInNeededError for those codes; any other failure stays the caller's. */
export const throwIfSignInNeeded = async (res: { status: number; json: () => Promise<unknown> }): Promise<void> => {
  if (res.status !== 403) return;
  const body = await res.json().catch(() => null);
  const code = body && typeof body === "object" && "code" in body ? body.code : null;
  if (code === "REAUTHENTICATE" || code === "BROWSER_SIGN_IN_REQUIRED") throw new SignInNeededError(code);
};

type ReturnIntent = { key: string; value: string };

const draftKey = (intent: ReturnIntent) => `k2b:confirm-identity:${intent.key}=${intent.value}`;

/**
 * Asks to sign in again, then returns to this page with `intent` so the island reopens the
 * dialog the person started from, filled with `draft`. Cancel keeps the person on the page.
 */
export const confirmIdentity = async (
  message: string,
  intent: ReturnIntent,
  labels: { title: string; confirm: string },
  draft?: unknown,
): Promise<void> => {
  const confirmed = await prompts.confirm(message, { title: labels.title, icon: "ti ti-shield-lock", confirmText: labels.confirm });
  if (!confirmed) return;
  // The draft stays in this tab only; without storage the dialog simply opens empty.
  try {
    if (draft !== undefined) window.sessionStorage.setItem(draftKey(intent), JSON.stringify(draft));
  } catch {}
  const target = new URL(window.location.href);
  target.searchParams.set(intent.key, intent.value);
  target.searchParams.set("reauthenticate", "1");
  window.location.assign(`/auth/login?${new URLSearchParams({ redirectTo: target.pathname + target.search })}`);
};

/**
 * Set once when the page was opened with `intent`, with the stored draft or `null`; removes the
 * intent, the sign-in marker and the draft, so a reload does not reopen the dialog.
 */
export const takeReturnIntent = (intent: ReturnIntent): { draft: unknown } | null => {
  const url = new URL(window.location.href);
  if (url.searchParams.get(intent.key) !== intent.value) return null;
  url.searchParams.delete(intent.key);
  url.searchParams.delete("reauthenticate");
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  let draft: unknown = null;
  try {
    const stored = window.sessionStorage.getItem(draftKey(intent));
    window.sessionStorage.removeItem(draftKey(intent));
    draft = stored === null ? null : JSON.parse(stored);
  } catch {}
  return { draft };
};
