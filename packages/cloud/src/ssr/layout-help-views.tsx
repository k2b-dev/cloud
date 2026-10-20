import type { HelpAccessLevel, HelpArticleLink, HelpDocumentPayload } from "@k2b/cloud/shared";
import { Button, IconButton, Kbd, type KeyboardPlatform, NoticeCard, Placeholder, TextInput, useLocale } from "@k2b/ui";
import { For, type JSX, Show } from "solid-js";
import { appAccentStyle } from "./app-appearance";
import { helpMessages } from "./help-messages";
import type { HelpArticleParts } from "./layout-help-article";
import type { HelpTopic } from "./layout-help-registry";
import type { HelpShortcutScope, HelpStart, HelpStartGroupKind, helpShortcutGroups } from "./layout-help-start";

/**
 * The Help reader's markup. Each view takes data and callbacks only, so the same view renders on the server and in the
 * browser; state, effects, requests, the clipboard, and heavy controls stay with the reader that composes them.
 */

export type HelpSurface = "modal" | "page" | "embedded";

const useHelpMessages = () => {
  const locale = useLocale();
  return () => helpMessages.resolve([locale()]).t;
};

/** An article without its own icon gets a neutral page tile. */
const helpIconClass = (icon?: string) => (icon?.startsWith("ti ") ? icon : `ti ${icon ?? "ti-file-text"}`);
const GROUP_ICONS: Record<HelpStartGroupKind, string> = {
  start: "ti ti-rocket",
  reference: "ti ti-book-2",
  troubleshoot: "ti ti-lifebuoy",
};

/**
 * One head in every view: the search never moves between the start, an article, and results. An app's embedded reader
 * sits in the app's own chrome, which names it and picks its article, so it keeps only the search of its start.
 */
export function HelpHead(props: {
  /** The row with the tile, the title, and the actions; the embedded reader has none. */
  row: boolean;
  /** In an article, the back button takes the app tile's place. */
  back: boolean;
  /** A provider can mount only the interactive lead. */
  lead?: JSX.Element;
  tile: string;
  title: string;
  /** The ⋯ menu. */
  menu: JSX.Element;
  closable: boolean;
  onBack: () => void;
  onClose: () => void;
  query: string;
  onQuery: (value: string) => void;
  searchRef: (element: HTMLInputElement) => void;
}) {
  const t = useHelpMessages();
  return (
    <header class="help-head" data-help-head="">
      <div class="help-head-inner help-measure">
        <Show when={props.row}>
          <div class="help-head-row">
            {/* The back button takes the app tile's place in an article, so nothing beside it moves. */}
            {props.lead ?? (
              <Show
                when={props.back}
                fallback={
                  <span class="help-head-tile" aria-hidden="true">
                    <i class={props.tile} />
                  </span>
                }
              >
                <IconButton class="help-head-back" label={t().backToTopics} title={t().back} onClick={props.onBack}>
                  <i class="ti ti-arrow-left" />
                </IconButton>
              </Show>
            )}
            <h2 id="layout-help-title" class="help-head-title">
              {props.title}
            </h2>
            <div class="help-head-actions" role="group" aria-label={t().actions}>
              {props.menu}
              <Show when={props.closable}>
                <IconButton label={t().closeHelp} title={t().close} onClick={props.onClose}>
                  <i class="ti ti-x" />
                </IconButton>
              </Show>
            </div>
          </div>
        </Show>
        <TextInput
          ref={props.searchRef}
          type="search"
          class="help-head-search"
          icon="ti ti-search"
          aria-label={t().searchHelp}
          data-help-search=""
          value={props.query}
          placeholder={t().searchPlaceholder}
          onValueChange={props.onQuery}
        />
      </div>
    </header>
  );
}

/** Rows: icon tile, title, and description; the start's groups, its further tasks, and search results use them. */
function HelpTopicRows(props: { items: readonly HelpTopic[]; marker?: string; onOpen: (id: string) => void }) {
  return (
    <ul class="help-start-rows" {...(props.marker ? { [props.marker]: "" } : {})}>
      <For each={props.items}>
        {(topic) => (
          <li>
            <button type="button" class="help-start-row focus-ui" data-help-topic={topic.id} onClick={() => props.onOpen(topic.id)}>
              <span class="help-topic-icon k2b-icon-tile help-start-row-icon app-accent-text" aria-hidden="true">
                <i class={helpIconClass(topic.icon)} />
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
}

/** At most eight tasks as tiles; the app colour shows only in the icon. */
function HelpTaskTiles(props: { items: readonly HelpTopic[]; onOpen: (id: string) => void }) {
  return (
    <ul class="help-start-tiles" data-help-tiles="">
      <For each={props.items}>
        {(topic) => (
          <li>
            <button type="button" class="help-start-tile focus-ui" data-help-topic={topic.id} onClick={() => props.onOpen(topic.id)}>
              <span class="help-topic-icon k2b-icon-tile help-start-tile-icon app-accent-text" aria-hidden="true">
                <i class={helpIconClass(topic.icon)} />
              </span>
              <span class="help-start-tile-title">{topic.title}</span>
              <Show when={topic.description}>{(description) => <span class="help-start-tile-description">{description()}</span>}</Show>
            </button>
          </li>
        )}
      </For>
    </ul>
  );
}

export function HelpViewSection(props: { items: readonly HelpTopic[]; onOpen: (id: string) => void }) {
  const t = useHelpMessages();
  return (
    <Show when={props.items.length > 0}>
      <section class="help-start-section" data-help-view="" aria-labelledby="help-start-view-title">
        <h3 id="help-start-view-title" class="help-start-heading">
          <i class="ti ti-focus-2" aria-hidden="true" />
          {t().forThisView}
        </h3>
        <HelpTopicRows items={props.items} onOpen={props.onOpen} />
      </section>
    </Show>
  );
}

/** The start: For this view, What to do, the kind groups, and the shortcuts last. */
export function HelpStartView(props: {
  start: HelpStart<HelpTopic>;
  /** The app has no Help articles. */
  empty: boolean;
  /** Reading the app's Help failed. */
  failed: boolean;
  onOpen: (id: string) => void;
  onReload: () => void;
  shortcuts?: JSX.Element;
}) {
  const t = useHelpMessages();
  const groupTitle = (kind: HelpStartGroupKind) =>
    ({ start: t().groupStart, reference: t().groupReference, troubleshoot: t().groupTroubleshoot })[kind];
  return (
    <>
      <HelpViewSection items={props.start.view} onOpen={props.onOpen} />
      <Show when={props.start.tiles.length > 0}>
        <section class="help-start-section" data-help-tasks="" aria-labelledby="help-start-tasks-title">
          <h3 id="help-start-tasks-title" class="help-start-heading">
            <i class="ti ti-checklist" aria-hidden="true" />
            {t().whatToDo}
          </h3>
          <HelpTaskTiles items={props.start.tiles} onOpen={props.onOpen} />
          <Show when={props.start.moreTasks.length > 0}>
            <HelpTopicRows items={props.start.moreTasks} marker="data-help-more-tasks" onOpen={props.onOpen} />
          </Show>
        </section>
      </Show>
      <Show when={props.start.groups.length > 0}>
        <div class="help-start-groups">
          <For each={props.start.groups}>
            {(group) => (
              <section class="help-start-section" data-help-group={group.kind} aria-labelledby={`help-start-${group.kind}-title`}>
                <h3 id={`help-start-${group.kind}-title`} class="help-start-heading">
                  <i class={GROUP_ICONS[group.kind]} aria-hidden="true" />
                  {groupTitle(group.kind)}
                </h3>
                <HelpTopicRows items={group.topics} onOpen={props.onOpen} />
              </section>
            )}
          </For>
        </div>
      </Show>
      {/* An app without Help says so plainly; only a failed read of its Help offers a way to try again. */}
      <Show when={props.empty}>
        <Show
          when={props.failed}
          fallback={<Placeholder icon="ti ti-book-off" title={t().noArticles} description={t().noArticlesDetail} />}
        >
          <NoticeCard tone="danger" title={t().helpUnavailable} detail={t().helpUnavailableDetail} data-help-unavailable="">
            <Button size="sm" variant="secondary" onClick={() => props.onReload()}>
              {t().reload}
            </Button>
          </NoticeCard>
        </Show>
      </Show>
      {props.shortcuts}
    </>
  );
}

/**
 * Keyboard shortcuts come last in the start. The groups reserve their height and place in CSS, so the ones the browser
 * adds fill space that is already there.
 */
export function HelpShortcutsView(props: { groups: ReturnType<typeof helpShortcutGroups>; appName?: string; platform?: KeyboardPlatform }) {
  const t = useHelpMessages();
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
        <For each={props.groups}>
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
                      <Kbd keys={command.shortcut} platform={props.platform} />
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
}

/** Search results replace the start below the field. The count takes the place of the first heading, so the first row stays where it was. */
export function HelpResultsView(props: {
  results: readonly HelpTopic[];
  searching: boolean;
  /** Full-text search failed; the results match titles only. */
  failed: boolean;
  onRetry: () => void;
  onOpen: (id: string) => void;
}) {
  const t = useHelpMessages();
  return (
    <section class="help-start-section" data-help-search-results="">
      {/* A failed full-text search says so in the same line, with a way to try again; the results do not move. */}
      <div class="help-start-status">
        <span aria-live="polite">{t().results({ count: props.results.length })}</span>
        <Show when={props.searching}>
          <i class="ti ti-loader-2 animate-spin" aria-hidden="true" />
        </Show>
        <Show when={props.failed}>
          <span class="help-start-status-warning" data-help-search-failed="" title={t().searchTitlesOnly} role="status">
            <i class="ti ti-alert-triangle" aria-hidden="true" />
            <span aria-hidden="true">{t().titlesOnly}</span>
            <span class="sr-only">{t().searchTitlesOnly}</span>
          </span>
          <Button size="xs" variant="ghost" class="help-start-status-retry" onClick={() => props.onRetry()}>
            {t().tryAgain}
          </Button>
        </Show>
      </div>
      <Show
        when={props.results.length > 0}
        fallback={
          <Show when={!props.searching}>
            <Placeholder icon="ti ti-search-off" title={t().noResults} />
          </Show>
        }
      >
        <HelpTopicRows items={props.results} onOpen={props.onOpen} />
      </Show>
    </section>
  );
}

/** Help the reader may not see. */
export function HelpNotAvailableView() {
  const t = useHelpMessages();
  return <Placeholder icon="ti ti-book-off" title={t().helpNotAvailable} description={t().helpNotAvailableDetail} />;
}

const ArticleLinkTitle = (props: { link: HelpArticleLink }) => (
  <span class="help-article-link-copy">
    <span class="help-article-link-title">{props.link.title}</span>
    <Show when={props.link.description}>{(description) => <span class="help-article-link-description">{description()}</span>}</Show>
  </span>
);

/** "Next" leads on; related articles keep their own app's colour, and another app says whose article it is. */
const ArticleEnd = (props: { document: HelpDocumentPayload; appId?: string }) => {
  const t = useHelpMessages();
  return (
    <Show when={props.document.next || props.document.related.length > 0}>
      <footer class="help-article-end">
        <Show when={props.document.next}>
          {(next) => (
            <a class="help-article-next app-accent-scope focus-ui" href={next().url} style={appAccentStyle(next().accent)}>
              <span class="help-article-next-label">{t().next}</span>
              <span class="help-article-next-row">
                <i class={`${helpIconClass(next().icon)} help-article-next-icon`} aria-hidden="true" />
                <ArticleLinkTitle link={next()} />
                <i class="ti ti-arrow-right help-article-next-arrow" aria-hidden="true" />
              </span>
            </a>
          )}
        </Show>
        <Show when={props.document.related.length > 0}>
          <section class="help-article-related" aria-labelledby="help-article-related-title">
            <h4 id="help-article-related-title">{t().related}</h4>
            <ul>
              <For each={props.document.related}>
                {(link) => (
                  <li>
                    <a class="help-article-related-link app-accent-scope focus-ui" href={link.url} style={appAccentStyle(link.accent)}>
                      <span class="help-topic-icon k2b-icon-tile help-article-related-icon app-accent-text" aria-hidden="true">
                        <i class={helpIconClass(link.icon)} />
                      </span>
                      <ArticleLinkTitle link={link} />
                      <Show when={link.appId !== props.appId}>
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
};

/** The inside of an article: its head, the status of its document, the body, its end, and the aside. */
export function HelpArticleView(props: {
  surface: HelpSurface | "panel";
  topic: HelpTopic;
  appName?: string;
  appId?: string;
  /** The article's lead, body, sections, and step count; `null` while its document loads. */
  parts: HelpArticleParts | null;
  document: HelpDocumentPayload | null;
  /** Renders trusted article HTML. */
  Markdown: (props: { trustedHtml: string; class: string }) => JSX.Element;
  showTools: boolean;
  /** The article's tools under its facts: the "On this page" menu and the copy button. */
  sectionMenu: JSX.Element;
  copyButton: JSX.Element;
  /** The article's document loads or failed to load; both sit between the article's head and its body. */
  loading: JSX.Element;
  failure: JSX.Element;
  /** The sticky aside beside the article: its table of contents and the copy action. */
  toc: JSX.Element;
  copyAction: JSX.Element;
  headingRef: (element: HTMLHeadingElement) => void;
  contentRef: (element: HTMLDivElement) => void;
  onBack: () => void;
}) {
  const t = useHelpMessages();
  const accessLabel = (level: HelpAccessLevel) => ({ view: t().accessView, edit: t().accessEdit, manage: t().accessManage })[level];
  return (
    <div class="help-article-layout">
      <div class="help-article-main">
        <header class="help-article-head" data-help-article-head="">
          <div class="help-article-head-copy">
            {/* In the panel, its head already names the app and leads back to the start. */}
            <Show when={props.surface !== "panel"}>
              <p class="help-article-path">
                <Show when={props.appName}>
                  {(name) => (
                    <>
                      <span class="app-accent-text">{name()}</span>
                      <i class="ti ti-chevron-right" aria-hidden="true" />
                    </>
                  )}
                </Show>
                <button type="button" class="help-article-path-link focus-ui" onClick={props.onBack}>
                  {t().help}
                </button>
              </p>
            </Show>
            <h3 ref={props.headingRef} tabindex="-1" class="help-article-title focus-ui">
              {props.topic.title}
            </h3>
            <Show
              when={props.parts?.lead}
              fallback={
                // An article without a leading paragraph, or a built-in topic, shows its description; a loading article shows neither yet.
                <Show when={props.parts && props.topic.description}>
                  {(description) => <p class="help-article-lead">{description()}</p>}
                </Show>
              }
            >
              {(lead) => <props.Markdown trustedHtml={lead()} class="help-document help-article-lead" />}
            </Show>
            <Show when={props.document?.needs || props.parts?.steps}>
              {/* One row of facts; the access level appears here and nowhere else in the reader's chrome. */}
              <ul class="help-article-facts" aria-label={t().articleFacts}>
                <Show when={props.document?.needs}>
                  {(level) => (
                    <li class="help-article-fact" data-fact="needs">
                      <i class="ti ti-key" aria-hidden="true" />
                      <span>
                        {t().youNeed} <strong>{accessLabel(level())}</strong>
                      </span>
                    </li>
                  )}
                </Show>
                <Show when={props.parts?.steps}>
                  {(count) => (
                    <li class="help-article-fact" data-fact="steps">
                      <i class="ti ti-list-numbers" aria-hidden="true" />
                      <span>{t().steps({ count: count() })}</span>
                    </li>
                  )}
                </Show>
              </ul>
            </Show>
            <Show when={props.showTools}>
              <div class="help-article-tools">
                {props.sectionMenu}
                {props.copyButton}
              </div>
            </Show>
          </div>
          {/* The embedded readers sit in the app's own chrome and keep the flat head. */}
          <Show when={props.surface !== "embedded"}>
            <span class="help-article-icon k2b-icon-tile app-accent-text" aria-hidden="true">
              <i class={helpIconClass(props.topic.icon)} />
            </span>
          </Show>
        </header>
        {props.loading}
        {props.failure}
        <div ref={props.contentRef}>
          <Show when={props.parts}>{(parts) => <props.Markdown trustedHtml={parts().body} class="help-document" />}</Show>
        </div>
        <Show when={props.document}>{(document) => <ArticleEnd document={document()} appId={props.appId} />}</Show>
      </div>
      <aside class="help-article-aside">
        <div class="help-article-aside-sticky">
          {props.toc}
          {props.copyAction}
        </div>
      </aside>
    </div>
  );
}
