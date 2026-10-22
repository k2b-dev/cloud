import { MarkdownView, ScrollArea, TableOfContents, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import HelpPanelArticle from "./HelpPanelArticle.island";
import HelpPanelBack from "./HelpPanelBack.island";
import HelpPanelMenu from "./HelpPanelMenu.island";
import HelpPanelSearch from "./HelpPanelSearch.island";
import HelpPanelShortcuts from "./HelpPanelShortcuts.island";
import HelpPanelView from "./HelpPanelView.island";
import { helpMessages } from "./help-messages";
import { HelpPanelSectionTrigger } from "./layout-help-panel-controls";
import type { HelpPanelData } from "./layout-help-panel-state";
import type { LayoutHelpPanelProps } from "./layout-help-panel-types";
import { helpStart } from "./layout-help-start";
import { HelpArticleView, HelpHead, HelpNotAvailableView, HelpStartView } from "./layout-help-views";

export type { LayoutHelpPanelProps } from "./layout-help-panel-types";

/** Static provider content survives island mounting; only the controls own browser state. */
export function LayoutHelpPanel(props: LayoutHelpPanelProps) {
  const locale = useLocale();
  const t = () => helpMessages.resolve([locale()]).t;
  const topic = props.documents.find((topic) => topic.id === props.initialTopic);
  const article = topic && props.initialArticle?.payload.id === topic.id ? props.initialArticle : undefined;
  const start = helpStart(props.documents, props.view);
  const data: HelpPanelData = {
    // The legacy reader searched and copied its topics in start order; keep that order for every manifest.
    documents: [...props.documents]
      .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title))
      .map(({ id, title, description, icon, kind, order, url, searchUrl, locale }) => ({
        id,
        title,
        description,
        icon,
        kind,
        order,
        url,
        searchUrl,
        locale,
      })),
    appId: props.app?.id,
    pageBase: props.pageBase,
    article: article?.payload,
  };
  return (
    <div
      class="help-shell app-accent-scope flex h-full min-h-0 flex-col"
      data-surface="panel"
      style={props.appearance}
      data-help-initial-topic={topic?.id}
    >
      <Show when={props.state !== "unavailable"}>
        <HelpHead
          row
          back={!!topic}
          tile={props.app?.icon ?? "ti ti-help-circle"}
          title={props.app?.name ?? t().help}
          lead={<HelpPanelBack back={!!topic} tile={props.app?.icon ?? "ti ti-help-circle"} />}
          menu={<HelpPanelMenu />}
          closable={false}
          onBack={() => {}}
          onClose={() => {}}
          query=""
          onQuery={() => {}}
          searchRef={() => {}}
        />
      </Show>
      <ScrollArea class="min-h-0 flex-1 p-4 sm:p-5">
        <Show when={props.state !== "unavailable"} fallback={<HelpNotAvailableView />}>
          <div class="help-start help-measure" data-help-results="" hidden={!!topic}>
            <div data-help-start-content="">
              <HelpPanelView topics={start.view} />
              <HelpStartView
                start={{ ...start, view: [] }}
                empty={props.documents.length === 0}
                failed={props.state === "failed"}
                onOpen={() => {}}
                onReload={() => {}}
                shortcuts={<HelpPanelShortcuts appName={props.app?.name} platform={props.platform} />}
              />
            </div>
            <HelpPanelSearch />
          </div>
          <Show when={article && topic}>
            {article && topic && (
              <article class="help-article" data-surface="panel" data-help-server-article="">
                <HelpArticleView
                  surface="panel"
                  topic={topic}
                  appName={props.app?.name}
                  appId={props.app?.id}
                  parts={article.parts}
                  document={{ ...article.payload, html: "" }}
                  Markdown={MarkdownView}
                  showTools={article.parts.sections.length > 0}
                  sectionMenu={article.parts.sections.length ? <HelpPanelSectionTrigger label={t().onThisPage} /> : null}
                  copyButton={null}
                  loading={null}
                  failure={null}
                  toc={<TableOfContents items={article.parts.sections} title={t().onThisPage} />}
                  copyAction={null}
                  headingRef={() => {}}
                  contentRef={() => {}}
                  onBack={() => {}}
                />
              </article>
            )}
          </Show>
          <HelpPanelArticle topic={article ? undefined : topic} />
        </Show>
        <span class="sr-only" aria-live="polite" data-help-announcement="" />
      </ScrollArea>
      <script type="application/json" data-help-panel-data="" innerHTML={JSON.stringify(data).replace(/</g, "\\u003c")} />
    </div>
  );
}
