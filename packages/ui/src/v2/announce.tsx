/**
 * News for assistive technology that no element on the page shows as it happens, such as a run that changed its
 * state or new mail that arrived: `announce("Lauf 3 ist fertig.")`. A screen reader says it when it is idle;
 * `{ assertive: true }` says it at once, for news that cannot wait (a run that failed).
 */

/**
 * News closer together than this is one burst: only its last news is said. A screen reader needs about this long to
 * start speaking, and a run of state changes is then said as the state it reached.
 */
const BURST_MS = 250;
/**
 * A burst that never pauses (progress every 100 ms) still says its latest news this often, so a person waiting for a
 * long run hears where it stands at least once a second.
 */
const MAX_WAIT_MS = 1000;
/**
 * Said news stays this long, then leaves the region: long enough for a screen reader to have said it, short enough
 * that a person browsing the page later does not find old news.
 */
const SPOKEN_MS = 5000;

/**
 * The one live region of a page, in the server markup: a region that exists before its first news is heard, one
 * added with its news often is not. `Workspace` renders it; it takes no room and shows nothing.
 */
export const Announcer = () => (
  <div class="k2-hidden-text" data-k2-part="Announcer">
    <div role="status" aria-live="polite" data-k2-news="polite" />
    <div role="alert" aria-live="assertive" data-k2-news="assertive" />
  </div>
);

type Kind = "polite" | "assertive";

/**
 * The region of the page, found through the page when the news is said: every island bundles its own copy of
 * `@k2b/ui`, and a module here would not see a Workspace another island renders. With several Workspaces the first
 * one shown takes the news (a hidden one is never heard); without one the news brings a region of its own, once.
 */
const region = (kind: Kind): Element => {
  for (const found of document.querySelectorAll(`[data-k2-part="Announcer"] [data-k2-news="${kind}"]`)) {
    const wrap = found.parentElement;
    if (wrap && !wrap.closest("[hidden]") && wrap.getClientRects().length > 0) return found;
  }
  const host = document.createElement("div");
  host.className = "k2-ui";
  host.style.display = "contents";
  const wrap = document.createElement("div");
  wrap.className = "k2-hidden-text";
  wrap.setAttribute("data-k2-part", "Announcer");
  const make = (role: string, live: Kind) => {
    const element = document.createElement("div");
    element.setAttribute("role", role);
    element.setAttribute("aria-live", live);
    element.setAttribute("data-k2-news", live);
    return element;
  };
  const polite = make("status", "polite");
  const urgent = make("alert", "assertive");
  wrap.append(polite, urgent);
  host.append(wrap);
  document.body.append(host);
  return kind === "assertive" ? urgent : polite;
};

/** The news that waits to be said, by kind: its words, when its burst began, and the timer that says it. */
const waiting = new Map<Kind, { text: string; since: number; timer: ReturnType<typeof setTimeout> }>();

const speak = (kind: Kind) => {
  const news = waiting.get(kind);
  if (!news) return;
  waiting.delete(kind);
  const target = region(kind);
  const node = document.createElement("div");
  node.textContent = news.text;
  // the news before leaves: a removal is not said, the new node is
  target.replaceChildren(node);
  setTimeout(() => node.remove(), SPOKEN_MS);
};

/**
 * Says `text` to assistive technology: politely, or at once with `assertive`. The same words twice are said twice
 * (each news is a node of its own); news within one burst is said as its last news, at least once a second.
 */
export const announce = (text: string, options: { assertive?: boolean } = {}): void => {
  if (typeof document === "undefined" || !text.trim()) return;
  const kind: Kind = options.assertive ? "assertive" : "polite";
  const now = Date.now();
  const before = waiting.get(kind);
  if (before) clearTimeout(before.timer);
  const since = before?.since ?? now;
  const timer = setTimeout(() => speak(kind), Math.max(0, Math.min(BURST_MS, since + MAX_WAIT_MS - now)));
  waiting.set(kind, { text, since, timer });
};
