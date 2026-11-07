import { solidPage } from "@k2b/fibel/solid";
import { fibelHtml } from "../ssr";
import { ChartDashboardPage, ChartKindPage, ChartsOverviewPage } from "./ChartsShowcase";
import { uiCatalogEntries } from "./catalog";
import focusMarkdown from "./context/focus.md" with { type: "text" };
import gettingStartedMarkdown from "./context/getting-started.md" with { type: "text" };
import inputModeMarkdown from "./context/input-mode.md" with { type: "text" };
import motionMarkdown from "./context/motion.md" with { type: "text" };
import overviewMarkdown from "./context/overview.md" with { type: "text" };
import { showcaseDashboards } from "./demo-sections/charts/dashboards";
import { chartShowcaseKinds } from "./demo-sections/charts/examples";
import { UiCatalogOverview, UiComponentShowcase } from "./UiCatalogPage";

export const uiPages = [
  solidPage({
    html: fibelHtml,
    collection: "ui",
    path: "/",
    title: "UI components",
    navTitle: "Overview",
    description:
      "A standalone SolidJS component library with accessible interactions, scoped styles, design tokens, and browser and server builds.",
    section: "Start",
    order: 1,
    layout: "full",
    content: overviewMarkdown,
    component: ({ content, page }) => <UiCatalogOverview title={page.meta.title} documentation={content.html} locale={page.locale.code} />,
  }),
  solidPage({
    html: fibelHtml,
    collection: "ui",
    path: "/getting-started",
    title: "Getting started",
    navTitle: "Getting started",
    description: "Install @k2b/ui, load its scoped styles, customize the theme, and use it in a Solid application.",
    section: "Start",
    order: 2,
    layout: "full",
    content: gettingStartedMarkdown,
    component: ({ content, page }) => (
      <article class="ui-showcase ui-reference-showcase">
        <header class="ui-reference-heading">
          <div class="ui-page-heading">
            <p>@k2b/ui</p>
            <h1>{page.meta.title}</h1>
          </div>
          <p>{page.meta.description}</p>
        </header>
        <section class="ui-reference-body" aria-label="Getting started guide">
          <div class="ui-documentation fibel-prose" innerHTML={content.html} />
        </section>
      </article>
    ),
  }),
  solidPage({
    html: fibelHtml,
    collection: "ui",
    path: "/focus",
    title: "Focus rings",
    navTitle: "Focus rings",
    description: "How focus rings stay visible inside clipping containers without moving the layout, and how to style your own.",
    section: "Start",
    order: 3,
    layout: "full",
    content: focusMarkdown,
    component: ({ content, page }) => (
      <article class="ui-showcase ui-reference-showcase">
        <header class="ui-reference-heading">
          <div class="ui-page-heading">
            <p>@k2b/ui</p>
            <h1>{page.meta.title}</h1>
          </div>
          <p>{page.meta.description}</p>
        </header>
        <section class="ui-reference-body" aria-label="Focus ring guide">
          <div class="ui-documentation fibel-prose" innerHTML={content.html} />
        </section>
      </article>
    ),
  }),
  solidPage({
    html: fibelHtml,
    collection: "ui",
    path: "/motion",
    title: "Motion",
    navTitle: "Motion",
    description: "Shared motion tokens, interaction budgets, and instant reduced motion for CSS and JavaScript.",
    section: "Start",
    order: 4,
    layout: "full",
    content: motionMarkdown,
    component: ({ content, page }) => (
      <article class="ui-showcase ui-reference-showcase">
        <header class="ui-reference-heading">
          <div class="ui-page-heading">
            <p>@k2b/ui</p>
            <h1>{page.meta.title}</h1>
          </div>
          <p>{page.meta.description}</p>
        </header>
        <section class="ui-reference-body" aria-label="Motion guide">
          <div class="ui-documentation fibel-prose" innerHTML={content.html} />
        </section>
      </article>
    ),
  }),
  solidPage({
    html: fibelHtml,
    collection: "ui",
    path: "/input-mode",
    title: "Input mode",
    navTitle: "Input mode",
    description: "Pointer input modes and keyboard hints without layout changes.",
    section: "Start",
    order: 5,
    layout: "full",
    content: inputModeMarkdown,
    component: ({ content, page }) => (
      <article class="ui-showcase ui-reference-showcase">
        <header class="ui-reference-heading">
          <div class="ui-page-heading">
            <p>@k2b/ui</p>
            <h1>{page.meta.title}</h1>
          </div>
          <p>{page.meta.description}</p>
        </header>
        <section class="ui-reference-body" aria-label="Input mode guide">
          <div class="ui-documentation fibel-prose" innerHTML={content.html} />
        </section>
      </article>
    ),
  }),
  solidPage({
    html: fibelHtml,
    collection: "ui",
    path: "/charts",
    title: "Charts",
    navTitle: "What to show",
    description: "A showcase of every chart kind, grouped by the question it answers, with live states, code and options.",
    section: "Charts",
    order: 50,
    layout: "full",
    component: ({ page }) => <ChartsOverviewPage locale={page.locale.code} />,
  }),
  ...chartShowcaseKinds.map((kind, index) =>
    solidPage({
      html: fibelHtml,
      collection: "ui",
      path: `/charts/${kind.slug}`,
      title: kind.title,
      description: kind.summary,
      section: "Charts",
      order: 51 + index,
      layout: "full",
      component: ({ page }) => <ChartKindPage locale={page.locale.code} kind={kind.kind} />,
    }),
  ),
  ...showcaseDashboards.map((dashboard, index) =>
    solidPage({
      html: fibelHtml,
      collection: "ui",
      path: `/charts/dashboards/${dashboard.slug}`,
      title: `${dashboard.title} dashboard`,
      navTitle: `Dashboard: ${dashboard.title}`,
      description: dashboard.summary,
      section: "Charts",
      order: 90 + index,
      layout: "full",
      component: ({ page }) => (
        <ChartDashboardPage
          locale={page.locale.code}
          slug={dashboard.slug}
          title={`${dashboard.title} dashboard`}
          description={dashboard.summary}
        />
      ),
    }),
  ),
  ...uiCatalogEntries.map((entry) =>
    solidPage({
      html: fibelHtml,
      collection: "ui",
      path: `/${entry.section}/${entry.page.slug}`,
      title: entry.page.title,
      description: entry.page.summary,
      section: entry.sectionTitle,
      order: entry.order,
      layout: "full",
      content: entry.context,
      component: ({ content, page, request }) => (
        <UiComponentShowcase
          title={page.meta.title}
          description={page.meta.description}
          documentation={content.html}
          packageName={entry.packageName}
          section={entry.section}
          slug={entry.page.slug}
          search={new URL(request.url).search}
        />
      ),
    }),
  ),
];
