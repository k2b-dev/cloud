import type { HelpAccessLevel, HelpArticleLink, HelpDocumentManifest, HelpDocumentPayload } from "@k2b/cloud/shared";
import { clipboard } from "@k2b/stdlib/solid";
import {
  Button,
  Dropdown,
  IconButton,
  Kbd,
  MarkdownView,
  NoticeCard,
  Placeholder,
  prefersReducedMotion,
  prompts,
  ScrollArea,
  TableOfContents,
  TextInput,
  toast,
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
import {
  type HelpShortcutCommand,
  type HelpShortcutScope,
  type HelpStartGroupKind,
  helpShortcutGroups,
  helpStart,
} from "./layout-help-start";
import { helpLinkTarget, layoutHelpTopicHref } from "./layout-help-url";
import { platformMessages } from "./platform-messages";
import { readShellData, useShellData } from "./shell-data";
import { shellShortcuts } from "./shell-shortcuts";

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
const byOrder = (a: HelpTopic, b: HelpTopic) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title);
const sortedTopics = () => [...(registry()?.values() ?? [])].sort(byOrder);
const mergeTopics = (registered: readonly HelpTopic[], documents: readonly HelpDocumentManifest[] = []): HelpTopic[] => {
  const topics = new Map(registered.map((topic) => [topic.id, topic]));
  for (const topic of documents) topics.set(topic.id, topic);
  return [...topics.values()].sort(byOrder);
};
const GROUP_ICONS: Record<HelpStartGroupKind, string> = {
  start: "ti ti-rocket",
  reference: "ti ti-book-2",
  troubleshoot: "ti ti-lifebuoy",
};

/**
 * Keyboard shortcuts come last in the start. The browser knows the page's commands. On a Layout page (it has shell
 * data) the shell always registers its own Search and Help shortcuts, so they show from the server render and every
 * first client render on, also before the shell has registered them. The groups reserve their height and place in CSS,
 * so the ones the browser adds fill space that is already there.
 */
const StartShortcuts = (props: { appName?: string }) => {
  const locale = useLocale();
  const t = () => helpMessages.resolve([locale()]).t;
  const shell = useShellData();
  const seed: HelpShortcutCommand[] = shell ? shellShortcuts(platformMessages.resolve([locale()]).t) : [];
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
  const label = (scope: HelpShortcutScope) =>
    scope === "everywhere"
      ? t().shortcutsEverywhere
      : scope === "selection"
        ? t().shortcutsWithSelection
        : props.appName
          ? t().shortcutsInApp({ app: props.appName })
          : t().shortcutsInThisApp;
  return (
    <section class="help-start-section help-start-shortcuts" data-help-shortcuts="" aria-labelledby="help-start-shortcuts-title">
      <h3 id="help-start-shortcuts-title" class="help-start-heading">
        <i class="ti ti-keyboard" aria-hidden="true" />
        {t().keyboardShortcuts}
      </h3>
      <div class="help-shortcut-groups">
        <For each={helpShortcutGroups(commands())}>
          {(group) => (
            <section class="help-shortcut-group" data-help-shortcut-group={group.scope} aria-label={label(group.scope)}>
              <h4 class="help-shortcut-group-title" aria-hidden="true">
                {label(group.scope)}
              </h4>
              <ul>
                <For each={group.shortcuts}>
                  {(command) => (
                    <li class="help-shortcut" title={command.description}>
                      <span class="help-shortcut-title">{command.title}</span>
                      <Kbd keys={command.shortcut} platform={shell?.platform} />
                    </li>
                  )}
                </For>
              </ul>
            </section>
          )}
        </For>
      </div>
    </section>
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
  const app = shell?.apps.find((candidate) => candidate.id === appId);
  const appName = app?.label;
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
    const dialog = root?.closest("dialog");
    dialog?.setAttribute("aria-labelledby", "layout-help-title");
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
    if (!topic || view() !== "article") return;
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

  /** Rows: icon tile, title, and description; the start's groups, its further tasks, and search results use them. */
  const TopicList = (listProps: { items: HelpTopic[]; marker?: string }) => (
    <ul class="help-start-rows" {...(listProps.marker ? { [listProps.marker]: "" } : {})}>
      <For each={listProps.items}>
        {(topic) => (
          <li>
            <button type="button" class="help-start-row focus-ui" data-help-topic={topic.id} onClick={() => openTopic(topic.id)}>
              <span class="help-topic-icon help-start-row-icon app-accent-text" aria-hidden="true">
                <i class={iconClass(topic.icon)} />
              </span>
              <span class="help-article-link-copy">
                <span class="help-article-link-title">{topic.title}</span>
                <Show when={topic.description}>{(description) => <span class="help-article-link-description">{description()}</span>}</Show>
              </span>
              <i class="ti ti-chevron-right help-start-row-arrow" aria-hidden="true" />
            </button>
          </li>
        )}
      </For>
    </ul>
  );

  /** At most eight tasks as tiles; the app colour shows only in the icon. */
  const TaskTiles = (tilesProps: { items: HelpTopic[] }) => (
    <ul class="help-start-tiles" data-help-tiles="">
      <For each={tilesProps.items}>
        {(topic) => (
          <li>
            <button type="button" class="help-start-tile focus-ui" data-help-topic={topic.id} onClick={() => openTopic(topic.id)}>
              <span class="help-topic-icon help-start-tile-icon app-accent-text" aria-hidden="true">
                <i class={iconClass(topic.icon)} />
              </span>
              <span class="help-start-tile-title">{topic.title}</span>
              <Show when={topic.description}>{(description) => <span class="help-start-tile-description">{description()}</span>}</Show>
            </button>
          </li>
        )}
      </For>
    </ul>
  );

  const groupTitle = (kind: HelpStartGroupKind) =>
    ({ start: t().groupStart, reference: t().groupReference, troubleshoot: t().groupTroubleshoot })[kind];

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

  const pageHref = () => (props.pageBase ? layoutHelpTopicHref(props.pageBase, view() === "article" ? activeId() : null) : undefined);
  const menuItems = () => [
    {
      label: t().copyAsMarkdown,
      icon: "ti ti-markdown",
      ...(copyingAll() || (view() === "article" ? !payload() : topics().length === 0)
        ? { disabled: true as const }
        : { action: () => void copyFromMenu() }),
    },
    ...(props.surface === "modal" && pageHref() ? [{ label: t().openAsPage, icon: "ti ti-app-window", href: pageHref()! }] : []),
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
      style={appAccentStyle(props.accent)}
    >
      {/* One head in every view: the search never moves between the start, an article, and results. An app's embedded
          reader sits in the app's own chrome, which names it and picks its article, so it keeps only the search of its start. */}
      <Show when={props.surface !== "embedded" || view() === "hub"}>
        <header class="help-head" data-help-head="">
          <div class="help-head-inner help-measure">
            <Show when={props.surface !== "embedded"}>
              <div class="help-head-row">
                {/* The back button takes the app tile's place in an article, so nothing beside it moves. */}
                <Show
                  when={view() === "article"}
                  fallback={
                    <span class="help-head-tile" aria-hidden="true">
                      <i class={app?.iconClass ?? "ti ti-help"} />
                    </span>
                  }
                >
                  <IconButton class="help-head-back" label={t().backToTopics} title={t().back} onClick={goBack}>
                    <i class="ti ti-arrow-left" />
                  </IconButton>
                </Show>
                <h2 id="layout-help-title" class="help-head-title">
                  {appName ? t().helpFor({ app: appName }) : t().help}
                </h2>
                <div class="help-head-actions" role="group" aria-label={t().actions}>
                  <Dropdown.Root label={t().moreActions} position="bottom-left" items={menuItems()}>
                    <Dropdown.Trigger iconOnly label={t().moreActions} variant="ghost" data-help-menu="">
                      <i class="ti ti-dots" aria-hidden="true" />
                    </Dropdown.Trigger>
                  </Dropdown.Root>
                  <Show when={props.surface === "modal"}>
                    <IconButton label={t().closeHelp} title={t().close} onClick={props.close}>
                      <i class="ti ti-x" />
                    </IconButton>
                  </Show>
                </div>
              </div>
            </Show>
            <TextInput
              ref={searchInput}
              type="search"
              class="help-head-search"
              icon="ti ti-search"
              aria-label={t().searchHelp}
              data-help-search=""
              value={query()}
              placeholder={t().searchPlaceholder}
              onValueChange={changeQuery}
            />
          </div>
        </header>
      </Show>

      <ReaderContent>
        <Show when={view() === "hub"}>
          <div ref={resultsRegion} data-help-results="" class="help-start help-measure" style={{ "min-height": resultsMinHeight() }}>
            <Show
              when={normalizedQuery()}
              fallback={
                <>
                  <Show when={start().view.length > 0}>
                    <section class="help-start-section" data-help-view="" aria-labelledby="help-start-view-title">
                      <h3 id="help-start-view-title" class="help-start-heading">
                        <i class="ti ti-focus-2" aria-hidden="true" />
                        {t().forThisView}
                      </h3>
                      <TopicList items={start().view} />
                    </section>
                  </Show>
                  <Show when={start().tiles.length > 0}>
                    <section class="help-start-section" data-help-tasks="" aria-labelledby="help-start-tasks-title">
                      <h3 id="help-start-tasks-title" class="help-start-heading">
                        <i class="ti ti-checklist" aria-hidden="true" />
                        {t().whatToDo}
                      </h3>
                      <TaskTiles items={start().tiles} />
                      <Show when={start().moreTasks.length > 0}>
                        <TopicList items={start().moreTasks} marker="data-help-more-tasks" />
                      </Show>
                    </section>
                  </Show>
                  <Show when={start().groups.length > 0}>
                    <div class="help-start-groups">
                      <For each={start().groups}>
                        {(group) => (
                          <section
                            class="help-start-section"
                            data-help-group={group.kind}
                            aria-labelledby={`help-start-${group.kind}-title`}
                          >
                            <h3 id={`help-start-${group.kind}-title`} class="help-start-heading">
                              <i class={GROUP_ICONS[group.kind]} aria-hidden="true" />
                              {groupTitle(group.kind)}
                            </h3>
                            <TopicList items={group.topics} />
                          </section>
                        )}
                      </For>
                    </div>
                  </Show>
                  {/* An app without Help says so plainly; only a failed read of its Help offers a way to try again. */}
                  <Show when={topics().length === 0}>
                    <Show
                      when={shell?.helpFailed}
                      fallback={<Placeholder icon="ti ti-book-off" title={t().noArticles} description={t().noArticlesDetail} />}
                    >
                      <NoticeCard tone="danger" title={t().helpUnavailable} detail={t().helpUnavailableDetail} data-help-unavailable="">
                        <Button size="sm" variant="secondary" onClick={() => location.reload()}>
                          {t().reload}
                        </Button>
                      </NoticeCard>
                    </Show>
                  </Show>
                  <Show when={props.includeShortcuts !== false}>
                    <StartShortcuts appName={appName} />
                  </Show>
                </>
              }
            >
              {/* The count takes the place of the first heading, so the first row stays where it was. */}
              <section class="help-start-section" data-help-search-results="">
                {/* A failed full-text search says so in the same line, with a way to try again; the results do not move. */}
                <div class="help-start-status">
                  <span aria-live="polite">{t().results({ count: results().length })}</span>
                  <Show when={searching()}>
                    <i class="ti ti-loader-2 animate-spin" aria-hidden="true" />
                  </Show>
                  <Show when={searchFailed()}>
                    <span class="help-start-status-warning" data-help-search-failed="" title={t().searchTitlesOnly} role="status">
                      <i class="ti ti-alert-triangle" aria-hidden="true" />
                      <span aria-hidden="true">{t().titlesOnly}</span>
                      <span class="sr-only">{t().searchTitlesOnly}</span>
                    </span>
                    <Button
                      size="xs"
                      variant="ghost"
                      class="help-start-status-retry"
                      onClick={() => setSearchAttempt((value) => value + 1)}
                    >
                      {t().tryAgain}
                    </Button>
                  </Show>
                </div>
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
                        <Show when={articleParts() && topic().description}>
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
                    <Show when={articleSections().length > 0 || props.surface !== "modal"}>
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
                        <Show when={props.surface !== "modal"}>
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
                </div>
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
              </div>
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
