import { marked, Renderer, type Tokens } from "marked";

type CommonProps = MarkdownRenderOptions & {
  /** Optional additional CSS classes */
  class?: string;
  /**
   * Visual heading scale. Markdown heading levels and document structure stay
   * unchanged.
   */
  headingScale?: "compact" | "normal" | "large";
};

export type MarkdownViewProps = CommonProps &
  (
    | {
        /** Untrusted Markdown. Raw HTML and unsafe link protocols are escaped. */
        markdown: string;
        /** Exact standalone text tokens to emphasize without changing Markdown parsing or trusted-HTML boundaries. */
        inlineTokens?: readonly string[];
        trustedHtml?: never;
      }
    | {
        /** Explicitly trusted, already-rendered HTML. The caller owns sanitization. */
        trustedHtml: string;
        markdown?: never;
        inlineTokens?: never;
      }
  );

export type MarkdownRenderOptions = {
  inlineTokens?: readonly string[];
  /** Whether to render images. False renders alt text without resource requests. Defaults to true. */
  allowImages?: boolean;
  /** Optional protocol allowlist, including trailing colons. Relative URLs resolve as HTTPS. */
  linkProtocols?: readonly string[];
  linkTarget?: "_blank";
};

const escapeHtml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const safeUrl = (value: string): string | null => {
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, "");
  if (/^(?:javascript|vbscript|data):/i.test(normalized)) return null;
  return value;
};

const normalizeInlineTokens = (tokens: readonly string[] | undefined): string[] =>
  [...new Set(tokens?.filter(Boolean) ?? [])].sort((left, right) => right.length - left.length);

const isStandaloneInlineToken = (text: string, start: number, value: string): boolean => {
  const before = text[start - 1];
  if (before && /[a-zA-Z0-9_.%+\-]/.test(before)) return false;
  const end = start + value.length;
  const after = text[end];
  if (after && /[a-zA-Z0-9_@]/.test(after)) return false;
  return !(after === "." && /[a-zA-Z0-9_]/.test(text[end + 1] ?? ""));
};

const createSafeRenderer = (options: MarkdownRenderOptions = {}): Renderer => {
  const renderer = new Renderer();
  const inlineTokens = normalizeInlineTokens(options.inlineTokens);
  const renderText = renderer.text.bind(renderer);
  renderer.html = ({ text }: Tokens.HTML | Tokens.Tag) => escapeHtml(text);
  renderer.link = function ({ href, title, tokens }: Tokens.Link) {
    const body = this.parser.parseInline(tokens);
    const url = safeUrl(href);
    if (!url) return body;
    if (options.linkProtocols) {
      try {
        if (!options.linkProtocols.includes(new URL(url, "https://markdown.invalid/").protocol)) return body;
      } catch {
        return body;
      }
    }
    const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
    const target = options.linkTarget === "_blank" ? ' target="_blank" rel="noopener noreferrer"' : "";
    return `<a href="${escapeHtml(url)}"${titleAttribute}${target}>${body}</a>`;
  };
  renderer.image = ({ href, title, text }: Tokens.Image) => {
    const url = safeUrl(href);
    if (!url || options.allowImages === false) return escapeHtml(text);
    const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
    return `<img src="${escapeHtml(url)}" alt="${escapeHtml(text)}"${titleAttribute}>`;
  };
  renderer.text = (token) => {
    if (inlineTokens.length === 0 || token.type === "escape" || ("tokens" in token && token.tokens)) return renderText(token);
    const parts: string[] = [];
    let plainStart = 0;
    let cursor = 0;
    while (cursor < token.text.length) {
      const inlineToken = inlineTokens.find(
        (candidate) => token.text.startsWith(candidate, cursor) && isStandaloneInlineToken(token.text, cursor, candidate),
      );
      if (!inlineToken) {
        cursor += 1;
        continue;
      }
      if (plainStart < cursor) {
        const text = token.text.slice(plainStart, cursor);
        parts.push(renderText({ ...token, raw: text, text }));
      }
      parts.push(
        `<span class="k2b-content-markdown__inline-token">${renderText({ ...token, raw: inlineToken, text: inlineToken })}</span>`,
      );
      cursor += inlineToken.length;
      plainStart = cursor;
    }
    if (plainStart === 0) return renderText(token);
    if (plainStart < token.text.length) {
      const text = token.text.slice(plainStart);
      parts.push(renderText({ ...token, raw: text, text }));
    }
    return parts.join("");
  };
  return renderer;
};

export const renderSafeMarkdown = (markdown: string, options: MarkdownRenderOptions = {}): string =>
  marked.parse(markdown, {
    async: false,
    renderer: createSafeRenderer(options),
  }) as string;

/**
 * Markdown View Component (SSR)
 *
 * Renders untrusted Markdown safely by default. Raw HTML and unsafe link
 * protocols are escaped. Already-rendered HTML requires the deliberately named
 * `trustedHtml` boundary; the caller owns sanitization in that mode.
 *
 * @example
 * ```tsx
 * import { MarkdownView } from "@k2b/ui";
 *
 * <MarkdownView markdown={source} />;
 * ```
 *
 * @example Compact headings, e.g. inside comments or file previews:
 * ```tsx
 * <MarkdownView markdown={source} headingScale="compact" />;
 * ```
 */
export default function MarkdownView(props: MarkdownViewProps) {
  const html = () =>
    props.markdown !== undefined
      ? renderSafeMarkdown(props.markdown, {
          inlineTokens: props.inlineTokens,
          allowImages: props.allowImages,
          linkProtocols: props.linkProtocols,
          linkTarget: props.linkTarget,
        })
      : props.trustedHtml;
  return (
    <div
      class={`k2b-content-markdown ${props.class ?? ""}`}
      data-heading-scale={props.headingScale && props.headingScale !== "normal" ? props.headingScale : undefined}
      innerHTML={html()}
    />
  );
}
