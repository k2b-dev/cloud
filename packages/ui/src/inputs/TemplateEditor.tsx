import { createMemo, For, type JSX } from "solid-js";
import { useUiMessages } from "../intl/messages";
import { PANES_LAYOUT_VERSION, type PanesLayout } from "../layout/panes-layout";
import { AutocompleteEditor, type AutocompleteEditorProps } from "./AutocompleteEditor";
import type { Completion, Suggestion } from "./completion";
import { TextInput } from "./TextInput";

export type TemplateVariableKind = "string" | "email" | "url" | "number" | "boolean" | "array" | "object";

export type TemplateVariable = {
  name: string;
  kind?: TemplateVariableKind;
  description?: string;
};

export type TemplateEditorProps = Omit<AutocompleteEditorProps, "completions" | "highlight"> & {
  variables: readonly TemplateVariable[];
};

export type TemplatePreviewProps = {
  html: string;
  title?: string;
  class?: string;
};

export type TemplateSampleDataProps = {
  variables: readonly TemplateVariable[];
  values: Readonly<Record<string, string>>;
  onValueChange: (name: string, value: string) => void;
  class?: string;
};

export type TemplateEditorLayout = PanesLayout;

export const createTemplateEditorPanesLayout = (): TemplateEditorLayout => ({
  version: PANES_LAYOUT_VERSION,
  root: {
    type: "split",
    direction: "horizontal",
    ratio: 0.5,
    first: { type: "group", items: ["html"], active: "html" },
    second: { type: "group", items: ["preview", "sample-data"], active: "preview" },
  },
});

const HTML_TAGS = [
  { name: "p", snippet: "<p></p>", hint: "paragraph" },
  {
    name: "a",
    snippet: '<a href="{{ LOGIN_URL }}">Link</a>',
    hint: "link",
  },
  { name: "strong", snippet: "<strong></strong>", hint: "bold" },
  { name: "em", snippet: "<em></em>", hint: "emphasis" },
  { name: "br", snippet: "<br>", hint: "line break" },
  { name: "ul", snippet: "<ul>\n  <li></li>\n</ul>", hint: "list" },
  {
    name: "table",
    snippet: "<table>\n  <tr><td></td></tr>\n</table>",
    hint: "table",
  },
] as const;

const suggestion = (text: string, hint: string, label?: string): Suggestion => ({ text, hint, label, appendSpace: false });

const templateCompletions = (variables: readonly TemplateVariable[]): Completion[] => [
  {
    trigger: "{",
    dropdown: true,
    allowAfterWord: true,
    suggest: (query, context) => {
      const normalized = query.toLowerCase();
      const leadingBrace = context.tokenStart > 0 && context.fullText[context.tokenStart - 1] === "{";
      const open = leadingBrace ? "{ " : "{{ ";
      const close = leadingBrace ? " }}" : " }}";
      const values = variables
        .filter((variable) => variable.name.toLowerCase().startsWith(normalized))
        .map((variable) => suggestion(`${open}${variable.name}${close}`, variable.kind ?? "string", variable.name));
      const conditions = variables
        .filter((variable) => variable.kind !== "array")
        .filter((variable) => variable.name.toLowerCase().startsWith(normalized))
        .map((variable) => suggestion(`{% if ${variable.name} != blank %}\n  \n{% endif %}`, "condition", `if ${variable.name}`));
      const loops = variables
        .filter((variable) => variable.kind === "array")
        .filter((variable) => variable.name.toLowerCase().startsWith(normalized))
        .map((variable) => suggestion(`{% for item in ${variable.name} %}\n  {{ item }}\n{% endfor %}`, "loop", `for ${variable.name}`));
      return [...values, ...conditions, ...loops];
    },
  },
  {
    trigger: "%",
    dropdown: true,
    allowAfterWord: true,
    suggest: (query) => {
      const normalized = query.toLowerCase();
      const conditions = variables
        .filter((variable) => variable.kind !== "array")
        .filter((variable) => variable.name.toLowerCase().startsWith(normalized))
        .map((variable) => suggestion(`% if ${variable.name} != blank %}\n  \n{% endif %}`, "condition", `if ${variable.name}`));
      const loops = variables
        .filter((variable) => variable.kind === "array")
        .filter((variable) => variable.name.toLowerCase().startsWith(normalized))
        .map((variable) => suggestion(`% for item in ${variable.name} %}\n  {{ item }}\n{% endfor %}`, "loop", `for ${variable.name}`));
      return [...conditions, ...loops];
    },
  },
  {
    trigger: "<",
    dropdown: true,
    allowAfterWord: true,
    suggest: (query) => {
      const normalized = query.toLowerCase();
      return HTML_TAGS.filter((tag) => tag.name.startsWith(normalized)).map((tag) => suggestion(tag.snippet, tag.hint, tag.name));
    },
  },
];

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const highlightLiquidToken = (token: string): string => {
  const inner = token.replace(/^\{\{|\}\}$|^\{%|\%}$/g, "").trim();
  const keyword = inner.split(/\s+/)[0] ?? "";
  const kind = token.startsWith("{%") ? (keyword.startsWith("end") ? "end" : "control") : inner.includes("| raw") ? "raw" : "value";
  return `<span class="k2b-template-token" data-kind="${kind}">${escapeHtml(token)}</span>`;
};

const highlightTag = (tag: string): string => {
  const match = tag.match(/^(&lt;\/?)([a-zA-Z][\w:-]*)([\s\S]*?)(&gt;)$/);
  if (!match) return `<span class="k2b-template-tag">${tag}</span>`;
  const attrs = (match[3] ?? "").replace(
    /([\w:-]+)(=)(&quot;[\s\S]*?&quot;|'[\s\S]*?'|[^\s&]+)/g,
    '<span class="k2b-template-attribute">$1</span><span class="k2b-template-punctuation">$2</span><span class="k2b-template-string">$3</span>',
  );
  return `<span class="k2b-template-punctuation">${match[1]}</span><span class="k2b-template-tag">${match[2]}</span>${attrs}<span class="k2b-template-punctuation">${match[4]}</span>`;
};

const highlightTemplate = (text: string): string => {
  const stashed: string[] = [];
  const escaped = escapeHtml(text).replace(/{{[\s\S]*?}}|{%[\s\S]*?%}/g, (token) => {
    const marker = `\uE000${stashed.length}\uE001`;
    stashed.push(highlightLiquidToken(token));
    return marker;
  });
  const withTags = escaped.replace(/&lt;!--[\s\S]*?--&gt;|&lt;\/?[a-zA-Z][\s\S]*?&gt;/g, (tag) =>
    tag.startsWith("&lt;!--") ? `<span class="k2b-template-comment">${tag}</span>` : highlightTag(tag),
  );
  return withTags.replace(/\uE000(\d+)\uE001/g, (_, index) => stashed[Number(index)] ?? "");
};

export function TemplateEditor(props: TemplateEditorProps): JSX.Element {
  const messages = useUiMessages();
  const completions = createMemo(() => templateCompletions(props.variables));
  return (
    <AutocompleteEditor
      {...props}
      lines={props.lines ?? 22}
      spellcheck={props.spellcheck ?? false}
      placeholder={props.placeholder ?? messages().templateEditorPlaceholder}
      highlight={highlightTemplate}
      completions={completions()}
    />
  );
}

export function TemplatePreview(props: TemplatePreviewProps): JSX.Element {
  const messages = useUiMessages();
  return (
    <section class={`k2b-template-preview ${props.class ?? ""}`}>
      <iframe sandbox="" srcdoc={props.html} title={props.title ?? messages().templatePreview} />
    </section>
  );
}

export function TemplateSampleData(props: TemplateSampleDataProps): JSX.Element {
  return (
    <section class={`k2b-template-sample ${props.class ?? ""}`}>
      <For each={props.variables}>
        {(variable) => (
          <TextInput
            label={`{{ ${variable.name} }}`}
            description={variable.description}
            value={props.values[variable.name] ?? ""}
            onValueChange={(value) => props.onValueChange(variable.name, value)}
          />
        )}
      </For>
    </section>
  );
}
