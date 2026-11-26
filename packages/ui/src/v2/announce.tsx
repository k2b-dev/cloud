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
 * The one live region of a page, in the server markup: a region that exists before its first news is heard, one
 * added with its news often is not. `Workspace` renders it; it takes no room and shows nothing.
 */
export const Announcer = () => (
  <div class="k2-hidden-text" data-k2-part="Announcer">
    <div role="status" aria-live="polite" data-k2-news="polite" />
    <div role="alert" aria-live="assertive" data-k2-news="assertive" />
  </div>
);

/** The news that waits to be said in each region of the page. */
const pending = new WeakMap<Element, ReturnType<typeof setTimeout>>();

/**
 * The region of the page, found through the page: every island bundles its own copy of `@k2b/ui`, and a module here
 * would not see a Workspace another island renders. Without a Workspace the news brings a region of its own, once.
 */
const region = (assertive: boolean): Element => {
  const selector = `[data-k2-part="Announcer"] [data-k2-news="${assertive ? "assertive" : "polite"}"]`;
  const found = document.querySelector(selector);
  if (found) return found;
  const host = document.createElement("div");
  host.className = "k2-ui";
  host.style.display = "contents";
  const wrap = document.createElement("div");
  wrap.className = "k2-hidden-text";
  wrap.setAttribute("data-k2-part", "Announcer");
  const make = (role: string, live: string) => {
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
  return assertive ? urgent : polite;
};

/**
 * Says `text` to assistive technology: politely, or at once with `assertive`. The same words twice are said twice
 * (each news is a node of its own); news within one burst is said as its last news.
 */
export const announce = (text: string, options: { assertive?: boolean } = {}): void => {
  if (typeof document === "undefined" || !text.trim()) return;
  const target = region(options.assertive === true);
  clearTimeout(pending.get(target));
  const timer = setTimeout(() => {
    pending.delete(target);
    const news = document.createElement("div");
    news.textContent = text;
    // the news before leaves: a removal is not said, the new node is
    target.replaceChildren(news);
  }, BURST_MS);
  pending.set(target, timer);
};
