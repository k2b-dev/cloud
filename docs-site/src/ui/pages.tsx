import { solidPage } from "@k2b/fibel/solid";
import { fibelHtml } from "../ssr";
import { ChartDashboardPage, ChartKindPage, ChartsOverviewPage } from "./ChartsShowcase";
import { uiCatalogEntries } from "./catalog";
import focusMarkdown from "./context/focus.md" with { type: "text" };
import v1GettingStartedMarkdown from "./context/getting-started.md" with { type: "text" };
import inputModeMarkdown from "./context/input-mode.md" with { type: "text" };
import motionMarkdown from "./context/motion.md" with { type: "text" };
import v1OverviewMarkdown from "./context/overview.md" with { type: "text" };
import primaryScopeMarkdown from "./context/primary-scope.md" with { type: "text" };
import { showcaseDashboards } from "./demo-sections/charts/dashboards";
import { chartShowcaseKinds } from "./demo-sections/charts/examples";
import PrimaryScopeDemo from "./PrimaryScopeDemo.island";
import v2GettingStartedMarkdown from "./topics/getting-started.md" with { type: "text" };
import { OverviewPage, overviewMarkdown } from "./topics/OverviewPage";
import screensMarkdown from "./topics/screens.md" with { type: "text" };
import { MarkdownArticle, TopicPage } from "./topics/TopicPage";
import { parseTopic, topicMarkdown } from "./topics/topic-markdown";
import { topics } from "./topics/topics";
import { v1PageMarkdown } from "./topics/v1-pointers";
import { UiCatalogOverview, UiComponentShowcase } from "./UiCatalogPage";
import { V2RulesPage } from "./V2RulesPage";
import { V2DemoScreens } from "./v2/V2DemoPage";

/** The folded area of the v1 pages, until v1 is removed (concept F3). */
export const v1Section = "v1 (existing)";
const screens = parseTopic(screensMarkdown);
const gettingStarted = parseTopic(v2GettingStartedMarkdown);

export const uiPages = [
  solidPage({
    html: fibelHtml,
    collection: "ui",
    path: "/",
    title: "UI",
    navTitle: "Overview",
    description: "Screens from fixed parts: the topics of @k2b/ui/v2, each with a live screen, its parts and the code.",
    section: "Start",
    order: 1,
    layout: "full",
    content: overviewMarkdown(),
    component: () => <OverviewPage />,
  }),
  solidPage({
    html: fibelHtml,
    collection: "ui",
    path: "/v1",
    title: "UI components (v1)",
    navTitle: "v1 overview",
    description:
      "A standalone SolidJS component library with accessible interactions, scoped styles, design tokens, and browser and server builds.",
    section: v1Section,
    order: 200,
    layout: "full",
    content: v1OverviewMarkdown,
    component: ({ content, page }) => <UiCatalogOverview title={page.meta.title} documentation={content.html} locale={page.locale.code} />,
  }),
  solidPage({
    html: fibelHtml,
    collection: "ui",
    path: "/v1/getting-started",
    title: "Getting started (v1)",
    navTitle: "v1 getting started",
    description: "Install @k2b/ui, load its scoped styles, customize the theme, and use it in a Solid application.",
    section: v1Section,
    order: 199,
    layout: "full",
    content: v1GettingStartedMarkdown,
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
    path: "/getting-started",
    title: gettingStarted.title,
    navTitle: "Getting started",
    description: "Opt a page into @k2b/ui/v2, start a screen from a recipe, and check it with the preview script and the rules.",
    section: "Start",
    order: 2,
    layout: "full",
    content: v2GettingStartedMarkdown,
    component: (context) => <MarkdownArticle parsed={gettingStarted} context={context} eyebrow={<>@k2b/ui/v2 · provisional</>} />,
  }),
  solidPage({
    html: fibelHtml,
    collection: "ui",
    path: "/focus",
    title: "Focus rings",
    navTitle: "Focus rings",
    description: "How focus rings stay visible inside clipping containers without moving the layout, and how to style your own.",
    section: v1Section,
    order: 201,
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
    section: v1Section,
    order: 202,
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
    section: v1Section,
    order: 203,
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
    path: "/primary-scope",
    title: "Primary scope",
    navTitle: "Primary scope",
    description: "Use the AI palette for primary actions, selection, and focus in a scoped area.",
    section: v1Section,
    order: 204,
    layout: "full",
    content: primaryScopeMarkdown,
    component: ({ content, page }) => (
      <article class="ui-showcase ui-reference-showcase">
        <header class="ui-reference-heading">
          <div class="ui-page-heading">
            <p>@k2b/ui</p>
            <h1>{page.meta.title}</h1>
          </div>
        </header>
        <section class="ui-reference-body" aria-label="Primary scope guide">
          <div class="ui-documentation fibel-prose" innerHTML={content.html} />
          <PrimaryScopeDemo />
        </section>
      </article>
    ),
  }),
  solidPage({
    html: fibelHtml,
    collection: "ui",
    path: "/v2/rules",
    title: "UI v2 · Rules",
    navTitle: "Rules",
    description:
      "The layout rules of @k2b/ui v2, each with an excerpt of the approved mockup and the check that holds it. Provisional until the maintainer approves v2.",
    section: "Start",
    order: 3,
    layout: "full",
    component: ({ page }) => <V2RulesPage title={page.meta.title} description={page.meta.description} />,
  }),
  ...topics.map((topic) =>
    solidPage({
      html: fibelHtml,
      collection: "ui",
      path: topic.path,
      title: topic.parsed.title,
      navTitle: `${topic.number} · ${topic.parsed.title}`,
      description: topic.summary,
      section: "Topics",
      order: 10 + topic.number,
      layout: "full",
      content: topic.markdown,
      component: (context) => <TopicPage topic={topic} context={context} />,
    }),
  ),
  solidPage({
    html: fibelHtml,
    collection: "ui",
    path: "/v2/screens",
    title: screens.title,
    navTitle: "Whole screens",
    description:
      "Complete screens with invented data, each a recipe of the skill k2b-ui, and the demo screens measured against their mockups.",
    section: "Screens",
    order: 30,
    layout: "full",
    content: topicMarkdown(screensMarkdown),
    component: (context) => (
      <MarkdownArticle parsed={screens} context={context} eyebrow={<>@k2b/ui/v2 · provisional</>}>
        <V2DemoScreens names={["mail", "record", "deliveries", "table", "form", "keys", "menus", "articles", "logs", "people"]} />
      </MarkdownArticle>
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
      navTitle: `${entry.sectionTitle} · ${entry.page.title}`,
      section: v1Section,
      order: 1_000 + entry.order,
      layout: "full",
      content: v1PageMarkdown(entry),
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
