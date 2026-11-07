import { For, Show } from "solid-js";
import { chartShowcaseKinds, chartShowcaseQuestions, plannedChartSlots } from "./demo-sections/charts/examples";
import { cardSpan, ShowcaseCardChart } from "./demo-sections/charts/ShowcaseCard";

/** The overview: one group per question, each card a live chart that opens its kind's page. */
export default function ChartGallery(props: { base: string }) {
  return (
    <div class="ui-charts-gallery">
      <nav class="ui-charts-questions" aria-label="Questions">
        <For each={chartShowcaseQuestions}>
          {(question) => (
            <a href={`#${question.id}`}>
              <i class={question.icon} aria-hidden="true" />
              <span>{question.title}</span>
              <small>{chartShowcaseKinds.filter((kind) => kind.question === question.id).length}</small>
            </a>
          )}
        </For>
      </nav>
      <For each={chartShowcaseQuestions}>
        {(question) => {
          const kinds = () => chartShowcaseKinds.filter((kind) => kind.question === question.id);
          return (
            <section class="ui-charts-group" id={question.id} aria-labelledby={`${question.id}-title`}>
              <header class="ui-charts-group__header k2b-ui">
                <span class="ui-charts-group__icon k2b-icon-tile" aria-hidden="true">
                  <i class={question.icon} />
                </span>
                <div>
                  <p>{question.title}</p>
                  <h2 id={`${question.id}-title`}>{question.question}</h2>
                  <span>{question.description}</span>
                </div>
              </header>
              <div class="ui-charts-cards">
                <For each={kinds()}>
                  {(kind) => {
                    const example = kind.examples[0]!;
                    const height = () => Math.min(example.height ?? 168, 168);
                    return (
                      <article class="ui-charts-card k2b-ui" data-span={cardSpan(example)}>
                        <header>
                          <h3>
                            <a href={`${props.base}/${kind.slug}`}>{kind.title}</a>
                          </h3>
                          <p>{kind.summary}</p>
                        </header>
                        <ShowcaseCardChart example={example} height={height()} />
                        <a
                          class="ui-charts-card__open"
                          href={`${props.base}/${kind.slug}`}
                          aria-label={`${kind.title}: states, code and options`}
                        >
                          States, code and options
                          <i class="ti ti-arrow-right" aria-hidden="true" />
                        </a>
                      </article>
                    );
                  }}
                </For>
                <Show when={!kinds().length}>
                  <p class="ui-charts-group__none">No kind answers this question yet.</p>
                </Show>
              </div>
              <Show when={plannedChartSlots(question.id).length}>
                <p class="ui-charts-group__planned">
                  <span>Coming with the catalog</span>
                  <For each={plannedChartSlots(question.id)}>{(planned) => <span class="ui-charts-chip">{planned.title}</span>}</For>
                </p>
              </Show>
            </section>
          );
        }}
      </For>
    </div>
  );
}
