import { clipboard, hotkeys } from "@k2b/stdlib/solid";
import { Button, IconButton, IconButtonLink, MarkdownView, NoticeCard, Placeholder, prompts, ScrollArea, useLocale } from "@k2b/ui";
import type { HelpDocumentManifest, HelpDocumentPayload, HelpSearchPayload } from "@k2b/cloud/shared";
import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { appAccentStyle } from "./app-appearance";
import { type GlobalSearchHelpApp, openGlobalSearchHelpDialog } from "./GlobalSearchHelpDialog";
import { helpMessages } from "./help-messages";
import { formatHelpBundleMarkdown, formatHelpDocumentMarkdown } from "./layout-help-markdown";
import { adjacentHelpDocuments, focusHelpArticleHeading, resetHelpArticleScroll } from "./layout-help-navigation";
import { layoutHelpTopicHref } from "./layout-help-url";

type HelpTopicBase = {
  id: string;
  title: string;
  icon?: string;
  description?: string;
  order?: number;
};

export type LayoutHelpDocumentsProps = {
  documents: readonly HelpDocumentManifest[];
  /** Canonical standalone Help route owned by the current app. */
  pageBase: string;
};
export type LayoutHelpPageProps = {
  documents: readonly HelpDocumentManifest[];
  initialTopic?: string;
  includeShortcuts?: boolean;
  accent?: string;
  /** Render inside an app-owned pane instead of occupying a standalone page. */
  embedded?: boolean;
  /** Canonical standalone Help route owned by the current app. */
  pageBase?: string;
};

type HelpTopic = (HelpTopicBase & { kind: "content"; children: JSX.Element }) | (HelpDocumentManifest & { kind: "document" });
type HelpView = "hub" | "search" | "article";
type HelpSession = {
  view: HelpView;
  query: string;
  activeId: string | null;
  articleScrollTop: number;
  articleCache: Map<string, HelpDocumentPayload>;
};
type HelpSection = {
  element: HTMLHeadingElement;
  icon: string;
  id: string;
  title: string;
};

const HELP_TOPICS_EVENT = "cloud:layout-help-topics";
const LAST_TOPIC_KEY = "cloud.layoutHelp.activeTopic";

declare global {
  interface Window {
    __cloudLayoutHelpTopics?: Map<string, HelpTopic>;
    __cloudLayoutHelpPageBase?: string;
  }
}

const registry = () => {
  if (typeof window === "undefined") return null;
  window.__cloudLayoutHelpTopics ??= new Map<string, HelpTopic>();
  return window.__cloudLayoutHelpTopics;
};

const emitTopicsChanged = () => window.dispatchEvent(new Event(HELP_TOPICS_EVENT));
const iconClass = (icon?: string) => (icon?.startsWith("ti ") ? icon : `ti ${icon ?? "ti-circle"}`);
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

const registerTopic = (topic: HelpTopic) => {
  const topics = registry();
  if (!topics) return () => {};
  topics.set(topic.id, topic);
  emitTopicsChanged();
  return () => {
    if (topics.get(topic.id) !== topic) return;
    topics.delete(topic.id);
    emitTopicsChanged();
  };
};

/** Register an app's server-prepared Markdown manifest with the shared help UI. */
export function LayoutHelpDocuments(props: LayoutHelpDocumentsProps) {
  onMount(() => {
    window.__cloudLayoutHelpPageBase = props.pageBase;
    const disposers = props.documents.map((document) => registerTopic({ ...document, kind: "document" }));
    onCleanup(() => {
      disposers.forEach((dispose) => dispose());
      if (window.__cloudLayoutHelpPageBase === props.pageBase) delete window.__cloudLayoutHelpPageBase;
    });
  });
  return null;
}

const Shortcuts = (props: { openSearchHelp: () => void }) => {
  const locale = useLocale();
  const t = () => helpMessages.resolve([locale()]).t;
  const entries = createMemo(() => [...hotkeys.entries()].sort((a, b) => a.label.localeCompare(b.label) || a.keys.localeCompare(b.keys)));
  return (
    <div class="flex flex-col gap-3">
      <p class="text-sm leading-relaxed text-dimmed">{t().shortcutsIntro}</p>
      <Button size="sm" variant="secondary" class="self-start" onClick={props.openSearchHelp}>
        <i class="ti ti-search" /> {t().searchHelp}
      </Button>
      <div class="flex flex-col gap-2">
        <For each={entries()}>
          {(entry) => (
            <div class="flex items-start justify-between gap-4 rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)] px-3 py-2.5">
              <div class="min-w-0">
                <p class="text-sm font-medium text-primary">{entry.label}</p>
                <Show when={entry.desc}>
                  <p class="mt-0.5 text-xs text-dimmed">{entry.desc}</p>
                </Show>
              </div>
              <div class="flex shrink-0 gap-1" role="group" aria-label={entry.keysPretty.map((part) => part.ariaLabel).join(" + ")}>
                <For each={entry.keysPretty}>
                  {(part) => (
                    <kbd class="rounded bg-[var(--ui-surface-raised)] px-1.5 py-1 text-[11px] ring-1 ring-black/10 dark:ring-white/10">
                      {part.key}
                    </kbd>
                  )}
                </For>
              </div>
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
  searchHelpApps: GlobalSearchHelpApp[];
  documents?: readonly HelpDocumentManifest[];
  includeShortcuts?: boolean;
  accent?: string;
  surface?: "modal" | "page" | "embedded";
  syncPageUrl?: boolean;
}) => {
  const locale = useLocale();
  const t = () => helpMessages.resolve([locale()]).t;
  const [externalTopics, setExternalTopics] = createSignal(mergeTopics(sortedTopics(), props.documents));
  const [view, setView] = createSignal<HelpView>(props.session.view);
  const [query, setQuery] = createSignal(props.session.query);
  const [activeId, setActiveId] = createSignal<string | null>(props.session.activeId);
  const [payload, setPayload] = createSignal<HelpDocumentPayload | null>(null);
  const [loading, setLoading] = createSignal(props.session.view === "article");
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [loadAttempt, setLoadAttempt] = createSignal(0);
  const [remoteMatches, setRemoteMatches] = createSignal<ReadonlySet<string>>(new Set());
  const [searching, setSearching] = createSignal(false);
  const [copyingAll, setCopyingAll] = createSignal(false);
  const [copyAllError, setCopyAllError] = createSignal<string | null>(null);
  const [articleSections, setArticleSections] = createSignal<HelpSection[]>([]);
  const [activeSectionId, setActiveSectionId] = createSignal<string | null>(null);
  const articleClipboard = clipboard.create(1800);
  const allHelpClipboard = clipboard.create(1800);
  let root: HTMLDivElement | undefined;
  let scrollArea: HTMLDivElement | undefined;
  let articleContent: HTMLDivElement | undefined;
  let articleHeading: HTMLHeadingElement | undefined;
  let pendingArticleFocus = false;
  let requestVersion = 0;
  let searchVersion = 0;
  let copyAllController: AbortController | undefined;

  const restoreArticleScroll = () =>
    requestAnimationFrame(() => {
      if (scrollArea && view() === "article") scrollArea.scrollTop = props.session.articleScrollTop;
    });

  const syncActiveSection = () => {
    const sections = articleSections();
    if (!scrollArea || sections.length === 0) return;
    const readingLine = scrollArea.getBoundingClientRect().top + Math.min(160, scrollArea.clientHeight * 0.22);
    let active = sections[0];
    for (const section of sections) {
      if (section.element.getBoundingClientRect().top <= readingLine) active = section;
      else break;
    }
    setActiveSectionId(active?.id ?? null);
  };

  const collectArticleSections = () => {
    const sections = Array.from(articleContent?.querySelectorAll<HTMLHeadingElement>("h2[id]") ?? []).map((element) => ({
      element,
      icon: element.dataset.helpIcon ?? "ti ti-point",
      id: element.id,
      title: element.textContent?.trim() || t().section,
    }));
    setArticleSections(sections);
    setActiveSectionId(sections[0]?.id ?? null);
    requestAnimationFrame(syncActiveSection);
  };

  const openArticleSection = (section: HelpSection) => {
    setActiveSectionId(section.id);
    section.element.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    });
  };

  const shortcutsTopic = createMemo<HelpTopic>(() => ({
    id: "shortcuts",
    title: t().shortcuts,
    icon: "ti ti-keyboard",
    description: t().shortcutsDescription,
    order: 0,
    kind: "content",
    children: <Shortcuts openSearchHelp={() => openGlobalSearchHelpDialog(props.searchHelpApps, locale())} />,
  }));
  const topics = createMemo(() => (props.includeShortcuts === false ? externalTopics() : [shortcutsTopic(), ...externalTopics()]));
  const documentTopics = createMemo(() =>
    externalTopics().filter((topic): topic is HelpDocumentManifest & { kind: "document" } => topic.kind === "document"),
  );
  const activeTopic = createMemo(() => topics().find((topic) => topic.id === activeId()) ?? null);
  const adjacentTopics = createMemo(() => adjacentHelpDocuments(documentTopics(), activeId()));
  const normalizedQuery = createMemo(() => query().trim().toLocaleLowerCase());
  const results = createMemo(() => {
    const value = normalizedQuery();
    if (!value) return topics();
    const matches = remoteMatches();
    return topics().filter(
      (topic) => [topic.title, topic.description].some((part) => part?.toLocaleLowerCase().includes(value)) || matches.has(topic.id),
    );
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
    setRemoteMatches(new Set<string>());
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
          const payload = (await response.json()) as Partial<HelpSearchPayload>;
          return Array.isArray(payload.ids) ? payload.ids.filter((id): id is string => typeof id === "string") : [];
        }),
      )
        .then((groups) => {
          if (version === searchVersion) setRemoteMatches(new Set<string>(groups.flat()));
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
      setArticleSections([]);
      setActiveSectionId(null);
      return;
    }
    const frame = requestAnimationFrame(collectArticleSections);
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
  });
  onCleanup(() => copyAllController?.abort());

  const loadDocument = async (topic: HelpDocumentManifest, signal: AbortSignal) => {
    const cacheKey = `${topic.locale ?? "en"}:${topic.url}`;
    const cached = props.session.articleCache.get(cacheKey);
    if (cached) return cached;

    const response = await fetch(topic.url, { signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(t().requestFailed);
    const value = (await response.json()) as Partial<HelpDocumentPayload>;
    if (
      value.id !== topic.id ||
      (value.locale !== undefined && typeof value.locale !== "string") ||
      (topic.locale !== undefined && value.locale !== undefined && value.locale !== topic.locale) ||
      typeof value.html !== "string" ||
      typeof value.markdown !== "string" ||
      typeof value.title !== "string"
    ) {
      throw new Error(t().invalidDocument);
    }
    const document: HelpDocumentPayload = { ...(value as HelpDocumentPayload), locale: value.locale ?? topic.locale ?? "en" };
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

  const openTopic = (id: string) => {
    resetHelpArticleScroll(props.session, scrollArea);
    pendingArticleFocus = true;
    setActiveId(id);
    setView("article");
    if (props.syncPageUrl) {
      if (props.pageBase) history.replaceState(history.state, "", layoutHelpTopicHref(props.pageBase, id));
    }
    try {
      localStorage.setItem(LAST_TOPIC_KEY, id);
    } catch {
      /* Help does not depend on storage. */
    }
  };
  const goBack = () => {
    setView(query().trim() ? "search" : "hub");
    if (props.syncPageUrl) {
      if (props.pageBase) history.replaceState(history.state, "", layoutHelpTopicHref(props.pageBase, null));
    }
  };
  const showHub = () => {
    setQuery("");
    setRemoteMatches(new Set<string>());
    setView("hub");
  };
  const modalTitle = createMemo(() => {
    if (view() === "article") return activeTopic()?.title ?? t().help;
    if (view() === "search") return t().searchHelp;
    return t().help;
  });
  const modalDescription = createMemo(() => {
    if (view() === "article") return activeTopic()?.description ?? t().description;
    if (view() === "search") return t().searchDescription;
    return t().description;
  });
  const modalIcon = createMemo(() => {
    if (view() === "article") return iconClass(activeTopic()?.icon);
    if (view() === "search") return "ti ti-search";
    return "ti ti-help";
  });

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

  const TopicNavigation = () => (
    <Show when={adjacentTopics().previous || adjacentTopics().next}>
      <nav class="mt-12 grid gap-3 sm:grid-cols-2" aria-label={t().topicNavigation}>
        <Show when={adjacentTopics().previous}>
          {(previous) => (
            <button
              type="button"
              class="group flex min-w-0 flex-col items-start gap-1 rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)] p-4 text-left transition-colors hover:bg-[var(--ui-surface-muted)] focus-ui"
              onClick={() => openTopic(previous().id)}
            >
              <span class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-dimmed">
                <i class="ti ti-arrow-left" aria-hidden="true" />
                {t().previousTopic}
              </span>
              <span class="text-sm font-medium text-primary group-hover:app-accent-text">{previous().title}</span>
            </button>
          )}
        </Show>
        <Show when={adjacentTopics().next}>
          {(next) => (
            <button
              type="button"
              class="group flex min-w-0 flex-col items-end gap-1 rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)] p-4 text-right transition-colors hover:bg-[var(--ui-surface-muted)] focus-ui sm:col-start-2"
              onClick={() => openTopic(next().id)}
            >
              <span class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-dimmed">
                {t().nextTopic}
                <i class="ti ti-arrow-right" aria-hidden="true" />
              </span>
              <span class="text-sm font-medium text-primary group-hover:app-accent-text">{next().title}</span>
            </button>
          )}
        </Show>
      </nav>
    </Show>
  );

  return (
    <div
      ref={root}
      class={`app-accent-scope flex min-h-0 flex-col bg-[var(--ui-surface-raised)] ${
        props.surface === "modal"
          ? "h-[min(48rem,var(--ui-dialog-available-height))] overflow-hidden panel-dialog-shell [box-shadow:var(--ui-shadow-float)]"
          : props.surface === "page"
            ? "min-h-screen"
            : "h-full"
      }`}
      style={appAccentStyle(props.accent)}
    >
      <Show when={props.surface === "modal"}>
        <header class="flex min-h-16 shrink-0 items-center gap-2 px-5 py-3">
          <Show when={view() !== "hub"}>
            <IconButton
              class="shrink-0"
              label={view() === "article" ? t().backToTopics : t().backToHelp}
              title={t().back}
              onClick={() => (view() === "article" ? goBack() : showHub())}
            >
              <i class="ti ti-arrow-left" />
            </IconButton>
          </Show>
          <span class="help-topic-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] app-accent-text">
            <i class={`${modalIcon()} text-lg`} />
          </span>
          <div class="min-w-0 flex-1">
            <h2 ref={articleHeading} id="layout-help-title" tabindex="-1" class="truncate rounded-sm font-semibold text-primary focus-ui">
              {modalTitle()}
            </h2>
            <p id="layout-help-subtitle" class="truncate text-xs text-dimmed" title={modalDescription()}>
              {modalDescription()}
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

      <ScrollArea
        ref={scrollArea}
        class="min-h-0 flex-1 p-4 sm:p-5"
        onScroll={(event) => {
          if (view() === "article") {
            props.session.articleScrollTop = event.currentTarget.scrollTop;
            syncActiveSection();
          }
        }}
      >
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
            <label class="field flex h-11 items-center gap-2 px-3">
              <i class="ti ti-search text-dimmed" />
              <input
                class="min-w-0 flex-1 bg-transparent text-sm outline-none"
                value={query()}
                placeholder={t().searchPlaceholder}
                onInput={(event) => {
                  setQuery(event.currentTarget.value);
                  if (event.currentTarget.value.trim()) setView("search");
                }}
              />
            </label>
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
          </div>
        </Show>

        <Show when={view() === "search"}>
          <div class="mx-auto flex max-w-3xl flex-col gap-4">
            <div class="flex items-center gap-2">
              <Show when={props.surface !== "modal"}>
                <IconButton label={t().backToHelp} onClick={showHub}>
                  <i class="ti ti-arrow-left" />
                </IconButton>
              </Show>
              <label class="field flex h-11 flex-1 items-center gap-2 px-3">
                <i class="ti ti-search text-dimmed" />
                <input
                  autofocus
                  class="min-w-0 flex-1 bg-transparent text-sm outline-none"
                  value={query()}
                  placeholder={t().searchPlaceholder}
                  onInput={(event) => setQuery(event.currentTarget.value)}
                />
              </label>
            </div>
            <p class="flex items-center gap-1.5 text-xs text-dimmed" aria-live="polite">
              <Show when={searching()}>
                <i class="ti ti-loader-2 animate-spin" aria-hidden="true" />
              </Show>
              {t().results({ count: results().length })}
            </p>
            <TopicList items={results()} />
            <Show when={results().length === 0 && !searching()}>
              <Placeholder icon="ti ti-search-off" title={t().noResults} />
            </Show>
          </div>
        </Show>

        <Show when={view() === "article" && activeTopic()}>
          {(topic) => (
            <article class="mx-auto flex min-h-full w-full max-w-7xl flex-col">
              <Show when={props.surface !== "modal"}>
                <button
                  type="button"
                  class="mb-6 inline-flex items-center gap-1.5 text-xs font-medium text-dimmed hover:app-accent-text focus-ui"
                  onClick={goBack}
                >
                  <i class="ti ti-arrow-left" /> {t().back}
                </button>
                <header class="mb-8 grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
                  <span class="help-topic-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] app-accent-text">
                    <i class={`${iconClass(topic().icon)} text-lg`} />
                  </span>
                  <div class="min-w-0 flex-1">
                    <h3 ref={articleHeading} tabindex="-1" class="rounded-sm text-2xl font-semibold tracking-tight text-primary focus-ui">
                      {topic().title}
                    </h3>
                    <Show when={topic().description}>
                      {(description) => <p class="mt-1.5 text-sm leading-relaxed text-dimmed">{description()}</p>}
                    </Show>
                  </div>
                  <Show when={topic().kind === "document" && payload()}>
                    <Button
                      size="sm"
                      variant="secondary"
                      class="col-start-2 shrink-0 justify-self-start sm:col-start-3 sm:row-start-1 sm:justify-self-auto"
                      onClick={() => void copyArticle(topic(), payload())}
                    >
                      <i class={articleClipboard.wasCopied() ? "ti ti-check" : "ti ti-markdown"} />
                      {articleClipboard.wasCopied() ? t().copied : t().copyMarkdown}
                    </Button>
                  </Show>
                </header>
              </Show>
              <Show when={topic().kind === "content"}>{legacyTopicContent(topic())}</Show>
              <Show when={topic().kind === "document"}>
                <Show when={loading()}>
                  <Placeholder state="loading" variant="panel" title={t().loading} />
                </Show>
                <Show when={loadError()}>
                  {(message) => (
                    <NoticeCard tone="danger" icon={false}>
                      <p class="font-medium">{t().loadFailed}</p>
                      <p class="mt-1 text-sm">{message()}</p>
                      <Button size="sm" variant="secondary" class="mt-3" onClick={() => setLoadAttempt((value) => value + 1)}>
                        {t().tryAgain}
                      </Button>
                    </NoticeCard>
                  )}
                </Show>
                <Show when={payload()}>
                  {(document) => (
                    <div class="help-article-layout">
                      <Show when={articleSections().length > 0}>
                        <nav class="help-article-toc" aria-label={t().onThisPage}>
                          <p class="help-article-toc-label">{t().onThisPage}</p>
                          <ol>
                            <For each={articleSections()}>
                              {(section) => (
                                <li>
                                  <button
                                    type="button"
                                    aria-current={activeSectionId() === section.id ? "location" : undefined}
                                    title={section.title}
                                    onClick={() => openArticleSection(section)}
                                  >
                                    <span class="help-article-toc-icon" aria-hidden="true">
                                      <i class={section.icon} />
                                    </span>
                                    <span class="help-article-toc-title">{section.title}</span>
                                  </button>
                                </li>
                              )}
                            </For>
                          </ol>
                        </nav>
                      </Show>
                      <div class="help-article-copy">
                        <div ref={articleContent}>
                          <MarkdownView trustedHtml={document().html} class="help-document" />
                        </div>
                        <TopicNavigation />
                      </div>
                    </div>
                  )}
                </Show>
              </Show>
            </article>
          )}
        </Show>
        <span class="sr-only" aria-live="polite">
          {articleClipboard.wasCopied() ? t().articleCopiedAnnouncement : allHelpClipboard.wasCopied() ? t().allCopiedAnnouncement : ""}
        </span>
      </ScrollArea>
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
      searchHelpApps={[]}
      documents={props.documents}
      includeShortcuts={props.includeShortcuts}
      accent={props.accent}
      surface={props.embedded ? "embedded" : "page"}
      pageBase={props.pageBase}
      syncPageUrl={!props.embedded && !!props.pageBase}
    />
  );
}

export function openLayoutHelpDialog(searchHelpApps: GlobalSearchHelpApp[] = [], accent?: string) {
  const session = createSession();
  void prompts.dialog<void>(
    (close) => (
      <HelpShell
        session={session}
        close={close}
        searchHelpApps={searchHelpApps}
        accent={accent}
        surface="modal"
        pageBase={window.__cloudLayoutHelpPageBase}
      />
    ),
    { surface: "bare", header: false, size: "wide" },
  );
}
