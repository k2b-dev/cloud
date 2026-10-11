import { createContext, createRoot, createSignal, createUniqueId, For, type JSX, onCleanup, onMount, Show, useContext } from "solid-js";
import { Dynamic, insert, isServer } from "solid-js/web";
import { IconButtonLink } from "../actions/Button";
import { installPageTitleController, PAGE_TITLE_CONTROLLER_ATTRIBUTE } from "./page-title-controller";
import { useWorkspaceMessages } from "./workspace-messages";

/** A page above the current one. Only pages someone can go back to are levels, so each has a link. */
export type PageTrailLink = { title: string; href: string };
/** The current page and the pages above it, nearest last. */
export type PageTrailState = { title: string; ancestors: PageTrailLink[] };

export type PageTitleProps = {
  trail: PageTrailState;
  /** Quiet text after the title, for example a count. */
  subtitle?: JSX.Element;
  /** Defaults to `"h1"`. Chrome that repeats a title the page already shows uses `"p"`. */
  as?: "h1" | "h2" | "p";
  /**
   * Marks a title drawn by surrounding chrome, such as the workspace head or a
   * host shell. It steps back when the page renders its own `PageTitle`, so a
   * page has one title with one way up.
   */
  fallback?: boolean;
  class?: string;
};

/** Window event a host dispatches after publishing a new page trail. */
export const PAGE_TRAIL_EVENT = "k2b:page-trail";
const SOURCE_SELECTOR = "script[data-k2b-page-trail]";

const isTrail = (value: unknown): value is PageTrailState => {
  if (!value || typeof value !== "object") return false;
  const trail = value as Partial<PageTrailState>;
  return (
    typeof trail.title === "string" &&
    Array.isArray(trail.ancestors) &&
    trail.ancestors.every((link) => typeof link?.title === "string" && typeof link?.href === "string")
  );
};

/** The trail a host published for this document, or `undefined` outside a browser or without one. */
export const readPageTrail = (): PageTrailState | undefined => {
  if (typeof document === "undefined") return undefined;
  const source = document.querySelector(SOURCE_SELECTOR);
  if (!source?.textContent) return undefined;
  try {
    const value: unknown = JSON.parse(source.textContent);
    return isTrail(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

/** `<` is escaped so a title can never end the script element it travels in. */
const serializeTrail = (trail: PageTrailState): string => JSON.stringify(trail).replace(/</g, "\\u003c");

/**
 * Publishes a new trail for the document in the browser, for example after an
 * in-page navigation. Workspace heads and page titles that read the host's
 * trail follow it.
 */
export const setPageTrail = (trail: PageTrailState): void => {
  if (typeof document === "undefined") return;
  let source = document.querySelector(SOURCE_SELECTOR);
  if (!source) {
    source = document.createElement("script");
    source.setAttribute("type", "application/json");
    source.setAttribute("data-k2b-page-trail", "");
    document.body.append(source);
  }
  source.textContent = serializeTrail(trail);
  window.dispatchEvent(new Event(PAGE_TRAIL_EVENT));
};

const PageTrailContext = createContext<() => PageTrailState | undefined>();

/**
 * Gives a host's page trail to everything below it. During server rendering
 * the context carries it; the provider also publishes it into the document,
 * where browser-rendered parts such as islands read it. Below a provider that
 * renders in the browser, its `trail` prop is the source: update the prop.
 */
export function PageTrailProvider(props: { trail: PageTrailState | undefined; children: JSX.Element }): JSX.Element {
  return (
    <PageTrailContext.Provider value={() => props.trail}>
      <Show when={props.trail}>
        {(trail) => <script type="application/json" data-k2b-page-trail="" innerHTML={serializeTrail(trail())} />}
      </Show>
      {props.children}
    </PageTrailContext.Provider>
  );
}

/** The host's page trail: from the provider while rendering below it, otherwise from the document. */
export const usePageTrail = (): (() => PageTrailState | undefined) => {
  const context = useContext(PageTrailContext);
  if (context) return context;
  if (typeof window === "undefined") return () => undefined;
  const [trail, setTrail] = createSignal(readPageTrail());
  const update = () => setTrail(readPageTrail());
  window.addEventListener(PAGE_TRAIL_EVENT, update);
  onCleanup(() => window.removeEventListener(PAGE_TRAIL_EVENT, update));
  return trail;
};

/**
 * A page title with its way up. The number of pages above decides the form:
 * none shows the title alone; one puts "‹ Parent" above it; more put a path
 * row above it whose middle collapses into "…" only when it does not fit.
 * Both rows share the same height, so the title never moves between depths.
 * On phones a back arrow left of the title replaces the row above.
 */
export function PageTitle(props: PageTitleProps): JSX.Element {
  const messages = useWorkspaceMessages();
  // A title rendered on the server from the host's trail follows the host's later trails (see `followPageTrail`).
  const host = isServer ? useContext(PageTrailContext) : undefined;
  const menuId = `k2b-page-title-menu-${createUniqueId()}`;
  const ancestors = () => props.trail.ancestors;
  const parent = () => ancestors().at(-1);
  let root: HTMLDivElement | undefined;
  // A host may control every title in the document at once; a title outside
  // one still collapses its path.
  onMount(() => {
    if (!root || root.closest(`[${PAGE_TITLE_CONTROLLER_ATTRIBUTE}]`)) return;
    onCleanup(installPageTitleController(root));
  });
  return (
    <div
      ref={root}
      class={`k2b-page-title ${props.class ?? ""}`}
      data-depth={ancestors().length}
      data-fallback={props.fallback ? "" : undefined}
      data-k2b-server={isServer && props.trail === host?.() ? "" : undefined}
    >
      <Show when={parent()}>
        {(up) => (
          <IconButtonLink
            class="k2b-page-title__back"
            href={up().href}
            label={messages().backTo({ page: up().title })}
            data-k2b-page-trail-link=""
            data-k2b-page-trail-up=""
          >
            <i class="ti ti-chevron-left" aria-hidden="true" />
          </IconButtonLink>
        )}
      </Show>
      <div class="k2b-page-title__copy">
        <Show when={ancestors().length === 1 && parent()}>
          {(up) => (
            <nav class="k2b-page-title__trail" aria-label={messages().path}>
              <a
                class="k2b-page-title__up"
                href={up().href}
                aria-label={messages().backTo({ page: up().title })}
                data-k2b-page-trail-link=""
                data-k2b-page-trail-up=""
              >
                <i class="ti ti-chevron-left" aria-hidden="true" />
                <span class="k2b-page-title__label">{up().title}</span>
              </a>
            </nav>
          )}
        </Show>
        <Show when={ancestors().length > 1}>
          <nav class="k2b-page-title__trail" aria-label={messages().path}>
            <ol class="k2b-page-title__path">
              <For each={ancestors()}>
                {(link, index) => (
                  <>
                    <Show when={index() === 1}>
                      <li class="k2b-page-title__more" hidden>
                        <i class="ti ti-chevron-right" aria-hidden="true" />
                        <button type="button" class="k2b-page-title__more-button" popovertarget={menuId} aria-label={messages().moreLevels}>
                          …
                        </button>
                      </li>
                    </Show>
                    <li class="k2b-page-title__crumb" data-index={index()}>
                      <Show when={index() > 0}>
                        <i class="ti ti-chevron-right" aria-hidden="true" />
                      </Show>
                      <a
                        href={link.href}
                        data-k2b-page-trail-link=""
                        data-k2b-page-trail-up={index() === ancestors().length - 1 ? "" : undefined}
                        class="k2b-page-title__label"
                      >
                        {link.title}
                      </a>
                    </li>
                  </>
                )}
              </For>
            </ol>
            <div id={menuId} popover="auto" class="k2b-dropdown__menu k2b-page-title__menu">
              <For each={ancestors()}>
                {(link, index) => (
                  <a class="k2b-dropdown__item" href={link.href} data-index={index()} data-k2b-page-trail-link="" hidden>
                    {link.title}
                  </a>
                )}
              </For>
            </div>
          </nav>
        </Show>
        <Dynamic component={props.as ?? "h1"} class="k2b-page-title__title">
          <span class="k2b-page-title__text">{props.trail.title}</span>
          <Show when={props.subtitle}>
            <small class="k2b-page-title__subtitle">{props.subtitle}</small>
          </Show>
        </Dynamic>
      </div>
    </div>
  );
}

/**
 * Keeps server-rendered titles of the host's trail current: a workspace head
 * that never hydrates, and an app's own header title from the host's trail.
 * When the host publishes a new trail, for example after `setPageTrail()`,
 * each such title is replaced in place by a live one with the same element,
 * class, and subtitle, and a head learns whether it now has a page above it.
 * Titles inside islands render in the browser anyway. Returns the disposer.
 */
export const followPageTrail = (root: ParentNode = document): (() => void) => {
  const disposers: Array<() => void> = [];
  const upgrade = () => {
    const trail = readPageTrail();
    for (const element of root.querySelectorAll<HTMLElement>(".k2b-page-title[data-k2b-server]")) {
      const row = element.parentElement;
      if (!row || element.closest("solid-island, solid-client")) continue;
      const tag = element.querySelector(".k2b-page-title__title")?.localName;
      const as = tag === "p" || tag === "h2" ? tag : "h1";
      const fallback = element.hasAttribute("data-fallback");
      const extra = [...element.classList].filter((name) => name !== "k2b-page-title").join(" ") || undefined;
      const subtitle = element.querySelector(".k2b-page-title__subtitle");
      const subtitleNodes = subtitle ? [...subtitle.childNodes] : undefined;
      // The live title takes the server title's place, before whatever follows it in the row.
      const place = document.createTextNode("");
      row.insertBefore(place, element);
      element.remove();
      disposers.push(
        createRoot((dispose) => {
          const live = usePageTrail();
          insert(
            row,
            () => (
              <Show when={live()}>
                {(current) => <PageTitle trail={current()} as={as} fallback={fallback} class={extra} subtitle={subtitleNodes} />}
              </Show>
            ),
            place,
          );
          return dispose;
        }),
      );
    }
    // The row's `data-trail` decides whether it shows; it follows the depth.
    for (const row of root.querySelectorAll<HTMLElement>("[data-trail]:has(> .k2b-page-title[data-fallback])"))
      if (!row.closest("solid-island, solid-client")) row.dataset.trail = trail?.ancestors.length ? "up" : "title";
  };
  window.addEventListener(PAGE_TRAIL_EVENT, upgrade);
  return () => {
    window.removeEventListener(PAGE_TRAIL_EVENT, upgrade);
    for (const dispose of disposers.splice(0)) dispose();
  };
};
