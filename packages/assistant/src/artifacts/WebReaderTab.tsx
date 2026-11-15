import type { WebReaderResult } from "@k2b/cloud/ai";
import { Button, Dropdown, type DropdownItem, IconButton, IconButtonLink, MarkdownView, Skeleton, useLocale } from "@k2b/ui";
import { createResource, createSignal, Match, Show, Switch } from "solid-js";
import { readWebPage } from "../api/web-reader-client";
import { isWebAddress } from "../web-address";
import { webReaderMessages } from "./web-reader-messages";

/** A day and time in the reader's words: "heute, 14:12", or the date before today. */
const standOf = (iso: string, locale: string, today: string, now = new Date()) => {
  const date = new Date(iso);
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date);
  return date.toDateString() === now.toDateString()
    ? `${today}, ${time}`
    : `${new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(date)}, ${time}`;
};

/** What the address carries to the website, as "wert = 2000 · ziel = lyon". */
const queryOf = (url: string) => {
  if (!URL.canParse(url)) return "";
  return [...new URL(url).searchParams].map(([name, value]) => `${name} = ${value}`).join(" · ");
};

/**
 * A web page as a tab: the reading view of stage 1 (concept gustav-ui-neu 3l). Cloud fetches the page for the person
 * through the operator's Firecrawl service with the rule Gustav follows: an address from the chat reads at once, any
 * other asks first with the full address. The text shows as untrusted Markdown, without pictures, scripts, or sign-in;
 * the mark names the time of the content, not of the click. Links on the page open here, in the same tab.
 */
export function WebReaderTab(props: {
  conversationId: string;
  url: string;
  onTitle: (title: string) => void;
  /** "Don't fetch" on the page the tab opened with: the tab closes. */
  onDismiss: () => void;
  /** The menu "…" of the pane, with what Cloud can do with the page. */
  menu: (url: string) => DropdownItem[];
  menuLabel: string;
}) {
  const locale = useLocale();
  const t = () => webReaderMessages.resolve([locale()]).t;
  const [history, setHistory] = createSignal({ entries: [props.url], index: 0 });
  const [confirmed, setConfirmed] = createSignal<string | null>(null);
  const [revision, setRevision] = createSignal(0);
  const current = () => history().entries[history().index]!;
  const [page] = createResource(
    () => ({ url: current(), confirmed: confirmed() === current(), revision: revision() }),
    async (request, { refetching }): Promise<WebReaderResult | { status: "error"; message: string }> => {
      void refetching;
      try {
        const result = await readWebPage(props.conversationId, { url: request.url, confirmed: request.confirmed });
        // The tab keeps the page it opened with; its title follows that page only.
        if (result.status === "ready" && request.url === props.url) props.onTitle(result.title);
        return result;
      } catch (error) {
        return { status: "error", message: error instanceof Error ? error.message : String(error) };
      }
    },
  );
  const go = (url: string) => {
    setHistory((state) => ({ entries: [...state.entries.slice(0, state.index + 1), url], index: state.index + 1 }));
  };
  const step = (delta: number) =>
    setHistory((state) => ({ ...state, index: Math.max(0, Math.min(state.entries.length - 1, state.index + delta)) }));
  // Links on a page that was read count as from the chat: they open here.
  const followLink = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    const href = link?.getAttribute("href");
    if (!href) return;
    // Relative links resolve against the page shown, where a redirect may have led.
    const base = ready()?.finalUrl ?? current();
    const target = URL.canParse(href, base) ? new URL(href, base) : null;
    if (!target || (target.protocol !== "https:" && target.protocol !== "http:")) return;
    event.preventDefault();
    go(target.href);
  };
  const ready = () => {
    const result = page.latest;
    return result?.status === "ready" ? result : null;
  };
  const shown = () => ready()?.finalUrl ?? current();
  const mark = () => (page.loading ? t().fetching : page.latest?.status === "confirm" ? t().notFetched : t().readingView);
  return (
    <div class="web-reader">
      <div class="web-reader__bar">
        <IconButton size="sm" variant="ghost" label={t().back} disabled={history().index === 0} onClick={() => step(-1)}>
          <i class="ti ti-arrow-left" aria-hidden="true" />
        </IconButton>
        <IconButton
          size="sm"
          variant="ghost"
          label={t().forward}
          disabled={history().index >= history().entries.length - 1}
          onClick={() => step(1)}
        >
          <i class="ti ti-arrow-right" aria-hidden="true" />
        </IconButton>
        <IconButton size="sm" variant="ghost" label={t().reload} disabled={page.loading} onClick={() => setRevision((value) => value + 1)}>
          <i class="ti ti-refresh" aria-hidden="true" />
        </IconButton>
        {/* The address is shown, not typed: the reading view opens pages from the chat only. */}
        <div class="web-reader__address" title={shown()}>
          <i class="ti ti-lock" aria-hidden="true" />
          <span class="k2b-truncate-fade">{shown().replace(/^https?:\/\//u, "")}</span>
        </div>
        <span class="web-reader__mark" data-state={page.loading ? "loading" : page.latest?.status}>
          <i class={page.latest?.status === "confirm" ? "ti ti-hand-stop" : "ti ti-book-2"} aria-hidden="true" />
          {mark()}
        </span>
        <IconButtonLink
          size="sm"
          variant="ghost"
          href={isWebAddress(shown()) ? shown() : undefined}
          target="_blank"
          rel="noopener noreferrer"
          label={t().openOwn}
          tooltip={t().openOwn}
        >
          <i class="ti ti-external-link" aria-hidden="true" />
        </IconButtonLink>
        <Dropdown.Root items={props.menu(shown())} align="end" label={props.menuLabel}>
          <Dropdown.Trigger iconOnly size="sm" variant="ghost" label={props.menuLabel}>
            <i class="ti ti-dots" aria-hidden="true" />
          </Dropdown.Trigger>
        </Dropdown.Root>
      </div>
      <div class="web-reader__body" aria-busy={page.loading ? "true" : undefined}>
        <Switch>
          <Match when={page.loading && !page.latest}>
            <div class="web-reader__loading" role="status" aria-label={t().fetching}>
              <Skeleton class="web-reader__skeleton web-reader__skeleton--title" />
              <Skeleton class="web-reader__skeleton" />
              <Skeleton class="web-reader__skeleton" />
              <Skeleton class="web-reader__skeleton web-reader__skeleton--short" />
            </div>
          </Match>
          <Match when={page.latest?.status === "confirm"}>
            <section class="web-reader__ask" aria-labelledby="web-reader-ask-title" data-k2b-primary="ai">
              <p class="web-reader__ask-kind">
                <i class="ti ti-shield-check" aria-hidden="true" />
                {t().approval}
                <span class="web-reader__ask-who">
                  · <i class="ti ti-sparkles" aria-hidden="true" /> Gustav
                </span>
              </p>
              <h3 id="web-reader-ask-title" class="web-reader__ask-title">
                {t().askTitle}
              </h3>
              <p class="web-reader__ask-why">
                <i class="ti ti-eye" aria-hidden="true" />
                {t().askWhy}
              </p>
              <div class="web-reader__ask-address">
                <span class="web-reader__ask-label">
                  <i class="ti ti-sparkles" aria-hidden="true" /> {t().askAddress}
                </span>
                <code>{current()}</code>
                <Show when={queryOf(current())}>
                  {(query) => <span class="web-reader__ask-query">{t().askQuery({ query: query() })}</span>}
                </Show>
              </div>
              <div class="web-reader__ask-foot">
                <p class="web-reader__ask-note">
                  <i class="ti ti-info-circle" aria-hidden="true" />
                  {t().askRemember}
                </p>
                <Button variant="ghost" class="web-reader__dont" onClick={() => (history().index === 0 ? props.onDismiss() : step(-1))}>
                  {t().dontFetch}
                </Button>
                <Button variant="primary" onClick={() => setConfirmed(current())}>
                  {t().fetch}
                </Button>
              </div>
            </section>
          </Match>
          <Match when={page.latest?.status === "redirect_blocked" && page.latest}>
            {(result) => (
              <div class="web-reader__notice" role="alert">
                <p>{t().redirectBlocked}</p>
                <p class="web-reader__meta">{(result() as Extract<WebReaderResult, { status: "redirect_blocked" }>).finalUrl}</p>
              </div>
            )}
          </Match>
          <Match when={page.latest?.status === "unreadable" || page.latest?.status === "error"}>
            <div class="web-reader__notice" role="alert">
              <p>{t().unreadable}</p>
              <p class="web-reader__meta">{t().unreadableDetail}</p>
              <a class="web-reader__link" href={isWebAddress(current()) ? current() : undefined} target="_blank" rel="noopener noreferrer">
                {t().openOwn}
              </a>
            </div>
          </Match>
          <Match when={page.latest?.status === "unavailable"}>
            <div class="web-reader__notice" role="status">
              <p>{t().unavailable}</p>
              <a class="web-reader__link" href={isWebAddress(current()) ? current() : undefined} target="_blank" rel="noopener noreferrer">
                {t().openOwn}
              </a>
            </div>
          </Match>
          <Match when={ready()}>
            {(result) => (
              <article class="web-reader__page" ref={(element) => element.addEventListener("click", followLink)}>
                <p class="web-reader__stand">
                  <i class="ti ti-book-2" aria-hidden="true" />
                  {t().stand({ stand: standOf(result().contentAt, locale(), t().today) })}
                </p>
                <h1 class="web-reader__title">{result().title}</h1>
                <MarkdownView
                  markdown={result().markdown}
                  allowImages={false}
                  linkProtocols={["https:", "http:"]}
                  class="web-reader__text"
                />
                <Show when={result().truncated}>
                  <p class="web-reader__meta">{t().truncated}</p>
                </Show>
                <p class="web-reader__missing">
                  <i class="ti ti-info-circle" aria-hidden="true" />
                  {t().missing}
                </p>
              </article>
            )}
          </Match>
        </Switch>
      </div>
    </div>
  );
}
