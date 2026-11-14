import { For } from "solid-js";
import ChartDashboard from "./ChartDashboard.island";
import ChartGallery from "./ChartGallery.island";
import ChartKindPlayground from "./ChartKindPlayground.island";
import { showcaseDashboards } from "./demo-sections/charts/dashboards";
import { chartShowcaseKind, chartShowcaseKinds, chartShowcaseQuestions } from "./demo-sections/charts/examples";
import { kindGuidance } from "./demo-sections/charts/guidance";

const DashboardLinks = (props: { base: string; current?: string }) => (
  <nav class="ui-charts-dashboards" aria-label="Example dashboards">
    <For each={showcaseDashboards.filter((dashboard) => dashboard.slug !== props.current)}>
      {(dashboard) => (
        <a href={`${props.base}/dashboards/${dashboard.slug}`}>
          <span>{dashboard.eyebrow}</span>
          <strong>{dashboard.title} dashboard</strong>
          <small>{dashboard.summary}</small>
          <i class="ti ti-arrow-right" aria-hidden="true" />
        </a>
      )}
    </For>
  </nav>
);

/** "Charts": the overview that starts from what the reader wants to show. */
export function ChartsOverviewPage(props: { locale: string }) {
  const base = `/${props.locale}/ui/charts`;
  return (
    <article class="ui-showcase ui-charts-page">
      <header class="ui-charts-hero">
        <div class="ui-page-heading">
          <p>@k2b/ui · Charts</p>
          <h1>What do you want to show?</h1>
        </div>
        <div class="ui-charts-hero__intro">
          <p>
            Start from the question your data answers. Every card is a live chart: point at it or focus it with Tab to read the values, then
            open its page for its states, its code and its options.
          </p>
          <dl>
            <div>
              <dt>kinds</dt>
              <dd>{String(chartShowcaseKinds.length).padStart(2, "0")}</dd>
            </div>
            <div>
              <dt>questions</dt>
              <dd>{String(chartShowcaseQuestions.length).padStart(2, "0")}</dd>
            </div>
          </dl>
        </div>
      </header>
      <ChartGallery base={base} />
      <section class="ui-charts-more" aria-labelledby="charts-dashboards">
        <h2 id="charts-dashboards">See them together</h2>
        <p>Two dashboards from the catalog mockup, with invented data. Switch every panel between data, loading, empty, error and stale.</p>
        <DashboardLinks base={base} />
        <p class="ui-charts-more__reference">
          Props, inspection and exploration in detail: <a href={`/${props.locale}/ui/content/charts`}>Chart reference</a>.
        </p>
      </section>
    </article>
  );
}

/** One page per kind: the live example, when to use it, keyboard and screen reader, and its options. */
export function ChartKindPage(props: { locale: string; kind: string }) {
  const base = `/${props.locale}/ui/charts`;
  const kind = chartShowcaseKind(props.kind)!;
  const question = chartShowcaseQuestions.find((entry) => entry.id === kind.question)!;
  const { options, useFor, avoidFor, a11y } = kindGuidance(kind);
  const related = chartShowcaseKinds.filter((entry) => entry.question === kind.question && entry.kind !== kind.kind);
  return (
    <article class="ui-showcase ui-charts-page">
      <header class="ui-charts-kind-heading">
        <nav class="ui-charts-trail" aria-label="Breadcrumb">
          <a href={base}>Charts</a>
          <i class="ti ti-chevron-right" aria-hidden="true" />
          <a href={`${base}#${question.id}`}>{question.title}</a>
        </nav>
        <div class="ui-page-heading">
          <p>{question.question}</p>
          <h1>{kind.title}</h1>
        </div>
        <p class="ui-charts-kind-heading__summary">{kind.summary}</p>
      </header>
      <ChartKindPlayground kind={kind.kind} />
      <section class="ui-charts-guidance" aria-label="When to use it">
        <div>
          <h2>
            <i class="ti ti-circle-check" aria-hidden="true" /> Use it for
          </h2>
          <ul>
            <For each={useFor}>{(item) => <li>{item}</li>}</For>
          </ul>
        </div>
        <div>
          <h2>
            <i class="ti ti-circle-x" aria-hidden="true" /> Avoid it for
          </h2>
          <ul>
            <For each={avoidFor}>{(item) => <li>{item}</li>}</For>
          </ul>
        </div>
      </section>
      <section class="ui-charts-section" aria-labelledby="charts-a11y">
        <h2 id="charts-a11y">Keyboard and screen reader</h2>
        <ul class="ui-charts-a11y">
          <For each={a11y}>{(item) => <li>{item}</li>}</For>
        </ul>
      </section>
      <section class="ui-charts-section" aria-labelledby="charts-options">
        <h2 id="charts-options">Options</h2>
        <div class="ui-charts-options">
          <table>
            <thead>
              <tr>
                <th scope="col">Option</th>
                <th scope="col">Type</th>
                <th scope="col">What it does</th>
              </tr>
            </thead>
            <tbody>
              <For each={options}>
                {(option) => (
                  <tr>
                    <th scope="row">
                      <code>{option.name}</code>
                    </th>
                    <td>
                      <code>{option.type}</code>
                    </td>
                    <td>{option.description}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </section>
      <section class="ui-charts-section" aria-labelledby="charts-related">
        <h2 id="charts-related">Other ways to answer “{question.question}”</h2>
        <nav class="ui-charts-related" aria-labelledby="charts-related">
          <For each={related}>
            {(entry) => (
              <a href={`${base}/${entry.slug}`}>
                <strong>{entry.title}</strong>
                <span>{entry.summary}</span>
              </a>
            )}
          </For>
          <a href={base}>
            <strong>All questions</strong>
            <span>Back to the overview of every kind.</span>
          </a>
        </nav>
      </section>
    </article>
  );
}

export function ChartDashboardPage(props: { locale: string; slug: string; title: string; description: string }) {
  const base = `/${props.locale}/ui/charts`;
  return (
    <article class="ui-showcase ui-charts-page">
      <header class="ui-charts-kind-heading">
        <nav class="ui-charts-trail" aria-label="Breadcrumb">
          <a href={base}>Charts</a>
          <i class="ti ti-chevron-right" aria-hidden="true" />
          <span>Example dashboards</span>
        </nav>
        <div class="ui-page-heading">
          <p>Example dashboard · invented data</p>
          <h1>{props.title}</h1>
        </div>
        <p class="ui-charts-kind-heading__summary">{props.description}</p>
      </header>
      <ChartDashboard slug={props.slug} />
      <section class="ui-charts-more" aria-label="More dashboards">
        <DashboardLinks base={base} current={props.slug} />
      </section>
    </article>
  );
}
