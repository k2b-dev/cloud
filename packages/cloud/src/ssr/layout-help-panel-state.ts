import { batch, createSignal } from "solid-js";
import type { HelpDocumentManifest, HelpDocumentPayload } from "../shared/help";
import { focusHelpArticleHeading } from "./layout-help-navigation";

export type HelpPanelData = {
  documents: HelpDocumentManifest[];
  appId?: string;
  pageBase?: string;
  article?: Omit<HelpDocumentPayload, "html">;
};
const states = new WeakMap<Element, ReturnType<typeof createPanelState>>();
export const panelRoot = (element: Element): HTMLElement => {
  const root = element.closest<HTMLElement>('.help-shell[data-surface="panel"]');
  if (!root) throw new Error("Missing Help panel");
  return root;
};
const createPanelState = (root: HTMLElement) => {
  // This is our own server's inert JSON, shared once instead of repeating it in island props.
  const data: HelpPanelData = JSON.parse(root.querySelector("[data-help-panel-data]")?.textContent ?? "{}");
  const [view, setView] = createSignal<"hub" | "article">(root.dataset.helpInitialTopic ? "article" : "hub");
  const [activeId, setActiveId] = createSignal<string | null>(data.article?.id ?? root.dataset.helpInitialTopic ?? null);
  const [query, setQuery] = createSignal("");
  const [searchReturnId, setSearchReturnId] = createSignal<string | null>(null);
  const [navigation, setNavigation] = createSignal({ hash: "", version: 0 });
  const [announcement, setAnnouncement] = createSignal("");
  const cache = new Map<string, HelpDocumentPayload>();
  const [cacheVersion, setCacheVersion] = createSignal(0);
  const cacheKey = (topic: HelpDocumentManifest) => `${topic.locale ?? "en"}:${topic.url}`;
  if (data.article) {
    const topic = data.documents.find((topic) => topic.id === data.article?.id);
    if (topic) cache.set(cacheKey(topic), { ...data.article, html: "" });
  }
  const cachedDocument = (topic: HelpDocumentManifest) => {
    cacheVersion();
    return cache.get(cacheKey(topic));
  };
  const storeDocument = (topic: HelpDocumentManifest, payload: HelpDocumentPayload) => {
    cache.set(cacheKey(topic), payload);
    setCacheVersion((value) => value + 1);
  };
  const results = () => root.querySelector<HTMLElement>("[data-help-results]");
  const scroller = () => root.querySelector<HTMLElement>("[data-scroll-fade-mode]");
  const sync = () => {
    const hub = view() === "hub";
    const start = results();
    if (start) start.hidden = !hub;
    const server = root.querySelector<HTMLElement>("[data-help-server-article]");
    if (server) server.hidden = hub || activeId() !== data.article?.id;
  };
  const back = () => {
    setSearchReturnId(null);
    setView("hub");
    sync();
  };
  /** Where the article stood when a search started from it; clearing the search returns there. */
  let articleScrollTop = 0;
  const changeQuery = (value: string) => {
    const searching = !!value.trim();
    let returned = false;
    batch(() => {
      if (searching && view() === "article") {
        articleScrollTop = scroller()?.scrollTop ?? 0;
        setSearchReturnId(activeId());
        const region = results();
        if (region) region.style.minHeight = "";
        setView("hub");
      }
      setQuery(value);
      if (!searching) {
        const region = results();
        if (region) region.style.minHeight = "";
        const id = searchReturnId();
        setSearchReturnId(null);
        if (id && data.documents.some((topic) => topic.id === id)) {
          setActiveId(id);
          setView("article");
          returned = true;
        }
      }
    });
    sync();
    // The article stayed in the document while results showed; give it back its place once it has its height again.
    if (returned) {
      const top = articleScrollTop;
      requestAnimationFrame(() => {
        const scroll = scroller();
        if (scroll) scroll.scrollTop = top;
      });
    }
  };
  const open = (id: string, hash = "") => {
    if (!data.documents.some((topic) => topic.id === id)) return;
    try {
      localStorage.setItem("cloud.layoutHelp.activeTopic", id);
    } catch {
      /* Storage is optional. */
    }
    batch(() => {
      setSearchReturnId(null);
      setActiveId(id);
      setView("article");
      setNavigation((value) => ({ hash, version: value.version + 1 }));
    });
    const scroll = scroller();
    if (scroll) scroll.scrollTop = 0;
    sync();
  };
  const focusHeading = () =>
    focusHelpArticleHeading(root.querySelector<HTMLHeadingElement>("article:not([hidden]) .help-article-title") ?? undefined);
  return {
    root,
    data,
    view,
    activeId,
    query,
    changeQuery,
    back,
    open,
    navigation,
    cache,
    cacheKey,
    cachedDocument,
    storeDocument,
    sync,
    results,
    scroller,
    focusHeading,
    announcement,
    setAnnouncement,
  };
};
export type HelpPanelState = ReturnType<typeof createPanelState>;
export function helpPanelState(element: Element): HelpPanelState {
  const root = panelRoot(element);
  let state = states.get(root);
  if (!state) {
    state = createPanelState(root);
    states.set(root, state);
  }
  return state;
}
