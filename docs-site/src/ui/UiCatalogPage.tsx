import { For, type Component } from "solid-js";
import {
  uiCatalogEntries,
  uiCatalogSections,
  portableUiComponentCount,
  type UiCatalogScope,
  type UiCatalogSectionId,
} from "./catalog";
import ActionsCatalogDemo from "./ActionsCatalogDemo.island";
import AiCatalogDemo from "./AiCatalogDemo.island";
import CloudCatalogDemo from "./CloudCatalogDemo.island";
import ContentCatalogDemo from "./ContentCatalogDemo.island";
import FeedbackCatalogDemo from "./FeedbackCatalogDemo.island";
import InputCatalogDemo from "./InputCatalogDemo.island";
import LayoutCatalogDemo from "./LayoutCatalogDemo.island";
import SurfacesCatalogDemo from "./SurfacesCatalogDemo.island";
import WidgetsCatalogDemo from "./WidgetsCatalogDemo.island";

type DocumentationProps = {
  documentation: string;
  title: string;
};

type ComponentShowcaseProps = DocumentationProps & {
  description: string;
  packageName: string;
  section: UiCatalogSectionId;
  slug: string;
};

const sectionDescriptions: Record<string, string> = {
  ai: "Controlled chat presentation for application-owned AI workflows.",
  input: "Fields, editors, pickers, uploads, and filters.",
  actions: "Buttons, menus, and focused action controls.",
  layout: "Application shells, panes, dialogs, settings, and navigation.",
  surfaces: "Cards, statistics, operational panels, and calendars.",
  feedback: "Messages, statuses, toasts, tooltips, and prompts.",
  content: "Tables, charts, files, media, code, and rich content.",
  widgets: "Semantic blocks for application-owned dashboards.",
  cloud: "Integrations that depend on Cloud sessions, identity, permissions, or service APIs.",
};

export const catalogDemoRenderers = {
  ai: (props) => <AiCatalogDemo slug={props.slug} />,
  input: (props) => <InputCatalogDemo slug={props.slug} />,
  actions: (props) => <ActionsCatalogDemo slug={props.slug} />,
  layout: (props) => <LayoutCatalogDemo slug={props.slug} />,
  surfaces: (props) => <SurfacesCatalogDemo slug={props.slug} />,
  feedback: (props) => <FeedbackCatalogDemo slug={props.slug} />,
  content: (props) => <ContentCatalogDemo slug={props.slug} />,
  widgets: (props) => <WidgetsCatalogDemo slug={props.slug} />,
  cloud: (props) => <CloudCatalogDemo slug={props.slug} />,
} satisfies Record<UiCatalogSectionId, Component<{ slug: string }>>;

function CatalogDemo(props: { section: UiCatalogSectionId; slug: string }) {
  const Renderer = catalogDemoRenderers[props.section];
  return <Renderer slug={props.slug} />;
}

function ComponentShowcase(props: ComponentShowcaseProps) {
  return (
    <article class="ui-showcase ui-reference-showcase">
      <For each={props.section === "cloud" ? [true] : []}>
        {() => <link rel="stylesheet" href="/assets/generated/cloud-components.css" />}
      </For>
      <header class="ui-reference-heading">
        <div class="ui-page-heading">
          <p>{props.packageName}</p>
          <h1>{props.title}</h1>
        </div>
        <p>{props.description}</p>
      </header>
      <section class="ui-reference-playground" aria-label="Live component example">
        <div
          class="k2b-ui ui-demo-scope"
          classList={{ "cloud-ui-scope": props.section === "cloud" }}
        >
          <CatalogDemo section={props.section} slug={props.slug} />
        </div>
      </section>
      <section class="ui-reference-body" aria-label="Component reference">
        <div class="ui-documentation fibel-prose" innerHTML={props.documentation} />
      </section>
    </article>
  );
}

export function UiCatalogOverview(props: DocumentationProps & { locale: string }) {
  const groups: { scope: UiCatalogScope; label: string; title: string; description: string }[] = [
    {
      scope: "portable",
      label: "@k2b/ui",
      title: "Portable components",
      description:
        "Production-ready Solid components with scoped styles, accessible behavior, and configurable design tokens.",
    },
    {
      scope: "cloud",
      label: "@k2b/cloud",
      title: "Cloud components",
      description:
        "Product integrations that require authenticated Cloud APIs, identity, permissions, or application contracts.",
    },
  ];

  return (
    <article class="ui-overview">
      <header class="ui-overview-header">
        <div class="ui-page-heading">
          <p>@k2b/ui</p>
          <h1>Production-ready components for SolidJS.</h1>
        </div>
        <div class="ui-overview-intro">
          <p>
            @k2b/ui is a standalone component library with accessible interactions,
            scoped styles, configurable design tokens, and separate browser and
            server builds. Use it inside Cloud or in another Solid application.
            Cloud-specific integrations are documented separately.
          </p>
          <dl>
            <div>
              <dt>components</dt>
              <dd>{String(portableUiComponentCount).padStart(2, "0")}</dd>
            </div>
            <div>
              <dt>cloud integrations</dt>
              <dd>{String(uiCatalogEntries.filter((entry) => entry.scope === "cloud").length).padStart(2, "0")}</dd>
            </div>
          </dl>
        </div>
      </header>

      <nav class="ui-catalog-groups" aria-label="Component catalog">
        <For each={groups}>
          {(group) => (
            <section class="ui-catalog-group" data-scope={group.scope}>
              <header class="ui-catalog-group-heading">
                <p>{group.label}</p>
                <h2>{group.title}</h2>
                <span>{group.description}</span>
              </header>
              <div class="ui-catalog-directory">
                <For each={uiCatalogSections.filter((section) => section.scope === group.scope)}>
                  {(section) => {
                    const entries = uiCatalogEntries.filter((entry) => entry.section === section.id);
                    return (
                      <section class="ui-catalog-section">
                        <header>
                          <div>
                            <h3>{section.title}</h3>
                            <p>{sectionDescriptions[section.id]}</p>
                          </div>
                          <span>{String(section.count).padStart(2, "0")}</span>
                        </header>
                        <ul>
                          <For each={entries}>
                            {(entry) => (
                              <li>
                                <a href={`/${props.locale}/ui/${entry.id}`}>
                                  <span>{entry.page.title}</span>
                                  <i class={entry.page.icon} aria-hidden="true" />
                                </a>
                              </li>
                            )}
                          </For>
                        </ul>
                      </section>
                    );
                  }}
                </For>
              </div>
            </section>
          )}
        </For>
      </nav>
    </article>
  );
}

export function UiComponentShowcase(
  props: DocumentationProps & {
    description: string;
    packageName: string;
    section: UiCatalogSectionId;
    slug: string;
  },
) {
  return (
    <ComponentShowcase
      documentation={props.documentation}
      title={props.title}
      description={props.description}
      packageName={props.packageName}
      section={props.section}
      slug={props.slug}
    />
  );
}
