import { Dropdown, LocaleProvider, MarkdownView, TableOfContents, useLocale } from "@k2b/ui";
import { type Accessor, createMemo, createSignal, onMount } from "solid-js";
import { render } from "solid-js/web";
import type { HelpDocumentPayload } from "../shared/help";
import { helpMessages } from "./help-messages";
import { helpArticleParts } from "./layout-help-article";
import type { HelpPanelState } from "./layout-help-panel-state";
import type { HelpTopic } from "./layout-help-registry";
import { HelpArticleView } from "./layout-help-views";

function Sections(props: {
  sections: { id: string; label: string }[];
  onSection: (id: string) => void;
  active: Accessor<string | null>;
  activation?: { key: string; focused: boolean };
}) {
  const locale = useLocale();
  const t = () => helpMessages.resolve([locale()]).t;
  let trigger: HTMLButtonElement | undefined;
  onMount(() => {
    if (!props.activation) return;
    if (props.activation.focused) trigger?.focus({ preventScroll: true });
    trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: props.activation.key, bubbles: true, cancelable: true }));
  });
  return (
    <Dropdown.Root
      label={t().onThisPage}
      position="bottom-left"
      items={props.sections.map((section) => ({
        label: section.label,
        choice: "radio" as const,
        checked: () => props.active() === section.id,
        action: () => {
          props.onSection(section.id);
        },
      }))}
    >
      <Dropdown.Trigger
        ref={(element) => {
          trigger = element;
        }}
        label={t().onThisPage}
        size="sm"
        tooltip={false}
        variant="secondary"
      >
        <i class="ti ti-list" aria-hidden="true" />
        <span>{t().onThisPage}</span>
        <i class="ti ti-chevron-down" aria-hidden="true" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}
export function HelpPanelReader(props: {
  state: HelpPanelState;
  topic: HelpTopic;
  document: HelpDocumentPayload;
  onSection: (id: string) => void;
}) {
  const locale = useLocale();
  const t = () => helpMessages.resolve([locale()]).t;
  const parts = createMemo(() => helpArticleParts(props.document.html));
  const [active, setActive] = createSignal<string | null>(parts().sections[0]?.id ?? null);
  let content: HTMLDivElement | undefined;
  return (
    <HelpArticleView
      surface="panel"
      topic={props.topic}
      appId={props.state.data.appId}
      parts={parts()}
      document={props.document}
      Markdown={MarkdownView}
      showTools={parts().sections.length > 0}
      sectionMenu={
        parts().sections.length ? (
          <Sections
            sections={parts().sections}
            active={active}
            onSection={(id) => {
              setActive(id);
              props.onSection(id);
            }}
          />
        ) : null
      }
      copyButton={null}
      loading={null}
      failure={null}
      toc={
        <TableOfContents
          items={parts().sections}
          title={t().onThisPage}
          scrollRoot={() => props.state.scroller() ?? undefined}
          contentRoot={() => content}
          onActiveChange={(id) => setActive(id ?? null)}
        />
      }
      copyAction={null}
      headingRef={() => {}}
      contentRef={(element) => {
        content = element;
      }}
      onBack={props.state.back}
    />
  );
}
export function mountPanelSections(
  container: HTMLElement,
  props: { locale: string; state: HelpPanelState; key: string; focused: boolean; onSection: (id: string) => void },
): () => void {
  const article = container.closest("article");
  const sections = Array.from(article?.querySelectorAll<HTMLAnchorElement>(".help-article-aside a[href^='#']") ?? []).map((link) => ({
    id: decodeURIComponent(link.getAttribute("href")!.slice(1)),
    label: link.textContent ?? "",
  }));
  const [active, setActive] = createSignal<string | null>(sections[0]?.id ?? null);
  const aside = article?.querySelector<HTMLElement>(".help-article-aside-sticky");
  let disposeToc = () => {};
  // The aside is hidden at every panel width. Upgrade its scroll spy only when the section menu needs it.
  if (aside) {
    aside.textContent = "";
    disposeToc = render(
      () => (
        <LocaleProvider locale={props.locale}>
          <TableOfContents
            items={sections}
            title={helpMessages.resolve([props.locale]).t.onThisPage}
            scrollRoot={() => props.state.scroller() ?? undefined}
            contentRoot={() => article ?? undefined}
            onActiveChange={(id) => setActive(id ?? null)}
          />
        </LocaleProvider>
      ),
      aside,
    );
  }
  container.textContent = "";
  container.style.display = "contents";
  const disposeMenu = render(
    () => (
      <LocaleProvider locale={props.locale}>
        <Sections
          sections={sections}
          active={active}
          onSection={(id) => {
            setActive(id);
            props.onSection(id);
          }}
          activation={{ key: props.key, focused: props.focused }}
        />
      </LocaleProvider>
    ),
    container,
  );
  return () => {
    disposeMenu();
    disposeToc();
  };
}
