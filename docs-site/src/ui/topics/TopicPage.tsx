import type { FibelCustomPageRenderContext } from "@k2b/fibel";
import { For, type JSX, Match, Show, Switch } from "solid-js";
import Example from "./Example.island";
import { Props } from "./Props";
import { exampleStates, type ParsedTopic, recipeFile, type TopicBlock, type TopicSection, type TopicSubsection } from "./topic-markdown";
import { type Topic, topics } from "./topics";

type Render = (markdown: string) => string;

/** Rendered Markdown of one line without its paragraph, for a summary or a note that sets its own label. */
const inline = (render: Render, markdown: string) =>
  render(markdown)
    .trim()
    .replace(/^<p>([\s\S]*)<\/p>$/, "$1");

const Blocks = (props: { blocks: readonly TopicBlock[]; render: Render }) => (
  <For each={props.blocks}>
    {(block) => (
      <Switch>
        <Match when={block.kind === "markdown" && block}>
          {(prose) => <div class="ui-topic__prose fibel-prose" innerHTML={props.render(prose().text)} />}
        </Match>
        <Match when={block.kind === "example" && block}>
          {(found) => {
            const example = found().example;
            const file = recipeFile(example.recipe);
            return (
              <Example
                recipe={example.recipe}
                title={file.about}
                path={file.path}
                source={file.source}
                states={exampleStates(example)}
                height={example.height}
                width={example.width}
              />
            );
          }}
        </Match>
        <Match when={block.kind === "props" && block}>{(found) => <Props of={found().names} />}</Match>
      </Switch>
    )}
  </For>
);

const Heading = (props: { text: string; depth: 2 | 3; render: Render }) => (
  <div class="ui-topic__heading fibel-prose" innerHTML={props.render(`${props.depth === 2 ? "##" : "###"} ${props.text}`)} />
);

/** A part in one line; its props fold open beneath it. */
const Part = (props: { part: TopicSubsection; render: Render }) => {
  const line = () => props.part.blocks.find((block) => block.kind === "markdown");
  const rest = () => props.part.blocks.filter((block) => block !== line());
  const summary = (): JSX.Element => (
    <>
      <span class="ui-topic__part-name">{props.part.heading}</span>
      <span
        class="ui-topic__part-line"
        innerHTML={line()?.kind === "markdown" ? inline(props.render, (line() as { text: string }).text) : ""}
      />
    </>
  );
  return (
    <Show when={rest().length > 0} fallback={<div class="ui-topic__part">{summary()}</div>}>
      <details class="ui-topic__part">
        <summary>
          {summary()}
          <span class="ui-topic__part-tag">
            Props
            <i class="ti ti-chevron-down" aria-hidden="true" />
          </span>
        </summary>
        <div class="ui-topic__part-body">
          <Blocks blocks={rest()} render={props.render} />
        </div>
      </details>
    </Show>
  );
};

const Section = (props: { section: TopicSection; render: Render }) => (
  <Switch>
    <Match when={props.section.kind === "missing"}>
      <aside class="ui-topic__missing">
        <i class="ti ti-hourglass" aria-hidden="true" />
        <div>
          <Heading text={props.section.heading} depth={2} render={props.render} />
          <Blocks blocks={props.section.blocks} render={props.render} />
        </div>
      </aside>
    </Match>
    <Match when={props.section.kind === "next"}>
      <nav class="ui-topic__next" aria-label="Next topic">
        <span>Next:</span>
        <span
          innerHTML={inline(props.render, props.section.blocks.map((block) => (block.kind === "markdown" ? block.text : "")).join(" "))}
        />
        <i class="ti ti-arrow-right" aria-hidden="true" />
      </nav>
    </Match>
    <Match when={props.section.kind !== "missing" && props.section.kind !== "next"}>
      <section class="ui-topic__section" data-kind={props.section.kind}>
        <Heading text={props.section.heading} depth={2} render={props.render} />
        <Blocks blocks={props.section.blocks} render={props.render} />
        <Show when={props.section.subsections.length > 0}>
          <div class={props.section.kind === "parts" ? "ui-topic__parts" : "ui-topic__columns"}>
            <For each={props.section.subsections}>
              {(sub) =>
                props.section.kind === "parts" ? (
                  <Part part={sub} render={props.render} />
                ) : (
                  <div class="ui-topic__column" data-side={sub.heading === "Do" ? "do" : sub.heading === "Don't" ? "dont" : undefined}>
                    <h3>
                      <Show when={sub.heading === "Do" || sub.heading === "Don't"}>
                        <i class={sub.heading === "Do" ? "ti ti-check" : "ti ti-x"} aria-hidden="true" />
                      </Show>
                      {sub.heading}
                    </h3>
                    <Blocks blocks={sub.blocks} render={props.render} />
                  </div>
                )
              }
            </For>
          </div>
        </Show>
      </section>
    </Match>
  </Switch>
);

/**
 * A page of the UI section drawn from its Markdown: the title and lead, then its sections. `<Example>` and `<Props>`
 * stand where the Markdown names them; search and MCP read the Markdown twin of the same file.
 */
export const MarkdownArticle = (props: {
  parsed: ParsedTopic;
  eyebrow: JSX.Element;
  context: FibelCustomPageRenderContext;
  children?: JSX.Element;
}) => {
  const render: Render = (markdown) => props.context.fibel.services.renderMarkdown(markdown, props.context.page, props.context.fibel);
  return (
    <article class="ui-topic">
      <header class="ui-topic__head">
        <p class="ui-topic__eyebrow">{props.eyebrow}</p>
        <h1>{props.parsed.title}</h1>
        <div class="ui-topic__lead fibel-prose" innerHTML={render(props.parsed.lead)} />
      </header>
      <For each={props.parsed.sections}>{(section) => <Section section={section} render={render} />}</For>
      {props.children}
    </article>
  );
};

/** One topic page: its number among the topics, provisional while v2 is, and "in work" while it is a stub. */
export const TopicPage = (props: { topic: Topic; context: FibelCustomPageRenderContext }) => (
  <MarkdownArticle
    parsed={props.topic.parsed}
    context={props.context}
    eyebrow={
      <>
        @k2b/ui/v2 · topic {props.topic.number} of {topics.length}
        <span class="ui-topic__chip" data-tone="warn">
          provisional
        </span>
        <Show when={props.topic.parsed.front.status === "stub"}>
          <span class="ui-topic__chip">in work</span>
        </Show>
      </>
    }
  />
);
