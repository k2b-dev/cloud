import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import { formatShortcut, type KeyboardPlatform, prefersReducedMotion, useLocale } from "@k2b/ui";
import {
  Bar,
  Canvas,
  Empty,
  Facts,
  Failed,
  Group,
  Input,
  Loading,
  Menu,
  type MenuEntry,
  Notice,
  Pane,
  Row,
  Section,
  Text,
  useToast,
  Workspace,
} from "@k2b/ui/v2";
import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, onMount, Show, untrack } from "solid-js";
import type { HelpDocumentManifest, HelpDocumentPayload } from "../../shared/help";
import type { LayoutHelpArticle } from "../help";
import { helpMessages } from "../help-messages";
import { helpArticleParts } from "../layout-help-article";
import { formatHelpBundleMarkdown, formatHelpDocumentMarkdown } from "../layout-help-markdown";
import { loadPanelDocument } from "../layout-help-panel-document";
import { searchHelpTopics } from "../layout-help-search";
import { type HelpShortcutCommand, type HelpShortcutScope, helpShortcutGroups, helpStart } from "../layout-help-start";
import { helpLinkTarget, layoutHelpTopicHref } from "../layout-help-url";

/**
 * A part of the start that the host adds after the articles, as data, so it renders in the same island: Core's
 * generated Code reference of the app, for example. Its groups fold, so the start stays short.
 */
export type HelpStartSection = {
  id: string;
  /** A Tabler icon name without `ti-`. */
  icon: string;
  title: string;
  summary?: string;
  /** One line to read and copy, such as an import. */
  code?: { label: string; value: string };
  groups?: {
    title: string;
    rows: { title: string; text?: string; meta?: string; state?: { label: string; tone?: "ok" | "warn" | "bad" } }[];
  }[];
  /** Says why the section has nothing. */
  empty?: string;
  /** Reading the section failed; the action reloads it. */
  failed?: { text: string; action: { label: string; href: string } };
};

export type HelpReaderProps = {
  /** `panel`: the side panel's provider page; the open article lives in `?topic=`. `page`: the app's Help route. */
  surface: "panel" | "page";
  documents: readonly HelpDocumentManifest[];
  app?: { id: string; name: string; icon?: string };
  /** Ids of "For this view", filtered by the server. */
  view?: readonly string[];
  initialTopic?: string;
  /** Authorized article and server-parsed parts for an identical first frame. */
  initialArticle?: LayoutHelpArticle;
  /** The app's full-page Help route. */
  pageBase?: string;
  platform?: KeyboardPlatform;
  state?: "failed" | "unavailable";
  sections?: readonly HelpStartSection[];
  /** Shortcuts of the page beside this reader; without, the start shows none. */
  shortcuts?: { seed: HelpShortcutCommand[]; read: () => HelpShortcutCommand[]; subscribe: (update: () => void) => () => void };
  /** Live "For this view" ids of the page beside the panel. */
  viewSource?: { subscribe: (update: (ids: readonly string[]) => void) => () => void };
};

type Topic = HelpDocumentManifest;

const iconName = (icon?: string) => icon?.replace(/^ti\s+/, "").replace(/^ti-/, "") || "file-text";
const byOrder = (a: Topic, b: Topic) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title);

/**
 * The Help reader on v2: the start (articles for this view, tasks, kinds, the host's sections, shortcuts) and search
 * results as the list, the open article as the detail beside it. The open article is in the address, so reload, back
 * and forward show the same article; links within the app's Help open in place.
 */
export function HelpReader(props: HelpReaderProps) {
  const locale = useLocale();
  const t = () => helpMessages.resolve([locale()]).t;
  const toast = useToast();
  const topics = createMemo(() => [...props.documents].sort(byOrder));
  const [viewIds, setViewIds] = createSignal<readonly string[]>(props.view ?? []);
  const start = createMemo(() => helpStart(topics(), viewIds()));
  const initial = props.initialTopic && topics().some((topic) => topic.id === props.initialTopic) ? props.initialTopic : null;
  const [activeId, setActiveId] = createSignal<string | null>(initial);
  const [query, setQuery] = createSignal("");
  const [remoteIds, setRemoteIds] = createSignal<readonly string[] | null>(null);
  const [searching, setSearching] = createSignal(false);
  const [searchFailed, setSearchFailed] = createSignal(false);
  const [searchAttempt, setSearchAttempt] = createSignal(0);
  const cache = new Map<string, HelpDocumentPayload>();
  const [cacheVersion, setCacheVersion] = createSignal(0);
  const store = {
    cache,
    storeDocument: (topic: Topic, payload: HelpDocumentPayload) => {
      cache.set(`${topic.locale ?? "en"}:${topic.url}`, payload);
      setCacheVersion((value) => value + 1);
    },
  };
  // The server's article travels once as parts; the cache keeps its payload without HTML, the parts render it.
  const seeded = props.initialArticle?.payload.id === initial ? props.initialArticle : undefined;
  const initialTopic = topics().find((topic) => topic.id === initial);
  if (seeded && initialTopic) cache.set(`${initialTopic.locale ?? "en"}:${initialTopic.url}`, { ...seeded.payload, html: "" });
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [loadAttempt, setLoadAttempt] = createSignal(0);
  const [copyingAll, setCopyingAll] = createSignal(false);
  const [openGroups, setOpenGroups] = createSignal<ReadonlySet<string>>(new Set());
  const [commands, setCommands] = createSignal<HelpShortcutCommand[]>(props.shortcuts?.seed ?? []);
  let articleBody: HTMLDivElement | undefined;
  let pendingHash = "";

  const activeTopic = createMemo(() => topics().find((topic) => topic.id === activeId()) ?? null);
  const payload = createMemo(() => {
    cacheVersion();
    const topic = activeTopic();
    return topic ? cache.get(`${topic.locale ?? "en"}:${topic.url}`) : undefined;
  });
  const parts = createMemo(() => {
    const document = payload();
    if (!document) return null;
    if (seeded && document.id === seeded.payload.id && !document.html) return seeded.parts;
    return document.html ? helpArticleParts(document.html) : null;
  });
  const normalizedQuery = createMemo(() => query().trim().toLocaleLowerCase());
  const results = createMemo(() => (normalizedQuery() ? searchHelpTopics(topics(), normalizedQuery(), remoteIds()) : []));

  // The address names the open article: `?topic=` in the panel, the app's Help route on the page.
  const hubHref = () => (props.surface === "page" && props.pageBase ? layoutHelpTopicHref(props.pageBase, null) : "?");
  const topicHref = (id: string) =>
    props.surface === "page" && props.pageBase ? layoutHelpTopicHref(props.pageBase, id) : `?topic=${encodeURIComponent(id)}`;
  const readAddress = (): { id: string | null; hash: string } => {
    const hash = decodeURIComponent(location.hash.slice(1));
    if (props.surface === "panel") {
      const id = new URLSearchParams(location.search).get("topic");
      return { id: id && topics().some((topic) => topic.id === id) ? id : null, hash };
    }
    const target = helpLinkTarget(`${location.pathname}${location.hash}`, location.href, {
      appId: props.app?.id,
      pageBase: props.pageBase,
    });
    const id = target?.kind === "topic" ? target.topicId : null;
    return { id: id && topics().some((topic) => topic.id === id) ? id : null, hash };
  };
  const open = (id: string | null, hash = "", push = true) => {
    if (push) {
      const url = new URL(id ? topicHref(id) : hubHref(), location.href);
      // The panel keeps the rest of its address (its context), and only the open article changes.
      if (props.surface === "panel") {
        const next = new URL(location.href);
        if (id) next.searchParams.set("topic", id);
        else next.searchParams.delete("topic");
        next.hash = hash ? encodeURIComponent(hash) : "";
        history.pushState(history.state, "", next);
      } else {
        url.hash = hash ? encodeURIComponent(hash) : "";
        history.pushState(history.state, "", url);
      }
    }
    if (id === activeId() && id && hash) return void scrollToHash(hash);
    pendingHash = hash;
    setActiveId(id);
  };
  const scrollToHash = (hash: string) => {
    const heading = [...(articleBody?.querySelectorAll<HTMLElement>("h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]") ?? [])].find(
      (element) => element.id === hash,
    );
    if (!heading) return false;
    // A link to a heading in collapsed details opens them first.
    for (let details = heading.closest("details"); details; details = details.parentElement?.closest("details") ?? null)
      details.open = true;
    heading.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    return true;
  };

  onMount(() => {
    const onPop = () => {
      const address = readAddress();
      pendingHash = address.hash;
      setActiveId(address.id);
    };
    window.addEventListener("popstate", onPop);
    onCleanup(() => window.removeEventListener("popstate", onPop));
    pendingHash = readAddress().hash;
    if (props.shortcuts) {
      const shortcuts = props.shortcuts;
      const update = () => setCommands(shortcuts.read());
      onCleanup(shortcuts.subscribe(update));
      update();
    }
    if (props.viewSource) onCleanup(props.viewSource.subscribe(setViewIds));
  });

  // The open article's document: from the cache, else from the Help API.
  createEffect(() => {
    loadAttempt();
    const topic = activeTopic();
    setLoadError(null);
    if (!topic || untrack(payload)) return;
    const controller = new AbortController();
    void loadPanelDocument(store, topic, controller.signal, t()).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setLoadError(error instanceof Error ? error.message : t().loadFallback);
    });
    onCleanup(() => controller.abort());
  });
  // Once the body is in the document: open the requested section.
  createEffect(() => {
    if (!parts()) return;
    const hash = pendingHash;
    if (!hash) return;
    const frame = requestAnimationFrame(() => {
      pendingHash = "";
      scrollToHash(hash);
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });

  // Full-text search through each app's search endpoint, after a short pause; titles match at once.
  createEffect(() => {
    const value = normalizedQuery();
    searchAttempt();
    setRemoteIds(null);
    setSearching(false);
    setSearchFailed(false);
    const urls = [...new Set(topics().map((topic) => topic.searchUrl))];
    if (!value || urls.length === 0) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      void Promise.all(
        urls.map(async (url) => {
          const response = await fetch(`${url}?q=${encodeURIComponent(value)}`, {
            signal: controller.signal,
            headers: { Accept: "application/json" },
          });
          if (!response.ok) throw new Error(t().searchFailed);
          const body: unknown = await response.json();
          return body && typeof body === "object" && "ids" in body && Array.isArray(body.ids)
            ? body.ids.filter((id): id is string => typeof id === "string")
            : [];
        }),
      )
        .then((groups) => setRemoteIds([...new Set(groups.flat())]))
        .catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === "AbortError")) setSearchFailed(true);
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 120);
    onCleanup(() => {
      clearTimeout(timer);
      controller.abort();
    });
  });

  const copyArticle = async () => {
    const topic = activeTopic();
    const document = payload();
    if (!topic || !document) return;
    try {
      await navigator.clipboard.writeText(formatHelpDocumentMarkdown({ ...topic, markdown: document.markdown }));
      toast(t().articleCopied, { status: "ok" });
    } catch (error) {
      toast(t().copyFailed({ message: error instanceof Error ? error.message : t().copyFallback }), {
        status: "bad",
        retry: () => void copyArticle(),
      });
    }
  };
  const copyAll = async () => {
    if (copyingAll() || topics().length === 0) return;
    setCopyingAll(true);
    const controller = new AbortController();
    try {
      const documents = await Promise.all(
        topics().map(async (topic) => ({ ...topic, markdown: (await loadPanelDocument(store, topic, controller.signal, t())).markdown })),
      );
      await navigator.clipboard.writeText(formatHelpBundleMarkdown(documents));
      toast(t().helpCopied, { status: "ok" });
    } catch (error) {
      toast(t().copyAllFailed({ message: error instanceof Error ? error.message : t().copyFallback }), {
        status: "bad",
        retry: () => void copyAll(),
      });
    } finally {
      setCopyingAll(false);
    }
  };
  const menu = (): MenuEntry[] => [
    {
      label: t().copyAsMarkdown,
      icon: "markdown",
      disabled: copyingAll() || (activeTopic() ? !payload() : topics().length === 0),
      onClick: () => (activeTopic() ? copyArticle() : copyAll()),
    },
    ...(props.surface === "panel" && props.pageBase
      ? [{ label: t().openAsPage, icon: "app-window", href: layoutHelpTopicHref(props.pageBase, activeId()) }]
      : []),
  ];

  /** Links in the article open Help targets of this app in place. */
  const followLink = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest("a") : null;
    if (!anchor || (anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
    const target = helpLinkTarget(anchor.getAttribute("href") ?? "", location.href, { appId: props.app?.id, pageBase: props.pageBase });
    if (!target) return;
    if (target.kind === "section") {
      if (scrollToHash(target.hash)) event.preventDefault();
    } else if (target.topicId === null || topics().some((topic) => topic.id === target.topicId)) {
      event.preventDefault();
      open(target.topicId, target.hash);
    }
  };
  /** A link to a Help article of this app opens in place; others are ordinary links. */
  const inPlace = (href: string) => (event: LinkNavigateEvent) => {
    const target = helpLinkTarget(href, location.href, { appId: props.app?.id, pageBase: props.pageBase });
    if (target?.kind !== "topic" || (target.topicId !== null && !topics().some((topic) => topic.id === target.topicId)))
      return event.fallback();
    open(target.topicId, target.hash);
  };

  const topicRow = (topic: Topic) => (
    <Row
      icon={iconName(topic.icon)}
      lines={topic.description ? [topic.title, topic.description] : [topic.title]}
      href={topicHref(topic.id)}
      onNavigate={() => open(topic.id)}
      current={topic.id === activeId()}
    />
  );
  const shortcutLabel = (scope: HelpShortcutScope) =>
    scope === "everywhere"
      ? t().shortcutsEverywhere
      : scope === "selection"
        ? t().shortcutsWithSelection
        : props.app?.name
          ? t().shortcutsInApp({ app: props.app.name })
          : t().shortcutsInThisApp;
  const groupTitle = (kind: "start" | "reference" | "troubleshoot") =>
    ({ start: t().groupStart, reference: t().groupReference, troubleshoot: t().groupTroubleshoot })[kind];
  const groupIcon = { start: "rocket", reference: "book-2", troubleshoot: "lifebuoy" } as const;
  const toggleGroup = (key: string) =>
    setOpenGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const accessLabel = (level: NonNullable<HelpDocumentPayload["needs"]>) =>
    ({ view: t().accessView, edit: t().accessEdit, manage: t().accessManage })[level];

  const startView = (): JSX.Element => (
    <>
      <Show when={start().view.length > 0}>
        <Section icon="focus-2" title={t().forThisView}>
          <For each={start().view}>{topicRow}</For>
        </Section>
      </Show>
      <Show when={start().tiles.length > 0}>
        <Section icon="checklist" title={t().whatToDo} count={start().tiles.length + start().moreTasks.length}>
          <For each={[...start().tiles, ...start().moreTasks]}>{topicRow}</For>
        </Section>
      </Show>
      <For each={start().groups}>
        {(group) => (
          <Section icon={groupIcon[group.kind]} title={groupTitle(group.kind)} count={group.topics.length}>
            <For each={group.topics}>{topicRow}</For>
          </Section>
        )}
      </For>
      <Show when={topics().length === 0}>
        <Show when={props.state === "failed"} fallback={<Empty icon="book-off" text={`${t().noArticles}. ${t().noArticlesDetail}`} />}>
          <Failed text={`${t().helpUnavailable}. ${t().helpUnavailableDetail}`} onRetry={() => location.reload()} />
        </Show>
      </Show>
      <For each={props.sections ?? []}>
        {(section) => (
          <Section icon={section.icon} title={section.title} summary={section.summary}>
            <Show when={section.failed}>
              {(failed) => (
                <Notice tone="bad" actions={[{ label: failed().action.label, href: failed().action.href }]}>
                  {failed().text}
                </Notice>
              )}
            </Show>
            <Show when={section.empty}>{(empty) => <Text muted>{empty()}</Text>}</Show>
            <Show when={section.code}>
              {(code) => <Facts items={[{ label: code().label, value: code().value, mono: true, copy: code().value }]} />}
            </Show>
            <For each={section.groups ?? []}>
              {(group) => {
                const key = `${section.id}:${group.title}`;
                const shown = () => openGroups().has(key);
                // k2b-ui gap: a folded Group has no toggle of its own; its one action opens and closes it.
                return (
                  <Group
                    title={group.title}
                    count={group.rows.length}
                    folded={!shown()}
                    actions={[{ label: shown() ? t().hide : t().show, onClick: () => toggleGroup(key) }]}
                  >
                    <For each={group.rows}>
                      {(row) => (
                        <Row
                          lines={row.text ? [row.title, row.text] : [row.title]}
                          meta={row.meta}
                          end={
                            row.state ? (
                              <Text type="meta" tone={row.state.tone}>
                                {row.state.label}
                              </Text>
                            ) : undefined
                          }
                        />
                      )}
                    </For>
                  </Group>
                );
              }}
            </For>
          </Section>
        )}
      </For>
      <For each={helpShortcutGroups(commands())}>
        {(group) => (
          <Section icon="keyboard" title={shortcutLabel(group.scope)}>
            {/* k2b-ui gap: v2 has no key caps; the keys are words in the platform's notation. */}
            <Facts
              items={group.shortcuts.map((command) => ({
                label: command.title,
                value: formatShortcut(command.shortcut, { platform: props.platform, locale: locale() }).label,
                hint: command.description,
              }))}
            />
          </Section>
        )}
      </For>
    </>
  );

  const resultsView = (): JSX.Element => (
    <Section title={t().results({ count: results().length })}>
      <Show when={searchFailed()}>
        <Notice
          tone="warn"
          title={t().titlesOnly}
          actions={[{ label: t().tryAgain, onClick: () => setSearchAttempt((value) => value + 1) }]}
        >
          {t().searchTitlesOnly}
        </Notice>
      </Show>
      <Show when={results().length > 0} fallback={<Show when={!searching()}>{<Empty icon="search-off" text={t().noResults} />}</Show>}>
        <For each={results()}>{topicRow}</For>
      </Show>
    </Section>
  );

  const article = (topic: Topic): JSX.Element => (
    <Pane
      detail
      label={topic.title}
      scrollKey="help-article"
      back={{ label: t().help, href: hubHref(), onNavigate: () => open(null) }}
      head={
        <Bar
          start={<Text weight="strong">{topic.title}</Text>}
          end={
            <Show when={(parts()?.sections.length ?? 0) > 0}>
              <Menu
                label={t().onThisPage}
                icon="list"
                variant="ghost"
                items={(parts()?.sections ?? []).map((section) => ({ label: section.label, onClick: () => void scrollToHash(section.id) }))}
              />
            </Show>
          }
        />
      }
    >
      <Show when={parts()?.lead === undefined && topic.description && parts()}>
        <Text type="body">{topic.description}</Text>
      </Show>
      <Show when={payload()?.needs || parts()?.steps}>
        <Facts
          inline
          items={[
            ...(payload()?.needs ? [{ label: t().youNeed, value: accessLabel(payload()!.needs!) }] : []),
            ...(parts()?.steps ? [{ label: t().articleFacts, value: t().steps({ count: parts()!.steps }) }] : []),
          ]}
        />
      </Show>
      <Show when={loadError()}>
        {(message) => <Failed text={`${t().loadFailed}. ${message()}`} onRetry={() => setLoadAttempt((value) => value + 1)} />}
      </Show>
      <Show when={!parts() && !loadError()}>
        <Loading rows={6} lines={1} />
      </Show>
      <Show when={parts()}>
        {(content) => (
          // The article is trusted Help HTML with its own reading styles (steps, callouts, tables); it keeps its renderer.
          <Canvas label={topic.title}>
            {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: delegated link clicks; the links stay links. */}
            <div ref={articleBody} onClick={followLink}>
              <Show when={content().lead}>
                {(lead) => <div class="k2b-content-markdown help-document help-article-lead" innerHTML={lead()} />}
              </Show>
              <div class="k2b-content-markdown help-document" innerHTML={content().body} />
            </div>
          </Canvas>
        )}
      </Show>
      <Show when={payload()?.next}>
        {(next) => (
          <Section title={t().next}>
            <Row
              icon={iconName(next().icon)}
              lines={next().description ? [next().title, next().description!] : [next().title]}
              href={next().url}
              onNavigate={inPlace(next().url)}
            />
          </Section>
        )}
      </Show>
      <Show when={(payload()?.related.length ?? 0) > 0}>
        <Section title={t().related} count={payload()?.related.length}>
          <For each={payload()?.related}>
            {(link) => (
              <Row
                icon={iconName(link.icon)}
                lines={link.description ? [link.title, link.description] : [link.title]}
                meta={link.appId !== props.app?.id ? link.appName : undefined}
                href={link.url}
                onNavigate={inPlace(link.url)}
              />
            )}
          </For>
        </Section>
      </Show>
    </Pane>
  );

  const title = () => (props.app?.name ? t().helpFor({ app: props.app.name }) : t().help);
  return (
    <Workspace
      detail
      detailEmpty={{ icon: "book-2", text: t().chooseArticle }}
      head={
        <Bar
          start={<Text weight="strong">{title()}</Text>}
          end={
            // Help the reader may not see offers nothing to search or copy.
            <Show when={props.state !== "unavailable"}>
              <Input
                type="search"
                icon="search"
                label={t().searchHelp}
                placeholder={t().searchPlaceholder}
                value={query()}
                onInput={setQuery}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && query()) {
                    event.preventDefault();
                    setQuery("");
                  }
                }}
              />
              <Menu label={t().moreActions} items={menu()} />
            </Show>
          }
        />
      }
    >
      <Show
        when={props.state !== "unavailable"}
        fallback={<Pane label={title()}>{<Empty icon="book-off" text={`${t().helpNotAvailable}. ${t().helpNotAvailableDetail}`} />}</Pane>}
      >
        <Pane.Split>
          <Pane label={title()} width={{ min: 280, default: 360 }} scrollKey="help-start">
            <Show when={normalizedQuery()} fallback={startView()}>
              {resultsView()}
            </Show>
          </Pane>
          <Show when={activeTopic()}>{(topic) => article(topic())}</Show>
        </Pane.Split>
      </Show>
    </Workspace>
  );
}
