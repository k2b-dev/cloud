import { For, Show } from "solid-js";
import CopyButton from "../actions/CopyButton";
import { type CodeDisplayLanguage, highlightCodeDisplayLines } from "./code-highlight";

export type { CodeDisplayLanguage };

export type CodeDisplayProps = {
  code: string;
  title?: string;
  language?: CodeDisplayLanguage;
  copy?: boolean;
  lineNumbers?: boolean;
  /** Number of the first shown line, for an excerpt of a longer file, such as its end while it is still written. */
  startLine?: number;
  class?: string;
};

export default function CodeDisplay(props: CodeDisplayProps) {
  const lines = () => highlightCodeDisplayLines(props.code, language());
  const lineNumbers = () => props.lineNumbers ?? true;
  const startLine = () => Math.max(1, Math.floor(props.startLine ?? 1));
  // Numbers past three digits get a wider column, so a long file keeps every line aligned.
  const digits = () => {
    const count = String(startLine() + lines().length - 1).length;
    return lineNumbers() && count > 3 ? String(Math.min(count, 6)) : undefined;
  };
  const language = () => props.language ?? "text";
  const hasHeader = () => Boolean(props.title || props.copy !== false);

  return (
    <div class={`k2b-content-code-display ${props.class ?? ""}`}>
      <Show when={hasHeader()}>
        <div class="k2b-content-code-display__header">
          <Show when={props.title}>{(title) => <p class="k2b-content-code-display__title">{title()}</p>}</Show>
          <Show when={props.copy !== false}>
            <CopyButton text={props.code} />
          </Show>
        </div>
      </Show>

      <div
        class="k2b-content-code-display__body"
        data-header={hasHeader() ? "true" : undefined}
        data-digits={digits()}
        role="region"
        aria-label={props.title ? `${props.title} code` : `${language()} code`}
        tabIndex={0}
      >
        <div class="k2b-content-code-display__lines">
          <For each={lines()}>
            {(line, index) => (
              <div class="k2b-content-code-display__line" data-numbered={lineNumbers() ? "true" : undefined}>
                <Show when={lineNumbers()}>
                  <span class="k2b-content-code-display__number">{startLine() + index()}</span>
                </Show>
                <code innerHTML={line || " "} />
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
