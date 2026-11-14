import { useLocale } from "@k2b/ui";
import { For, type JSX, Show } from "solid-js";
import type { AiAnswerSource } from "./answer-source-model";
import { aiChatMessages } from "./messages";

export { type AiAnswerSource, answerSources } from "./answer-source-model";

/** An app's icon tile, 20 px: the icon in the app colour on its tint (`k2b-icon-tile`). Without a colour it stays neutral. */
export function AiAppTile(props: { icon: string; accent?: string; class?: string }): JSX.Element {
  return (
    <span
      class={`k2b-icon-tile ai-app-tile ${props.class ?? ""}`}
      style={props.accent ? { color: props.accent } : undefined}
      aria-hidden="true"
    >
      <i class={props.icon} />
    </span>
  );
}

/**
 * The row under an answer: "Sources", then one grey pill per source with its number, app tile, and title. The number
 * matches the chip in the text and opens the same way: in a new tab, like every link in an answer.
 */
export function AiAnswerSources(props: { sources: AiAnswerSource[] }): JSX.Element {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  return (
    <Show when={props.sources.length > 0}>
      <div class="ai-sources" role="group" aria-label={t().sources}>
        <span class="ai-sources__label" aria-hidden="true">
          {t().sources}
        </span>
        <ul class="ai-sources__list">
          <For each={props.sources}>
            {(source) => (
              <li>
                <a
                  class="ai-source"
                  href={source.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={source.title}
                  aria-label={t().sourceLabel({ number: source.number, title: source.title })}
                >
                  <span class="ai-source__number">{source.number}</span>
                  <AiAppTile icon={source.icon} accent={source.accent} />
                  <span class="ai-source__title k2b-truncate-fade">{source.title}</span>
                </a>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Show>
  );
}
