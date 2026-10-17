import type { HelpAccessLevel, HelpArticleLink, HelpDocumentManifest, HelpDocumentPayload } from "@k2b/cloud/shared";
import { clipboard } from "@k2b/stdlib/solid";
import {
  Button,
  Dropdown,
  IconButton,
  IconButtonLink,
  Kbd,
  MarkdownView,
  NoticeCard,
  Placeholder,
  prefersReducedMotion,
  prompts,
  ScrollArea,
  TableOfContents,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { COMMANDS_CHANGED, contextCommandsWithShortcuts } from "../browser/command-shortcuts";
import { HELP_ACCESS_LEVELS, HELP_KINDS } from "../shared/help";
import { appAccentStyle } from "./app-appearance";
import { helpMessages } from "./help-messages";
import { helpArticleParts } from "./layout-help-article";
import { formatHelpBundleMarkdown, formatHelpDocumentMarkdown } from "./layout-help-markdown";
import { focusHelpArticleHeading, resetHelpArticleScroll } from "./layout-help-navigation";
import { HELP_TOPICS_EVENT, type HelpTopic, registry } from "./layout-help-registry";
import { searchHelpTopics } from "./layout-help-search";
import { helpLinkTarget, layoutHelpTopicHref } from "./layout-help-url";
import { readShellData, useShellData } from "./shell-data";

export type LayoutHelpPageProps = {
  documents: readonly HelpDocumentManifest[];
  initialTopic?: string;
  includeShortcuts?: boolean;
  accent?: string;
  /** Render inside an app-owned pane instead of occupying a full page. */
  embedded?: boolean;
  /** Canonical full-page Help route owned by the current app. */
  pageBase?: string;
};

type HelpView = "hub" | "article";
type HelpSession = {
  view: HelpView;
  query: string;
  activeId: string | null;
  articleScrollTop: number;
  articleCache: Map<string, HelpDocumentPayload>;
};
type HelpSection = { id: string; label: string };

const LAST_TOPIC_KEY = "cloud.layoutHelp.activeTopic";

const optionalString = (value: object, key: string): string | undefined => {
  const field = Reflect.get(value, key);
  return typeof field === "string" ? field : undefined;
};
/** A linked article from the Help API, or nothing when the server sent something else. */
const articleLink = (value: unknown): HelpArticleLink | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const [appId, appName, documentId, title, url] = ["appId", "appName", "documentId", "title", "url"].map((key) =>
    optionalString(value, key),
  );
  if (!appId || !appName || !documentId || !title || !url?.startsWith("/")) return undefined;
  const [accent, description, icon] = ["accent", "description", "icon"].map((key) => optionalString(value, key));
  return { appId, appName, accent, documentId, title, description, icon, url };
};

/** An article without its own icon gets a neutral page tile. */
const iconClass = (icon?: string) => (icon?.startsWith("ti ") ? icon : `ti ${icon ?? "ti-file-text"}`);
const legacyTopicContent = (topic: HelpTopic) => (topic.kind === "content" ? topic.children : null);
const sortedTopics = () =>
  [...(registry()?.values() ?? [])].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title));
const documentTopics = (documents: readonly HelpDocumentManifest[] = []): HelpTopic[] =>
  documents.map((document) => ({ ...document, kind: "document" }));
const mergeTopics = (registered: readonly HelpTopic[], documents: readonly HelpDocumentManifest[] = []): HelpTopic[] => {
  const topics = new Map(registered.map((topic) => [topic.id, topic]));
  for (const topic of documentTopics(documents)) topics.set(topic.id, topic);
  return [...topics.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title));
};

const Shortcuts = (props: { focusSearch: () => void }) => {
  const locale = useLocale();
  const t = () => helpMessages.resolve([locale()]).t;
  const [commands, setCommands] = createSignal(contextCommandsWithShortcuts());
  onMount(() => {
    const update = () => setCommands(contextCommandsWithShortcuts());
    window.addEventListener(COMMANDS_CHANGED, update);
    onCleanup(() => window.removeEventListener(COMMANDS_CHANGED, update));
  });
  const entries = createMemo(() => commands().filter((command) => command.shortcut));
  return (
    <div class="flex flex-col gap-3">
      <p class="text-sm leading-relaxed text-dimmed">{t().shortcutsIntro}</p>
      <Button size="sm" variant="secondary" class="self-start" onClick={props.focusSearch}>
        <i class="ti ti-search" /> {t().searchHelp}
      </Button>
      <div class="flex flex-col gap-2">
        <For each={entries()}>
          {(entry) => (
            <div class="flex items-start justify-between gap-4 rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)] px-3 py-2.5">
              <div class="min-w-0">
                <p class="text-sm font-medium text-primary">{entry.title}</p>
                <Show when={entry.description}>
                  <p class="mt-0.5 text-xs text-dimmed">{entry.description}</p>
                </Show>
              </div>
              <Kbd keys={entry.shortcut!} />
            </div>
          )}
        </For>
      </div>
    </div>
  );
};

const HelpShell = (props: {
  session: HelpSession;
  close: () => void;
  pageBase?: string;
  documents?: readonly HelpDocumentManifest[];
  includeShortcuts?: boolean;
  accent?: string;
  surface?: "modal" | "page" | "embedded";
  syncPageUrl?: boolean;
}) => {
  const locale = useLocale();
  const t = () => helpMessages.resolve([locale()]).t;
  // Links to this app's Help, by its own route or Core's `/help/apps/<id>`, open in place.
  const shell = useShellData();
  const appId = shell?.appId;
  const appName = shell?.apps.find((app) => app.id === appId)?.label;
  const accessLabel = (level: HelpAccessLevel) => ({ view: t().accessView, edit: t().accessEdit, manage: t().accessManage })[level];
  const [externalTopics, setExternalTopics] = createSignal(mergeTopics(sortedTopics(), props.documents));
  const [view, setView] = createSignal<HelpView>(props.session.view);
  const [query, setQuery] = createSignal(props.session.query);
  const [activeId, setActiveId] = createSignal<string | null>(props.session.activeId);
  const [payload, setPayload] = createSignal<HelpDocumentPayload | null>(null);
  const [loading, setLoading] = createSignal(props.session.view === "article");
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [loadAttempt, setLoadAttempt] = createSignal(0);
  const [remoteIds, setRemoteIds] = createSignal<readonly string[] | null>(null);
  const [searching, setSearching] = createSignal(false);
  const [copyingAll, setCopyingAll] = createSignal(false);
  const [copyAllError, setCopyAllError] = createSignal<string | null>(null);
  const [activeSectionId, setActiveSectionId] = createSignal<string | null>(null);
  const [tocScrollRoot, setTocScrollRoot] = createSignal<HTMLElement>();
  const articleClipboard = clipboard.create(1800);
  const allHelpClipboard = clipboard.create(1800);
  let root: HTMLDivElement | undefined;
  let scrollArea: HTMLDivElement | undefined;
  let articleContent: HTMLDivElement | undefined;
  let articleHeading: HTMLHeadingElement | undefined;
  let searchInput: HTMLInputElement | undefined;
  let resultsRegion: HTMLDivElement | undefined;
  const [resultsMinHeight, setResultsMinHeight] = createSignal<string>();
  let pendingArticleFocus = false;
  let pendingNavigation = false;
  /** Where the page's own address points in this Help; a query string, such as a campaign tag, does not matter here. */
  const currentHelpTarget = () =>
    helpLinkTarget(`${location.pathname}${location.hash}`, location.href, { appId, pageBase: props.pageBase });
  let pendingHash = props.syncPageUrl && typeof location !== "undefined" ? (currentHelpTarget()?.hash ?? "") : "";
  /**
   * The address Help shows now. The phone menu and dialogs with a history entry put a second entry on the same address
   * and take it away again; that is not Help navigation and must not move the article or the search.
   */
  const pageAddress = () => `${location.pathname}${location.hash}`;
  let shownAddress = props.syncPageUrl && typeof location !== "undefined" ? pageAddress() : "";
  let requestVersion = 0;
  let searchVersion = 0;
  let copyAllController: AbortController | undefined;

  const articleScroller = () => {
    if (props.surface !== "page") return scrollArea;
    for (let element = root?.parentElement; element; element = element.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(element).overflowY)) return element;
    }
    return document.scrollingElement;
  };

  const restoreArticleScroll = () => {
    if (props.surface !== "modal" || pendingNavigation || pendingHash) return;
    requestAnimationFrame(() => {
      if (scrollArea && view() === "article") scrollArea.scrollTop = props.session.articleScrollTop;
    });
  };

  const scrollToHash = (hash: string) => {
    const heading = Array.from(
      articleContent?.querySelectorAll<HTMLHeadingElement>("h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]") ?? [],
    ).find((element) => element.id === hash);
    if (!heading) return false;
    // A link to a heading in collapsed details opens them, and any details around them, first.
    for (let details = heading.closest("details"); details; details = details.parentElement?.closest("details") ?? null)
      details.open = true;
    setActiveSectionId(hash);
    heading.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    return true;
  };

  /** Once the article body is in the document: open the requested section, or start at the top. */
  const syncTocScrollRoot = () => {
    const scroller = articleScroller();
    // The table of contents follows the window unless the reader scrolls in its own container.
    setTocScrollRoot(scroller instanceof HTMLElement && scroller !== document.scrollingElement ? scroller : undefined);
  };

  const settleArticle = () => {
    syncTocScrollRoot();
    const openedSection = pendingHash ? scrollToHash(pendingHash) : false;
    pendingHash = "";
    pendingNavigation = false;
    if (!openedSection) setActiveSectionId(articleSections()[0]?.id ?? null);
  };

  const openArticleSection = (section: HelpSection) => {
    scrollToHash(section.id);
    if (props.syncPageUrl) {
      const url = new URL(location.href);
      url.hash = encodeURIComponent(section.id);
      history.replaceState(history.state, "", url);
      shownAddress = pageAddress();
    }
  };

  const focusSearch = () => {
    showHub();
    requestAnimationFrame(() => searchInput?.focus({ preventScroll: true }));
  };

  const shortcutsTopic = createMemo<HelpTopic>(() => ({
    id: "shortcuts",
    title: t().shortcuts,
    icon: "ti ti-keyboard",
    description: t().shortcutsDescription,
    order: 0,
    kind: "content",
    children: <Shortcuts focusSearch={focusSearch} />,
  }));
  const topics = createMemo(() => (props.includeShortcuts === false ? externalTopics() : [shortcutsTopic(), ...externalTopics()]));
  const documentTopics = createMemo(() =>
    externalTopics().filter((topic): topic is HelpDocumentManifest & { kind: "document" } => topic.kind === "document"),
  );
  const activeTopic = createMemo(() => topics().find((topic) => topic.id === activeId()) ?? null);
  // Article bodies load in the browser only; the server renders the head and the loading state.
  const articleParts = createMemo(() => {
    const html = payload()?.html;
    return html ? helpArticleParts(html) : null;
  });
  const articleSections = (): HelpSection[] => (view() === "article" ? articleParts()?.sections : undefined) ?? [];
  const normalizedQuery = createMemo(() => query().trim().toLocaleLowerCase());
  const results = createMemo(() => {
    const value = normalizedQuery();
    if (!value) return topics();
    return searchHelpTopics(topics(), value, remoteIds());
  });

  createEffect(() => {
    const value = normalizedQuery();
    const urls = [
      ...new Set(
        externalTopics()
          .filter((topic): topic is HelpDocumentManifest & { kind: "document" } => topic.kind === "document")
          .map((topic) => topic.searchUrl),
      ),
    ];
    const version = ++searchVersion;
    setRemoteIds(null);
    setSearching(false);
    if (!value || urls.length === 0) return;

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      void Promise.all(
        urls.map(async (url) => {
          const response = await fetch(`${url}?q=${encodeURIComponent(value)}`, {
            signal: controller.signal,
            headers: { Accept: "application/json" },
          });
          if (!response.ok) throw new Error(t().searchFailed);
          const payload: unknown = await response.json();
          return payload && typeof payload === "object" && "ids" in payload && Array.isArray(payload.ids)
            ? payload.ids.filter((id): id is string => typeof id === "string")
            : [];
        }),
      )
        .then((groups) => {
          if (version === searchVersion) setRemoteIds([...new Set(groups.flat())]);
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          // Metadata matches stay usable if full-text search is temporarily unavailable.
        })
        .finally(() => {
          if (version === searchVersion) setSearching(false);
        });
    }, 120);

    onCleanup(() => {
      window.clearTimeout(timer);
      controller.abort();
      if (version === searchVersion) searchVersion++;
    });
  });

  createEffect(() => {
    const html = payload()?.html;
    if (!html || view() !== "article") {
      setActiveSectionId(null);
      return;
    }
    const frame = requestAnimationFrame(() => {
      if (pendingNavigation && !pendingHash) {
        const scroller = articleScroller();
        if (scroller) scroller.scrollTop = 0;
      }
      settleArticle();
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });

  createEffect(() => {
    activeId();
    if (!pendingArticleFocus || view() !== "article") return;
    const frame = requestAnimationFrame(() => {
      focusHelpArticleHeading(articleHeading);
      pendingArticleFocus = false;
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });

  const syncSession = () => {
    props.session.view = view();
    props.session.query = query();
    props.session.activeId = activeId();
  };
  createEffect(syncSession);

  onMount(() => {
    const dialog = root?.closest("dialog");
    if (dialog) {
      dialog.setAttribute("aria-labelledby", "layout-help-title");
      dialog.setAttribute("aria-describedby", "layout-help-subtitle");
    }
    const update = () => setExternalTopics(mergeTopics(sortedTopics(), props.documents));
    window.addEventListener(HELP_TOPICS_EVENT, update);
    update();
    onCleanup(() => window.removeEventListener(HELP_TOPICS_EVENT, update));
    restoreArticleScroll();
    // The dialog reopens at the article position it had.
    const onScroll = () => {
      if (view() === "article" && scrollArea) props.session.articleScrollTop = scrollArea.scrollTop;
    };
    if (props.surface === "modal") scrollArea?.addEventListener("scroll", onScroll, { passive: true });
    // Layout's breakpoints move page scrolling between its main column and the window; the contents follow.
    let resizeFrame: number | undefined;
    const onResize = () => {
      resizeFrame ??= requestAnimationFrame(() => {
        resizeFrame = undefined;
        if (view() === "article") syncTocScrollRoot();
      });
    };
    if (props.surface === "page") window.addEventListener("resize", onResize);
    const onPopState = () => {
      const address = pageAddress();
      if (address === shownAddress) return;
      const target = currentHelpTarget();
      if (target?.kind !== "topic") return;
      shownAddress = address;
      const id = target.topicId;
      if (id !== null && topics().some((topic) => topic.id === id)) openTopic(id, target.hash, false);
      // The hub keeps its search, as the reader's own Back button does. An unknown topic shows the hub, as the server does.
      else setView("hub");
    };
    if (props.syncPageUrl) window.addEventListener("popstate", onPopState);
    onCleanup(() => {
      scrollArea?.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      window.removeEventListener("popstate", onPopState);
    });
  });
  onCleanup(() => copyAllController?.abort());

  const loadDocument = async (topic: HelpDocumentManifest, signal: AbortSignal) => {
    const cacheKey = `${topic.locale ?? "en"}:${topic.url}`;
    const cached = props.session.articleCache.get(cacheKey);
    if (cached) return cached;

    const response = await fetch(topic.url, { signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(t().requestFailed);
    const value: unknown = await response.json();
    if (
      !value ||
      typeof value !== "object" ||
      !("id" in value) ||
      value.id !== topic.id ||
      !("html" in value) ||
      !("markdown" in value) ||
      !("title" in value) ||
      ("locale" in value && value.locale !== undefined && typeof value.locale !== "string") ||
      (topic.locale !== undefined && "locale" in value && value.locale !== undefined && value.locale !== topic.locale) ||
      typeof value.html !== "string" ||
      typeof value.markdown !== "string" ||
      typeof value.title !== "string"
    ) {
      throw new Error(t().invalidDocument);
    }
    const kind = Reflect.get(value, "kind");
    const needs = Reflect.get(value, "needs");
    const related = Reflect.get(value, "related");
    const next = articleLink(Reflect.get(value, "next"));
    const document: HelpDocumentPayload = {
      id: topic.id,
      title: value.title,
      html: value.html,
      markdown: value.markdown,
      locale: "locale" in value && typeof value.locale === "string" ? value.locale : (topic.locale ?? "en"),
      // A Core older than the app's Help reader sends no article facts; the article then shows none.
      kind: HELP_KINDS.find((candidate) => candidate === kind) ?? "task",
      needs: HELP_ACCESS_LEVELS.find((level) => level === needs),
      ...(next ? { next } : {}),
      related: Array.isArray(related) ? related.flatMap((link) => articleLink(link) ?? []) : [],
    };
    props.session.articleCache.set(cacheKey, document);
    return document;
  };

  createEffect(() => {
    loadAttempt();
    const topic = activeTopic();
    const version = ++requestVersion;
    setPayload(null);
    setLoadError(null);
    setLoading(false);
    if (!topic || topic.kind !== "document" || view() !== "article") return;
    const cached = props.session.articleCache.get(`${topic.locale ?? "en"}:${topic.url}`);
    if (cached) {
      setPayload(cached);
      restoreArticleScroll();
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    void loadDocument(topic, controller.signal)
      .then((document) => {
        if (version === requestVersion) {
          setPayload(document);
          restoreArticleScroll();
        }
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (version === requestVersion) setLoadError(error instanceof Error ? error.message : t().loadFallback);
      })
      .finally(() => {
        if (version === requestVersion) setLoading(false);
      });
    onCleanup(() => {
      controller.abort();
      if (version === requestVersion) requestVersion++;
    });
  });

  const copyArticle = (topic: HelpTopic, document: HelpDocumentPayload | null) => {
    if (topic.kind !== "document" || !document) return;
    return articleClipboard.copy(formatHelpDocumentMarkdown({ ...topic, markdown: document.markdown }));
  };

  const copyAllHelp = async () => {
    const manifests = documentTopics();
    if (manifests.length === 0 || copyingAll()) return;

    copyAllController?.abort();
    const controller = new AbortController();
    copyAllController = controller;
    setCopyingAll(true);
    setCopyAllError(null);
    try {
      const documents = await Promise.all(
        manifests.map(async (topic) => {
          const document = await loadDocument(topic, controller.signal);
          return { ...topic, markdown: document.markdown };
        }),
      );
      await allHelpClipboard.copy(formatHelpBundleMarkdown(documents));
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setCopyAllError(error instanceof Error ? error.message : t().copyFallback);
      }
    } finally {
      if (copyAllController === controller) {
        copyAllController = undefined;
        setCopyingAll(false);
      }
    }
  };

  const pushHelpUrl = (id: string | null, hash = "") => {
    if (props.syncPageUrl && props.pageBase) {
      history.pushState(history.state, "", layoutHelpTopicHref(props.pageBase, id) + (hash ? `#${encodeURIComponent(hash)}` : ""));
      shownAddress = pageAddress();
    }
  };
  const openTopic = (id: string, hash = "", push = true) => {
    if (push) pushHelpUrl(id, hash);
    try {
      localStorage.setItem(LAST_TOPIC_KEY, id);
    } catch {
      /* Help does not depend on storage. */
    }
    // The open article does not load again: go to its section, or to its top.
    if (view() === "article" && activeId() === id && payload()) {
      if (!hash || !scrollToHash(hash)) resetHelpArticleScroll(props.session, articleScroller() ?? undefined);
      return;
    }
    resetHelpArticleScroll(props.session, articleScroller() ?? undefined);
    pendingArticleFocus = true;
    pendingNavigation = true;
    pendingHash = hash;
    setActiveId(id);
    setView("article");
  };
  const showHub = (push = true) => {
    setQuery("");
    setResultsMinHeight(undefined);
    setRemoteIds(null);
    setView("hub");
    if (push) pushHelpUrl(null);
  };
  const goBack = () => {
    setView("hub");
    pushHelpUrl(null);
  };

  /** Links in the article, its table of contents, and its end open Help targets of this app in place. */
  const followHelpLink = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!(event.target instanceof Element) || !(event.currentTarget instanceof Element)) return;
    const anchor = event.target.closest("a");
    if (!anchor || !event.currentTarget.contains(anchor) || (anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download"))
      return;
    const target = helpLinkTarget(anchor.getAttribute("href") ?? "", location.href, { appId, pageBase: props.pageBase });
    if (!target) return;
    if (target.kind === "section") {
      if (!scrollToHash(target.hash)) return;
      event.preventDefault();
      if (props.syncPageUrl) {
        const url = new URL(location.href);
        url.hash = encodeURIComponent(target.hash);
        history.replaceState(history.state, "", url);
        shownAddress = pageAddress();
      }
    } else if (target.topicId === null) {
      event.preventDefault();
      showHub();
    } else if (topics().some((topic) => topic.id === target.topicId)) {
      event.preventDefault();
      openTopic(target.topicId, target.hash);
    }
  };

  const TopicList = (listProps: { items: HelpTopic[] }) => (
    <div class="flex flex-col gap-1 rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)] p-1.5">
      <For each={listProps.items}>
        {(topic) => (
          <button
            type="button"
            class="group flex w-full items-center gap-3 rounded-[var(--ui-radius-control)] px-3 py-2.5 text-left hover:bg-[var(--ui-surface-raised)] focus-ui"
            onClick={() => openTopic(topic.id)}
          >
            <span class="help-topic-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] app-accent-text">
              <i class={`${iconClass(topic.icon)} text-base`} />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium text-primary group-hover:app-accent-text">{topic.title}</span>
              <Show when={topic.description}>
                {(description) => <span class="mt-0.5 block truncate text-xs text-dimmed">{description()}</span>}
              </Show>
            </span>
            <i class="ti ti-chevron-right shrink-0 text-xs text-dimmed" />
          </button>
        )}
      </For>
    </div>
  );

  const ArticleLinkTitle = (link: { link: HelpArticleLink }) => (
    <span class="help-article-link-copy">
      <span class="help-article-link-title">{link.link.title}</span>
      <Show when={link.link.description}>{(description) => <span class="help-article-link-description">{description()}</span>}</Show>
    </span>
  );

  /** "Next" leads on; related articles keep their own app's colour, and another app says whose article it is. */
  const ArticleEnd = (end: { document: HelpDocumentPayload }) => (
    <Show when={end.document.next || end.document.related.length > 0}>
      <footer class="help-article-end">
        <Show when={end.document.next}>
          {(next) => (
            <a class="help-article-next app-accent-scope focus-ui" href={next().url} style={appAccentStyle(next().accent)}>
              <span class="help-article-next-label">{t().next}</span>
              <span class="help-article-next-row">
                <i class={`${iconClass(next().icon)} help-article-next-icon`} aria-hidden="true" />
                <ArticleLinkTitle link={next()} />
                <i class="ti ti-arrow-right help-article-next-arrow" aria-hidden="true" />
              </span>
            </a>
          )}
        </Show>
        <Show when={end.document.related.length > 0}>
          <section class="help-article-related" aria-labelledby="help-article-related-title">
            <h4 id="help-article-related-title">{t().related}</h4>
            <ul>
              <For each={end.document.related}>
                {(link) => (
                  <li>
                    <a class="help-article-related-link app-accent-scope focus-ui" href={link.url} style={appAccentStyle(link.accent)}>
                      <span class="help-topic-icon help-article-related-icon app-accent-text" aria-hidden="true">
                        <i class={iconClass(link.icon)} />
                      </span>
                      <ArticleLinkTitle link={link} />
                      <Show when={link.appId !== appId}>
                        <span class="help-article-related-app app-accent-text">{link.appName}</span>
                      </Show>
                    </a>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
      </footer>
    </Show>
  );

  const ReaderContent = (content: { children: JSX.Element }) =>
    props.surface === "page" ? (
      <div class="p-4 sm:p-5">{content.children}</div>
    ) : (
      <ScrollArea ref={scrollArea} class="min-h-0 flex-1 p-4 sm:p-5">
        {content.children}
      </ScrollArea>
    );

  return (
    <div
      ref={root}
      class={`app-accent-scope flex min-h-0 flex-col ${props.surface === "page" ? "" : "bg-[var(--ui-surface-raised)]"} ${
        props.surface === "modal"
          ? "h-[min(48rem,var(--ui-dialog-available-height))] overflow-hidden panel-dialog-shell [box-shadow:var(--ui-shadow-float)]"
          : props.surface === "page"
            ? ""
            : "h-full"
      }`}
      style={appAccentStyle(props.accent)}
    >
      <Show when={props.surface === "modal"}>
        <header class="flex min-h-16 shrink-0 items-center gap-2 px-5 py-3">
          <Show when={view() !== "hub"}>
            <IconButton class="shrink-0" label={t().backToTopics} title={t().back} onClick={goBack}>
              <i class="ti ti-arrow-left" />
            </IconButton>
          </Show>
          {/* The article names itself in its own head, so the dialog keeps one name and never repeats the title. */}
          <span class="help-topic-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] app-accent-text">
            <i class="ti ti-help text-lg" />
          </span>
          <div class="min-w-0 flex-1">
            <h2 id="layout-help-title" class="truncate font-semibold text-primary">
              {t().help}
            </h2>
            <p id="layout-help-subtitle" class="truncate text-xs text-dimmed">
              {t().description}
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-1" role="group" aria-label={t().actions}>
            <Show when={view() === "hub" && documentTopics().length > 0}>
              <IconButton
                disabled={copyingAll()}
                label={allHelpClipboard.wasCopied() ? t().helpCopied : t().copyAllHelp}
                title={allHelpClipboard.wasCopied() ? t().copied : t().copyAllHelp}
                onClick={() => void copyAllHelp()}
              >
                <i class={copyingAll() ? "ti ti-loader-2 animate-spin" : allHelpClipboard.wasCopied() ? "ti ti-check" : "ti ti-markdown"} />
              </IconButton>
            </Show>
            <Show when={view() === "article" && activeTopic()?.kind === "document"}>
              <IconButton
                disabled={!payload()}
                label={articleClipboard.wasCopied() ? t().articleCopied : t().copyArticle}
                title={articleClipboard.wasCopied() ? t().copied : t().copyArticle}
                onClick={() => {
                  const topic = activeTopic();
                  if (topic) void copyArticle(topic, payload());
                }}
              >
                <i class={articleClipboard.wasCopied() ? "ti ti-check" : "ti ti-markdown"} />
              </IconButton>
            </Show>
            <Show when={props.pageBase}>
              {(pageBase) => (
                <IconButtonLink
                  href={layoutHelpTopicHref(pageBase(), view() === "article" ? activeId() : null)}
                  target="_blank"
                  rel="noopener noreferrer"
                  label={t().openWindow}
                  title={t().openFullPage}
                  onClick={(event) => {
                    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

                    const popup = window.open(
                      event.currentTarget.href,
                      "cloud-layout-help",
                      "popup,width=1120,height=820,resizable=yes,scrollbars=yes",
                    );
                    if (!popup) return;

                    event.preventDefault();
                    popup.opener = null;
                    popup.focus();
                  }}
                >
                  <i class="ti ti-app-window" />
                </IconButtonLink>
              )}
            </Show>
            <IconButton label={t().closeHelp} title={t().close} onClick={props.close}>
              <i class="ti ti-x" />
            </IconButton>
          </div>
        </header>
      </Show>

      <ReaderContent>
        <Show when={view() === "hub"}>
          <div class="mx-auto flex max-w-3xl flex-col gap-6">
            <div class="flex flex-col items-start justify-between gap-3 sm:flex-row">
              <div>
                <h3 class="text-xl font-semibold text-primary">{t().heading}</h3>
                <p class="mt-1 text-sm text-dimmed">{t().headingDescription}</p>
              </div>
              <Show when={props.surface !== "modal" && documentTopics().length > 0}>
                <Button size="sm" variant="secondary" class="shrink-0" disabled={copyingAll()} onClick={() => void copyAllHelp()}>
                  <i class={copyingAll() ? "ti ti-loader-2 animate-spin" : allHelpClipboard.wasCopied() ? "ti ti-check" : "ti ti-copy"} />
                  {copyingAll() ? t().preparing : allHelpClipboard.wasCopied() ? t().copied : t().copyAllShort}
                </Button>
              </Show>
            </div>
            <Show when={copyAllError()}>
              {(message) => (
                <p class="text-xs text-danger" role="alert">
                  {t().copyAllFailed({ message: message() })}
                </p>
              )}
            </Show>
            <TextInput
              ref={searchInput}
              type="search"
              icon="ti ti-search"
              aria-label={t().searchHelp}
              data-help-search=""
              value={query()}
              placeholder={t().searchPlaceholder}
              onValueChange={(value) => {
                // Results replace the start lists below the field; the area keeps its height so nothing moves.
                if (!query().trim() && value.trim()) setResultsMinHeight(`${resultsRegion?.offsetHeight ?? 0}px`);
                if (!value.trim()) setResultsMinHeight(undefined);
                setQuery(value);
              }}
            />
            <div ref={resultsRegion} data-help-results="" class="flex flex-col gap-4" style={{ "min-height": resultsMinHeight() }}>
              <Show
                when={normalizedQuery()}
                fallback={
                  <>
                    <section aria-labelledby="help-start-title">
                      <h4 id="help-start-title" class="mb-2 text-xs font-semibold uppercase tracking-wide text-dimmed">
                        {t().startHere}
                      </h4>
                      <TopicList items={topics().slice(0, 5)} />
                    </section>
                    <Show when={topics().length > 5}>
                      <section aria-labelledby="help-all-title">
                        <h4 id="help-all-title" class="mb-2 text-xs font-semibold uppercase tracking-wide text-dimmed">
                          {t().allTopics}
                        </h4>
                        <TopicList items={topics().slice(5)} />
                      </section>
                    </Show>
                  </>
                }
              >
                {/* The count takes the place of the "Start here" title, so the first row stays where it was. */}
                <section>
                  <p class="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-dimmed" aria-live="polite">
                    {t().results({ count: results().length })}
                    <Show when={searching()}>
                      <i class="ti ti-loader-2 animate-spin" aria-hidden="true" />
                    </Show>
                  </p>
                  <Show
                    when={results().length > 0}
                    fallback={
                      <Show when={!searching()}>
                        <Placeholder icon="ti ti-search-off" title={t().noResults} />
                      </Show>
                    }
                  >
                    <TopicList items={results()} />
                  </Show>
                </section>
              </Show>
            </div>
          </div>
        </Show>

        <Show when={view() === "article" && activeTopic()}>
          {(topic) => (
            <article
              class="help-article"
              data-surface={props.surface}
              ref={(element) => {
                // Delegated from the article: its body, table of contents, and end hold the links.
                element.addEventListener("click", followHelpLink);
                onCleanup(() => element.removeEventListener("click", followHelpLink));
              }}
            >
              <div class="help-article-layout">
                <div class="help-article-main">
                  <header class="help-article-head">
                    <p class="help-article-path">
                      <Show when={appName}>
                        {(name) => (
                          <>
                            <span class="app-accent-text">{name()}</span>
                            <i class="ti ti-chevron-right" aria-hidden="true" />
                          </>
                        )}
                      </Show>
                      <button type="button" class="help-article-path-link focus-ui" onClick={goBack}>
                        {t().help}
                      </button>
                    </p>
                    <h3 ref={articleHeading} tabindex="-1" class="help-article-title focus-ui">
                      {topic().title}
                    </h3>
                    <Show
                      when={articleParts()?.lead}
                      fallback={
                        // An article without a leading paragraph, or a built-in topic, shows its description; a loading article shows neither yet.
                        <Show when={(topic().kind === "content" || articleParts()) && topic().description}>
                          {(description) => <p class="help-article-lead">{description()}</p>}
                        </Show>
                      }
                    >
                      {(lead) => <MarkdownView trustedHtml={lead()} class="help-document help-article-lead" />}
                    </Show>
                    <Show when={payload()?.needs || articleParts()?.steps}>
                      {/* One row of facts; the access level appears here and nowhere else in the reader's chrome. */}
                      <ul class="help-article-facts" aria-label={t().articleFacts}>
                        <Show when={payload()?.needs}>
                          {(level) => (
                            <li class="help-article-fact" data-fact="needs">
                              <i class="ti ti-key" aria-hidden="true" />
                              <span>
                                {t().youNeed} <strong>{accessLabel(level())}</strong>
                              </span>
                            </li>
                          )}
                        </Show>
                        <Show when={articleParts()?.steps}>
                          {(count) => (
                            <li class="help-article-fact" data-fact="steps">
                              <i class="ti ti-list-numbers" aria-hidden="true" />
                              <span>{t().steps({ count: count() })}</span>
                            </li>
                          )}
                        </Show>
                      </ul>
                    </Show>
                    <Show when={articleSections().length > 0 || (props.surface !== "modal" && topic().kind === "document")}>
                      <div class="help-article-tools">
                        <Show when={articleSections().length > 0}>
                          <Dropdown.Root
                            label={t().onThisPage}
                            position="bottom-left"
                            items={articleSections().map((section) => ({
                              label: section.label,
                              choice: "radio" as const,
                              checked: () => activeSectionId() === section.id,
                              action: () => openArticleSection(section),
                            }))}
                          >
                            <Dropdown.Trigger label={t().onThisPage} size="sm" tooltip={false} variant="secondary">
                              <i class="ti ti-list" aria-hidden="true" />
                              <span>{t().onThisPage}</span>
                              <i class="ti ti-chevron-down" aria-hidden="true" />
                            </Dropdown.Trigger>
                          </Dropdown.Root>
                        </Show>
                        <Show when={props.surface !== "modal" && topic().kind === "document"}>
                          <IconButton
                            class="help-article-tools-copy"
                            disabled={!payload()}
                            label={articleClipboard.wasCopied() ? t().articleCopied : t().copyArticle}
                            title={articleClipboard.wasCopied() ? t().copied : t().copyArticle}
                            onClick={() => void copyArticle(topic(), payload())}
                          >
                            <i class={articleClipboard.wasCopied() ? "ti ti-check" : "ti ti-markdown"} />
                          </IconButton>
                        </Show>
                      </div>
                    </Show>
                  </header>
                  <Show when={topic().kind === "content"}>{legacyTopicContent(topic())}</Show>
                  <Show when={topic().kind === "document"}>
                    <Show when={loading()}>
                      <div class="min-h-[24rem]">
                        <Placeholder state="loading" variant="panel" title={t().loading} />
                      </div>
                    </Show>
                    <Show when={loadError()}>
                      {(message) => (
                        <NoticeCard tone="danger" title={t().loadFailed} detail={message()}>
                          <Button size="sm" variant="secondary" onClick={() => setLoadAttempt((value) => value + 1)}>
                            {t().tryAgain}
                          </Button>
                        </NoticeCard>
                      )}
                    </Show>
                    <div ref={articleContent}>
                      <Show when={articleParts()}>{(parts) => <MarkdownView trustedHtml={parts().body} class="help-document" />}</Show>
                    </div>
                    <Show when={payload()}>{(document) => <ArticleEnd document={document()} />}</Show>
                  </Show>
                </div>
                <Show when={topic().kind === "document"}>
                  <aside class="help-article-aside">
                    <div class="help-article-aside-sticky">
                      <TableOfContents
                        items={articleSections()}
                        title={t().onThisPage}
                        scrollRoot={tocScrollRoot}
                        contentRoot={() => articleContent}
                        onActiveChange={(id) => setActiveSectionId(id ?? null)}
                      />
                      <Show when={props.surface !== "modal"}>
                        <Button size="sm" variant="ghost" disabled={!payload()} onClick={() => void copyArticle(topic(), payload())}>
                          <i class={articleClipboard.wasCopied() ? "ti ti-check" : "ti ti-markdown"} />
                          {articleClipboard.wasCopied() ? t().copied : t().copyMarkdown}
                        </Button>
                      </Show>
                    </div>
                  </aside>
                </Show>
              </div>
            </article>
          )}
        </Show>
        <span class="sr-only" aria-live="polite">
          {articleClipboard.wasCopied() ? t().articleCopiedAnnouncement : allHelpClipboard.wasCopied() ? t().allCopiedAnnouncement : ""}
        </span>
      </ReaderContent>
    </div>
  );
};

const createSession = (initialTopic?: string): HelpSession => {
  let activeId: string | null = initialTopic ?? null;
  if (!activeId && typeof window !== "undefined") {
    try {
      activeId = localStorage.getItem(LAST_TOPIC_KEY);
    } catch {
      /* Storage is optional. */
    }
  }
  return {
    view: initialTopic ? "article" : "hub",
    query: "",
    activeId,
    articleScrollTop: 0,
    articleCache: new Map(),
  };
};

/**
 * Render the shared Help experience as a full page. Apps pass the same
 * manifest used by `Layout.HelpDocuments`; article bodies still load lazily
 * from the central Help API.
 */
export function LayoutHelpPage(props: LayoutHelpPageProps) {
  const session = createSession(props.initialTopic);
  return (
    <HelpShell
      session={session}
      close={() => {}}
      documents={props.documents}
      includeShortcuts={props.includeShortcuts}
      accent={props.accent}
      surface={props.embedded ? "embedded" : "page"}
      pageBase={props.pageBase}
      syncPageUrl={!props.embedded && !!props.pageBase}
    />
  );
}

/** Open the current app's Help over the page; the dialog sits outside the app canvas, so it takes the app's accent along. */
export function openLayoutHelpDialog() {
  const session = createSession();
  const accent = readShellData()?.accent;
  void prompts.dialog<void>(
    (close) => <HelpShell session={session} close={close} accent={accent} surface="modal" pageBase={window.__cloudLayoutHelpPageBase} />,
    { surface: "bare", header: false, size: "wide" },
  );
}
