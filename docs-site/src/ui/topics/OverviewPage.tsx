import { For, Show } from "solid-js";
import { type RecipeName, recipeNames } from "./recipes";
import { recipeFile } from "./topic-markdown";
import { topics } from "./topics";

/** A recipe drawn small: the live screen at desktop width in a frame five times the tile's width, scaled to a fifth. */
const Thumbnail = (props: { recipe?: RecipeName; icon: string }) => (
  <div class="ui-map__thumb" aria-hidden="true">
    <Show when={props.recipe} fallback={<i class={`ti ti-${props.icon}`} />}>
      {(recipe) => (
        <div class="ui-map__frame" inert>
          <iframe src={`/en/ui/v2/recipe/${recipe()}`} title="" tabIndex={-1} loading="lazy" />
        </div>
      )}
    </Show>
  </div>
);

const topicIcons: Record<string, string> = {
  frame: "layout-sidebar",
  "lists-and-tables": "table",
  "filter-sort-group": "filter",
  "record-and-detail": "id",
  "forms-and-input": "forms",
  "actions-and-menus": "dots",
  "dialogs-and-overlays": "app-window",
  "states-and-notices": "info-circle",
  content: "article",
};

export const overviewIntro =
  "The parts of v2 own spacing, lines and type. An app only picks which part stands where and fills it with data. Each topic shows what you can build: a live screen, its parts with their props, and the code.";

/** The overview as Markdown, for search and `read_doc`: every topic with its line and parts, every whole screen. */
export const overviewMarkdown = () =>
  [
    "# Screens from fixed parts",
    "",
    overviewIntro,
    "",
    "Agents: the skill `k2b-ui` says what to use; `read_doc` returns each topic below as Markdown with its code and props.",
    "",
    "## What you can build",
    "",
    ...topics.map((topic) => `${topic.number}. [${topic.parsed.title}](${topic.href}): ${topic.summary} Parts: ${topic.parts.join(", ")}.`),
    "",
    "## Whole screens",
    "",
    ...recipeNames.map((name) => {
      const file = recipeFile(name);
      return `- ${file.about} (\`${file.path}\`), on [Whole screens](/en/ui/v2/screens).`;
    }),
    "",
    "## v1",
    "",
    'The v1 components keep their pages under "v1 (existing)" while apps still use them. New screens use v2. The section goes when v1 goes.',
  ].join("\n");

/** The start of the UI section: a map of the topics with live thumbnails, the whole screens, and where v1 went. */
export const OverviewPage = () => (
  <article class="ui-topic ui-overview-v2">
    <header class="ui-topic__head">
      <p class="ui-topic__eyebrow">
        @k2b/ui/v2
        <span class="ui-topic__chip" data-tone="warn">
          provisional
        </span>
      </p>
      <h1>Screens from fixed parts</h1>
      <p class="ui-topic__lead">{overviewIntro}</p>
    </header>
    <div class="ui-ways">
      <a href={topics[0]?.href}>
        <i class="ti ti-compass" aria-hidden="true" />
        <b>Look around</b>
        <span>Pick a topic below. Every screen is live: switch the width, the state, the code.</span>
      </a>
      <a href="/en/ui/v2/rules">
        <i class="ti ti-ruler-2" aria-hidden="true" />
        <b>Rules</b>
        <span>The rules every screen keeps, and the check that holds each one.</span>
      </a>
      <a href="/en/ui/getting-started">
        <i class="ti ti-robot" aria-hidden="true" />
        <b>For agents</b>
        <span>
          The skill <code>k2b-ui</code> says what to use. <code>read_doc</code> returns each topic as Markdown with its code.
        </span>
      </a>
    </div>
    <h2 class="ui-topic__h2">What you can build</h2>
    <p class="ui-topic__p">Topics follow the job on a screen, not the component. A part appears in the topic where it is used most.</p>
    <div class="ui-map">
      <For each={topics}>
        {(topic) => (
          <a class="ui-map__tile" href={topic.href}>
            <Thumbnail recipe={topic.parsed.front.thumbnail} icon={topicIcons[topic.slug] ?? "layout"} />
            <span class="ui-map__title">
              <span class="ui-map__number">{topic.number}</span>
              {topic.parsed.title}
              <Show when={topic.parsed.front.status === "stub"}>
                <span class="ui-topic__chip">in work</span>
              </Show>
            </span>
            <span class="ui-map__line">{topic.summary}</span>
            <span class="ui-map__parts">{topic.parts.join(" · ")}</span>
          </a>
        )}
      </For>
    </div>
    <h2 class="ui-topic__h2">Whole screens</h2>
    <p class="ui-topic__p">Complete screens with invented data. Each one is a recipe: open it, switch the width, copy the code.</p>
    <div class="ui-map" data-kind="screens">
      <For each={recipeNames}>
        {(name) => (
          <a class="ui-map__tile" href={`/en/ui/v2/screens#${name}`}>
            <Thumbnail recipe={name} icon="layout" />
            <span class="ui-map__title">{recipeFile(name).about.split(":")[0]}</span>
            <span class="ui-map__parts">{recipeFile(name).path.split("/").at(-1)}</span>
          </a>
        )}
      </For>
    </div>
    <aside class="ui-topic__missing">
      <i class="ti ti-archive" aria-hidden="true" />
      <p>
        <b>v1 components</b> keep their pages under “v1 (existing)” while apps still use them. New screens use v2. The section goes when v1
        goes.
      </p>
    </aside>
  </article>
);
