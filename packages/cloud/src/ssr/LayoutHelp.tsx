import type { HelpArticleLink, HelpDocumentManifest, HelpDocumentPayload } from "@k2b/cloud/shared";
import { listenPopState } from "@k2b/ssr/nav";
import { clipboard } from "@k2b/stdlib/solid";
import {
  BottomSheet,
  Button,
  bottomSheetOptions,
  Dropdown,
  dialogCore,
  IconButton,
  MarkdownView,
  NoticeCard,
  Placeholder,
  prefersReducedMotion,
  prompts,
  ScrollArea,
  TableOfContents,
  toast,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, type JSX, onCleanup, onMount, Show, untrack } from "solid-js";
import { COMMANDS_CHANGED, contextCommandsWithShortcuts } from "../browser/command-shortcuts";
import { openPanel } from "../browser/panel";
import { HELP_ACCESS_LEVELS, HELP_KINDS } from "../shared/help";
import { appAccentStyle } from "./app-appearance";
import type { LayoutHelpArticle } from "./help";
import { helpMessages } from "./help-messages";
import { helpArticleParts } from "./layout-help-article";
import { formatHelpBundleMarkdown, formatHelpDocumentMarkdown } from "./layout-help-markdown";
import { focusHelpArticleHeading, resetHelpArticleScroll } from "./layout-help-navigation";
import { HELP_TOPICS_EVENT, type HelpTopic, registry } from "./layout-help-registry";
import { searchHelpTopics } from "./layout-help-search";
import { type HelpShortcutCommand, helpShortcutGroups, helpStart } from "./layout-help-start";
import { helpLinkTarget, layoutHelpTopicHref } from "./layout-help-url";
import { HelpArticleView, HelpHead, HelpResultsView, HelpShortcutsView, HelpStartView, type HelpSurface } from "./layout-help-views";
import { platformMessages } from "./platform-messages";
import { readShellData, useShellData } from "./shell-data";
import { shellShortcuts } from "./shell-shortcuts";

export type LayoutHelpPageProps = {
  documents: readonly HelpDocumentManifest[];
  initialTopic?: string;
  /** Authorized article and server-parsed parts for an identical first frame. */
  initialArticle?: LayoutHelpArticle;
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

const byOrder = (a: HelpTopic, b: HelpTopic) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title);
const sortedTopics = () => [...(registry()?.values() ?? [])].sort(byOrder);
const mergeTopics = (registered: readonly HelpTopic[], documents: readonly HelpDocumentManifest[] = []): HelpTopic[] => {
  const topics = new Map(registered.map((topic) => [topic.id, topic]));
  for (const topic of documents) topics.set(topic.id, topic);
  return [...topics.values()].sort(byOrder);
};

/**
 * Keyboard shortcuts come last in the start. The browser knows the page's commands. On a Layout page (it has shell
 * data) the shell always registers its own Search and Help shortcuts, so they show from the server render and every
 * first client render on, also before the shell has registered them. The groups reserve their height and place in CSS,
 * so the ones the browser adds fill space that is already there.
 */
const StartShortcuts = (props: { appName?: string }) => {
  const locale = useLocale();
  const shell = useShellData();
  const seed: HelpShortcutCommand[] = shell ? shellShortcuts(platformMessages.resolve([locale()]).t, { panel: !!shell.panel }) : [];
  const read = (): HelpShortcutCommand[] => {
    const commands = contextCommandsWithShortcuts();
    return [...seed.filter((command) => !commands.some((other) => other.id === command.id)), ...commands];
  };
  const [commands, setCommands] = createSignal<HelpShortcutCommand[]>(read());
  onMount(() => {
    const update = () => setCommands(read());
    update();
    window.addEventListener(COMMANDS_CHANGED, update);
    onCleanup(() => window.removeEventListener(COMMANDS_CHANGED, update));
  });
  return <HelpShortcutsView groups={helpShortcutGroups(commands())} appName={props.appName} platform={shell?.platform} />;
};

const HelpShell = (props: {
  session: HelpSession;
  initialArticle?: LayoutHelpArticle;
  close: () => void;
  pageBase?: string;
  documents?: readonly HelpDocumentManifest[];
  includeShortcuts?: boolean;
  accent?: string;
  /** The app's canvas colours for a reader outside the app canvas. */
  appearance?: string;
  surface: HelpSurface;
  syncPageUrl?: boolean;
}) => {
  const locale = useLocale();
  const t = () => helpMessages.resolve([locale()]).t;
  // Links to this app's Help, by its own route or Core's `/help/apps/<id>`, open in place.
  const shell = useShellData();
  const appId = shell?.appId;
  const app = shell?.apps.find((candidate) => candidate.id === appId);
  const appName = app?.label;
  const registeredTopics = () => sortedTopics();
  const [externalTopics, setExternalTopics] = createSignal(mergeTopics(registeredTopics(), props.documents));
  const [view, setView] = createSignal<HelpView>(props.session.view);
  const [query, setQuery] = createSignal(props.session.query);
  const [activeId, setActiveId] = createSignal<string | null>(props.session.activeId);
  const initialTopic = props.documents?.find((topic) => topic.id === props.session.activeId);
  const initialArticle = initialTopic && props.initialArticle?.payload.id === initialTopic.id ? props.initialArticle : undefined;
  // HTML travels once as parts; rebuild it for the cache and the article settle effect.
  const seeded = initialArticle
    ? { ...initialArticle.payload, html: (initialArticle.parts.lead ?? "") + initialArticle.parts.body }
    : undefined;
  if (seeded && initialTopic) props.session.articleCache.set(`${initialTopic.locale ?? "en"}:${initialTopic.url}`, seeded);
  const [payload, setPayload] = createSignal<HelpDocumentPayload | null>(seeded ?? null);
  const [loading, setLoading] = createSignal(props.session.view === "article" && !initialArticle);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [loadAttempt, setLoadAttempt] = createSignal(0);
  const [remoteIds, setRemoteIds] = createSignal<readonly string[] | null>(null);
  const [searching, setSearching] = createSignal(false);
  const [searchFailed, setSearchFailed] = createSignal(false);
  const [searchAttempt, setSearchAttempt] = createSignal(0);
  const [copyingAll, setCopyingAll] = createSignal(false);
  const [activeSectionId, setActiveSectionId] = createSignal<string | null>(null);
  const [tocScrollRoot, setTocScrollRoot] = createSignal<HTMLElement>();
  const writeText = (text: string) => navigator.clipboard.writeText(text);
  const articleClipboard = clipboard.createWriter({ write: writeText, copiedFor: 1800 });
  const allHelpClipboard = clipboard.createWriter({ write: writeText, copiedFor: 1800 });
  /** The article a search started from; clearing the search returns to it. */
  let searchReturnId: string | null = null;
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

  const topics = externalTopics;
  const start = createMemo(() => helpStart(topics(), props.surface === "modal" ? shell?.help : undefined));
  const activeTopic = createMemo(() => topics().find((topic) => topic.id === activeId()) ?? null);
  // Reuse the serialized parts for the initial object on both sides of the island boundary.
  const articleParts = createMemo(() => {
    const article = payload();
    if (initialArticle && article === seeded) return initialArticle.parts;
    return article?.html ? helpArticleParts(article.html) : null;
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
    searchAttempt();
    const urls = [...new Set(topics().map((topic) => topic.searchUrl))];
    const version = ++searchVersion;
    setRemoteIds(null);
    setSearching(false);
    setSearchFailed(false);
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
          // Metadata matches stay usable if full-text search is temporarily unavailable; the results say so.
          if (version === searchVersion) setSearchFailed(true);
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
    if (props.surface === "modal") {
      const key = (event: KeyboardEvent) => {
        if (event.defaultPrevented || event.isComposing) return;
        const target = event.target;
        if (event.key === "Escape" && target === searchInput && query()) {
          event.preventDefault();
          changeQuery("");
          return;
        }
        // Some layouts type "/" with Shift (German: Shift+7), so Shift does not disqualify it.
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (
          event.key === "/" &&
          !(target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'))
        ) {
          event.preventDefault();
          searchInput?.focus();
        }
      };
      document.addEventListener("keydown", key);
      onCleanup(() => document.removeEventListener("keydown", key));
    }
    const dialog = root?.closest("dialog");
    dialog?.setAttribute("aria-labelledby", "layout-help-title");
    const update = () => setExternalTopics(mergeTopics(registeredTopics(), props.documents));
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
    const stopPopState = props.syncPageUrl ? listenPopState(onPopState) : undefined;
    onCleanup(() => {
      scrollArea?.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      stopPopState?.();
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
    const cached = topic && view() === "article" ? props.session.articleCache.get(`${topic.locale ?? "en"}:${topic.url}`) : undefined;
    setLoadError(null);
    setLoading(false);
    // Keep a seeded payload in place on mount: no empty frame or duplicate scroll restoration.
    if (cached) {
      if (untrack(payload) !== cached) {
        setPayload(cached);
        restoreArticleScroll();
      }
      return;
    }
    setPayload(null);
    if (!topic || view() !== "article") return;

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

  /**
   * Copies the open article. The article's own buttons show "Copied" in place; the menu closes on choice, so it confirms
   * with a toast. A failed write always ends in an error toast with Try again.
   */
  const copyArticle = async (topic: HelpTopic, document: HelpDocumentPayload | null, confirm = false) => {
    if (!document) return;
    if (await articleClipboard.copy(formatHelpDocumentMarkdown({ ...topic, markdown: document.markdown }))) {
      if (confirm) toast.success(t().articleCopied);
      return;
    }
    toast.error(t().copyFailed({ message: articleClipboard.error()?.message ?? t().copyFallback }), {
      action: { label: t().tryAgain, onClick: () => void copyArticle(topic, document, confirm) },
    });
  };

  const copyFromMenu = async () => {
    const topic = activeTopic();
    if (view() === "article" && topic) await copyArticle(topic, payload(), true);
    else await copyAllHelp();
  };

  const copyAllHelp = async () => {
    const manifests = topics();
    if (manifests.length === 0 || copyingAll()) return;

    copyAllController?.abort();
    const controller = new AbortController();
    copyAllController = controller;
    setCopyingAll(true);
    const progress = toast(t().preparing, { progress: "indeterminate", duration: 0, iconClass: "ti ti-markdown" });
    try {
      const documents = await Promise.all(
        manifests.map(async (topic) => {
          const document = await loadDocument(topic, controller.signal);
          return { ...topic, markdown: document.markdown };
        }),
      );
      if (!(await allHelpClipboard.copy(formatHelpBundleMarkdown(documents))))
        throw allHelpClipboard.error() ?? new Error(t().copyFallback);
      progress.dismiss();
      toast.success(t().helpCopied);
    } catch (error) {
      progress.dismiss();
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        toast.error(t().copyAllFailed({ message: error instanceof Error ? error.message : t().copyFallback }), {
          action: { label: t().tryAgain, onClick: () => void copyAllHelp() },
        });
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
    searchReturnId = null;
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
    searchReturnId = null;
    setQuery("");
    setResultsMinHeight(undefined);
    setRemoteIds(null);
    setView("hub");
    if (push) pushHelpUrl(null);
  };
  const goBack = () => {
    searchReturnId = null;
    setView("hub");
    pushHelpUrl(null);
  };
  /** The search stays in the head in every view. Typing in an article shows results; clearing the search returns to the article. */
  const changeQuery = (value: string) => {
    const searching = !!value.trim();
    if (searching && view() === "article") {
      searchReturnId = activeId();
      setResultsMinHeight(undefined);
      setView("hub");
    } else if (searching && !query().trim()) {
      // Results replace the start below the field; the area keeps its height so nothing moves.
      setResultsMinHeight(`${resultsRegion?.offsetHeight ?? 0}px`);
    }
    setQuery(value);
    if (searching) return;
    setResultsMinHeight(undefined);
    const returnId = searchReturnId;
    searchReturnId = null;
    if (returnId && topics().some((topic) => topic.id === returnId)) {
      setActiveId(returnId);
      setView("article");
    }
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

  const ReaderContent = (content: { children: JSX.Element }) =>
    props.surface === "page" ? (
      <div class="p-4 sm:p-5">{content.children}</div>
    ) : (
      <ScrollArea ref={scrollArea} class="min-h-0 flex-1 p-4 sm:p-5">
        {content.children}
      </ScrollArea>
    );

  // The dialog copies from its ⋯ menu; only the page repeats the copy action beside the article.
  const copyInMenu = props.surface === "modal";
  const pageHref = () => (props.pageBase ? layoutHelpTopicHref(props.pageBase, view() === "article" ? activeId() : null) : undefined);
  const menuItems = () => [
    {
      label: t().copyAsMarkdown,
      icon: "ti ti-markdown",
      ...(copyingAll() || (view() === "article" ? !payload() : topics().length === 0)
        ? { disabled: true as const }
        : { action: () => void copyFromMenu() }),
    },
    ...(copyInMenu && pageHref() ? [{ label: t().openAsPage, icon: "ti ti-app-window", href: pageHref()! }] : []),
  ];

  return (
    <div
      ref={root}
      class={`help-shell app-accent-scope flex min-h-0 flex-col ${props.surface === "page" ? "" : "bg-[var(--ui-surface-raised)]"} ${
        props.surface === "modal"
          ? "h-[min(48rem,var(--ui-dialog-available-height))] overflow-hidden panel-dialog-shell [box-shadow:var(--ui-shadow-float)]"
          : props.surface === "page"
            ? ""
            : "h-full"
      }`}
      data-surface={props.surface}
      style={[appAccentStyle(props.accent), props.appearance].filter(Boolean).join(";") || undefined}
    >
      <Show when={props.surface !== "embedded" || view() === "hub"}>
        <HelpHead
          row={props.surface !== "embedded"}
          back={view() === "article"}
          tile={app?.iconClass ?? "ti ti-help-circle"}
          title={appName ? t().helpFor({ app: appName }) : t().help}
          menu={
            <Dropdown.Root label={t().moreActions} position="bottom-left" items={menuItems()}>
              <Dropdown.Trigger iconOnly label={t().moreActions} variant="ghost" data-help-menu="">
                <i class="ti ti-dots" aria-hidden="true" />
              </Dropdown.Trigger>
            </Dropdown.Root>
          }
          closable={props.surface === "modal"}
          onBack={goBack}
          onClose={props.close}
          query={query()}
          onQuery={changeQuery}
          searchRef={(element) => {
            searchInput = element;
          }}
        />
      </Show>

      <ReaderContent>
        <Show when={view() === "hub"}>
          <div ref={resultsRegion} data-help-results="" class="help-start help-measure" style={{ "min-height": resultsMinHeight() }}>
            <Show
              when={normalizedQuery()}
              fallback={
                <HelpStartView
                  start={start()}
                  empty={topics().length === 0}
                  failed={!!shell?.helpFailed}
                  onOpen={openTopic}
                  onReload={() => location.reload()}
                  shortcuts={
                    <Show when={props.includeShortcuts !== false}>
                      <StartShortcuts appName={appName} />
                    </Show>
                  }
                />
              }
            >
              <HelpResultsView
                results={results()}
                searching={searching()}
                failed={searchFailed()}
                onRetry={() => setSearchAttempt((value) => value + 1)}
                onOpen={openTopic}
              />
            </Show>
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
              <HelpArticleView
                surface={props.surface}
                topic={topic()}
                appName={appName}
                appId={appId}
                parts={articleParts()}
                document={payload()}
                Markdown={MarkdownView}
                showTools={articleSections().length > 0 || !copyInMenu}
                sectionMenu={
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
                }
                copyButton={
                  <Show when={!copyInMenu}>
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
                }
                loading={
                  <Show when={loading()}>
                    <div class="min-h-[24rem]">
                      <Placeholder state="loading" variant="panel" title={t().loading} />
                    </div>
                  </Show>
                }
                failure={
                  <Show when={loadError()}>
                    {(message) => (
                      <NoticeCard tone="danger" title={t().loadFailed} detail={message()}>
                        <Button size="sm" variant="secondary" onClick={() => setLoadAttempt((value) => value + 1)}>
                          {t().tryAgain}
                        </Button>
                      </NoticeCard>
                    )}
                  </Show>
                }
                toc={
                  <TableOfContents
                    items={articleSections()}
                    title={t().onThisPage}
                    scrollRoot={tocScrollRoot}
                    contentRoot={() => articleContent}
                    onActiveChange={(id) => setActiveSectionId(id ?? null)}
                  />
                }
                copyAction={
                  <Show when={!copyInMenu}>
                    <Button size="sm" variant="ghost" disabled={!payload()} onClick={() => void copyArticle(topic(), payload())}>
                      <i class={articleClipboard.wasCopied() ? "ti ti-check" : "ti ti-markdown"} />
                      {articleClipboard.wasCopied() ? t().copied : t().copyMarkdown}
                    </Button>
                  </Show>
                }
                headingRef={(element) => {
                  articleHeading = element;
                }}
                contentRef={(element) => {
                  articleContent = element;
                }}
                onBack={goBack}
              />
            </article>
          )}
        </Show>
        <span class="sr-only" aria-live="polite">
          {articleClipboard.wasCopied() ? t().articleCopiedAnnouncement : ""}
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
 * manifest used by `Layout.HelpDocuments`; initialArticle supplies the first
 * article, while other articles load from the central Help API.
 */
export function LayoutHelpPage(props: LayoutHelpPageProps) {
  const session = createSession(props.initialTopic);
  return (
    <HelpShell
      session={session}
      initialArticle={props.initialTopic ? props.initialArticle : undefined}
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

/** The dialog renders outside the app canvas; it takes the app's canvas colours along for the article head. */
const canvasAppearance = () => {
  const canvas = document.querySelector(".cloud-app-canvas");
  if (!canvas) return undefined;
  const style = getComputedStyle(canvas);
  return CANVAS_PROPERTIES.flatMap((name) => {
    const value = style.getPropertyValue(name).trim();
    return value ? [`${name}:${value}`] : [];
  }).join(";");
};
const CANVAS_PROPERTIES = [
  "--app-canvas-from",
  "--app-canvas-via",
  "--app-canvas-to",
  "--app-canvas-angle",
  "--app-canvas-strength",
  "--app-canvas-dark-strength",
];

/**
 * Open Core's Help provider in the panel slot, or fall back to the current app's dialog when no slot accepts it
 * (anonymous pages, `Layout panel={false}`, an app on an older @k2b/cloud). On a phone the fallback is the shared
 * bottom sheet at full height, like the panel's phone sheet.
 */
export function openLayoutHelpDialog() {
  if (openPanel("core")) return;
  const session = createSession();
  const accent = readShellData()?.accent;
  const appearance = canvasAppearance();
  const pageBase = window.__cloudLayoutHelpPageBase;
  if (window.matchMedia("(max-width: 47.999rem)").matches) {
    void dialogCore.open<void>(
      (close, context) => (
        <BottomSheet onDismiss={context.requestDismiss}>
          <HelpShell session={session} close={() => close()} accent={accent} appearance={appearance} surface="modal" pageBase={pageBase} />
        </BottomSheet>
      ),
      {
        ...bottomSheetOptions,
        panelClassName: `${bottomSheetOptions.panelClassName} cloud-help-sheet`,
        ariaLabel: helpMessages.resolve([document.documentElement.lang || "en"]).t.help,
        history: true,
      },
    );
    return;
  }
  void prompts.dialog<void>(
    (close) => <HelpShell session={session} close={close} accent={accent} appearance={appearance} surface="modal" pageBase={pageBase} />,
    { surface: "bare", header: false, size: "wide" },
  );
}
