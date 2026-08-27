import { For, type JSX, Show } from "solid-js";
import CopyButton from "../actions/CopyButton";
import { useUiMessages } from "../intl/messages";
import type { CodeDisplayLanguage } from "./CodeDisplay";
import { highlightCodeDisplayLines } from "./code-highlight";

export type DocCodeHighlighter = (code: string) => string;

export type DocCodeProps = {
  code: string;
  title?: string;
  language?: CodeDisplayLanguage;
  highlight?: DocCodeHighlighter;
  format?: (code: string) => string;
  copy?: boolean;
  copyText?: string;
  lineNumbers?: boolean;
  class?: string;
};

export type DocNoteVariant = "info" | "tip" | "warning";

export type DocRow = {
  title: string;
  icon?: string;
  text: JSX.Element;
};

export type DocConcept = {
  title: string;
  icon: string;
  text: JSX.Element;
};

export const DocPage = (props: { children: JSX.Element; class?: string }) => (
  <div class={`k2b-content-docs ${props.class ?? ""}`}>{props.children}</div>
);

export const DocLead = (props: { children: JSX.Element }) => <p class="k2b-content-doc-lead">{props.children}</p>;

export const DocSection = (props: { title: string; eyebrow?: string; children: JSX.Element }) => (
  <section class="k2b-content-doc-section">
    <div>
      <Show when={props.eyebrow}>{(eyebrow) => <p class="k2b-content-doc-eyebrow">{eyebrow()}</p>}</Show>
      <h2 class="k2b-content-doc-title">{props.title}</h2>
    </div>
    {props.children}
  </section>
);

export const DocInlineCode = (props: { children: JSX.Element }) => <code class="k2b-content-doc-inline-code">{props.children}</code>;

export const DocCode = (props: DocCodeProps) => {
  const messages = useUiMessages();
  const code = () => props.format?.(props.code) ?? props.code;
  const lineNumbers = () => props.lineNumbers ?? false;
  const hasHeader = () => Boolean(props.title || props.copy);
  const lines = () => {
    const formatted = code();
    if (props.highlight) return formatted.split("\n").map((line) => props.highlight?.(line || " ") ?? "");
    return highlightCodeDisplayLines(formatted, props.language ?? "text");
  };

  return (
    <div class={`k2b-content-doc-code ${props.class ?? ""}`}>
      <Show when={hasHeader()}>
        <div class="k2b-content-doc-code__header">
          <Show when={props.title}>{(title) => <p class="k2b-content-doc-code__title">{title()}</p>}</Show>
          <Show when={props.copy}>
            <CopyButton text={props.copyText ?? code()} />
          </Show>
        </div>
      </Show>
      <div
        class="k2b-content-doc-code__body"
        data-header={hasHeader() ? "true" : undefined}
        tabIndex={0}
        role="region"
        aria-label={props.title ? messages().codeLabel({ title: props.title }) : messages().code}
      >
        <div class="k2b-content-doc-code__lines">
          <For each={lines()}>
            {(line, index) => (
              <div class="k2b-content-doc-code__line" data-numbered={lineNumbers() ? "true" : undefined}>
                <Show when={lineNumbers()}>
                  <span class="k2b-content-doc-code__number">{index() + 1}</span>
                </Show>
                <code innerHTML={line || " "} />
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
};

export const DocConceptGrid = (props: { items: DocConcept[] }) => (
  <div class="k2b-content-doc-concepts">
    <For each={props.items}>
      {(item) => (
        <div class="k2b-content-doc-concept">
          <i class={`ti ${item.icon} k2b-content-doc-icon`} aria-hidden="true" />
          <div>
            <p class="k2b-content-doc-item-title">{item.title}</p>
            <p class="k2b-content-doc-item-text">{item.text}</p>
          </div>
        </div>
      )}
    </For>
  </div>
);

export const DocRows = (props: { items: DocRow[] }) => (
  <div class="k2b-content-doc-rows">
    <For each={props.items}>
      {(item) => (
        <article class="k2b-content-doc-row">
          <Show when={item.icon} fallback={<span aria-hidden="true" />}>
            {(icon) => <i class={`ti ${icon()} k2b-content-doc-icon`} aria-hidden="true" />}
          </Show>
          <p class="k2b-content-doc-item-title">{item.title}</p>
          <div class="k2b-content-doc-item-text">{item.text}</div>
        </article>
      )}
    </For>
  </div>
);

export const DocNote = (props: { title: string; variant?: DocNoteVariant; children: JSX.Element }) => {
  const variant = () => props.variant ?? "info";
  return (
    <aside class="k2b-content-doc-note" data-variant={variant()}>
      <p class="k2b-content-doc-note__title">{props.title}</p>
      <div class="k2b-content-doc-note__body">{props.children}</div>
    </aside>
  );
};
