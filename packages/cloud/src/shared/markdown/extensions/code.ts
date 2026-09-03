/**
 * Code extension for marked
 *
 * Renders code blocks and inline code with consistent styling.
 * Uses the dependency-free stdlib highlighter for common languages. Custom
 * documentation languages stay shallow on purpose: highlighting must never
 * change source text or require a browser-side parser.
 */

import { type Highlighter, highlight } from "@k2b/stdlib";
import type { MarkedExtension, Tokens } from "marked";
import { escapeHtml } from "../shared";

const gqlHighlighter = highlight.compile([
  { kind: "comment", match: /#[^\n]*/ },
  { kind: "string", match: /"""[\s\S]*?"""|"(?:\\[\s\S]|[^"\\])*"/ },
  { kind: "variable", match: /\$[a-zA-Z_][a-zA-Z0-9_]*/ },
  {
    kind: "keyword",
    match: /\b(?:query|mutation|subscription|fragment|on|type|input|enum|interface|union|scalar|schema|extend|directive)\b/,
  },
  { kind: "number", match: /\b-?\d+(?:\.\d+)?\b/ },
  { kind: "operator", match: /[!$():=@[\]{|}]+/ },
]);

const yamlHighlighter = highlight.compile([
  { kind: "comment", match: /#[^\n]*/ },
  { kind: "string", match: /"(?:\\[\s\S]|[^"\\])*"|'(?:''|[^'])*'/ },
  { kind: "variable", match: /[&*!][a-zA-Z_][a-zA-Z0-9_-]*/ },
  { kind: "keyword", match: /\b(?:true|false|null|yes|no|on|off)\b/i },
  { kind: "number", match: /\b-?\d+(?:\.\d+)?\b/ },
  { kind: "operator", match: /---|\.\.\.|[|>{}[\],:&*!?-]+/ },
]);

const languageHighlighters: Readonly<Record<string, Highlighter>> = {
  bash: highlight.presets.shell,
  gql: gqlHighlighter,
  graphql: gqlHighlighter,
  javascript: highlight.presets.code,
  js: highlight.presets.code,
  jsx: highlight.presets.code,
  script: highlight.presets.code,
  sh: highlight.presets.shell,
  shell: highlight.presets.shell,
  ts: highlight.presets.code,
  tsx: highlight.presets.code,
  typescript: highlight.presets.code,
  yaml: yamlHighlighter,
  yml: yamlHighlighter,
  zsh: highlight.presets.shell,
};

const renderCode = (source: string, language?: string): string => {
  const highlighter = language ? languageHighlighters[language.toLowerCase()] : undefined;
  return highlighter ? highlighter(source) : escapeHtml(source);
};

export function codeExtension(): MarkedExtension {
  return {
    renderer: {
      code(token: Tokens.Code): string {
        const { text, lang } = token;
        const langLower = lang?.toLowerCase();
        const renderedCode = renderCode(text, langLower);
        const isMermaid = langLower === "mermaid";

        // Language class for syntax highlighting / mermaid detection
        const langClass = lang ? ` language-${escapeHtml(lang)}` : "";

        // Special rendering for mermaid blocks with fixed height container
        if (isMermaid) {
          return (
            `<div class="md-mermaid-block my-3 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800" style="height: 400px;">` +
            `<div class="h-full w-full flex items-center justify-center p-4">` +
            `<pre class="hidden"><code class="language-mermaid">${renderedCode}</code></pre>` +
            `<div class="md-mermaid-loading text-dimmed text-sm flex items-center gap-2">` +
            `<i class="ti ti-loader-2 animate-spin"></i> Loading diagram...` +
            `</div>` +
            `</div>` +
            `</div>`
          );
        }

        // Language badge if specified
        const langBadge = lang
          ? `<span class="absolute top-2 right-2 text-xs text-gray-400 dark:text-gray-500 font-mono select-none">${escapeHtml(lang)}</span>`
          : "";

        return (
          `<div class="md-code-block relative my-3">` +
          langBadge +
          `<pre class="bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-md p-4 overflow-x-auto">` +
          `<code class="text-sm font-mono text-gray-800 dark:text-gray-200 whitespace-pre${langClass}">${renderedCode}</code>` +
          `</pre>` +
          `</div>`
        );
      },

      codespan(token: Tokens.Codespan): string {
        const escapedCode = escapeHtml(token.text);
        return `<code class="bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 px-1.5 py-0.5 rounded text-sm font-mono">${escapedCode}</code>`;
      },
    },
  };
}
