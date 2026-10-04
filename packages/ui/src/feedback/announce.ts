export type AnnouncePoliteness = "polite" | "assertive";

export type AnnounceOptions = {
  /** `polite` waits until the screen reader is idle; `assertive` interrupts it. Defaults to `polite`. */
  politeness?: AnnouncePoliteness;
};

/** A live region needs a moment between being found and being written to. */
const ANNOUNCE_DELAY_MS = 100;
const ANNOUNCEMENT_LIFETIME_MS = 7_000;
const LIVE_ATTRIBUTE = "data-k2b-live";
const VISUALLY_HIDDEN =
  "position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;";

/**
 * One pair of persistent, empty live regions per document, polite and assertive, shared by `announce` and every
 * toast. A region that already exists when its text arrives is announced reliably, unlike one inserted with its text
 * already inside. They sit directly in the body, outside every portal and the toast rail, which moves into a fresh
 * top-layer element for every toast, so no scope that closes takes them along.
 */
export const ensureLiveRegions = (doc: Document): HTMLElement => {
  const existing = doc.querySelector<HTMLElement>(`[${LIVE_ATTRIBUTE}]`);
  if (existing) return existing;
  const live = doc.createElement("div");
  live.setAttribute(LIVE_ATTRIBUTE, "");
  live.style.cssText = VISUALLY_HIDDEN;
  for (const politeness of ["polite", "assertive"] as const) {
    const region = doc.createElement("div");
    region.setAttribute("role", politeness === "assertive" ? "alert" : "status");
    region.setAttribute("aria-live", politeness);
    // Both roles are atomic by default, which would read every line still in the region again with each new one.
    region.setAttribute("aria-atomic", "false");
    region.dataset.politeness = politeness;
    live.appendChild(region);
  }
  doc.body.appendChild(live);
  return live;
};

/**
 * Tells screen readers about an outcome without showing anything: a change the screen shows but the focused control
 * does not say, because a shortcut acted, the control was busy, or it was replaced. Each message is its own line, so
 * a burst of messages or the same message twice is still read. Calls without `document`, including during SSR, do
 * nothing.
 */
export const announce = (message: string, options?: AnnounceOptions): void => {
  if (typeof document === "undefined" || !message) return;
  const politeness = options?.politeness ?? "polite";
  const region = ensureLiveRegions(document).querySelector<HTMLElement>(`[data-politeness="${politeness}"]`);
  if (!region) return;
  const line = document.createElement("div");
  line.textContent = message;
  setTimeout(() => {
    region.appendChild(line);
    setTimeout(() => line.remove(), ANNOUNCEMENT_LIFETIME_MS);
  }, ANNOUNCE_DELAY_MS);
};
