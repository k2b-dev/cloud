import { dates, highlight, text } from "@k2b/stdlib";
import { NOTICE_CARD_CLASSES, NOTICE_CARD_ICONS, type NoticeTone } from "@k2b/ui";
import katex from "katex";
import { Marked, Renderer } from "marked";
import sanitizeHtml from "sanitize-html";
import { renderPrettyTableHtml } from "../frontend/lib/pretty-table";
import type { NoteQueryResult } from "../service/note-query";
import { bookRendererMessages } from "./book-renderer-messages";
import { extractNamedBlocks, type NamedDataValue, parseNamedDataBlockResult } from "./named-blocks";
import { parseNotebookQueryBlocks, parseNotebookTocBlocks, type QueryBlock, type QueryField } from "./query-blocks";

export type BookHeading = { id: string; depth: number; text: string };

export type NotebookBookInput = {
  markdown: string;
  notebookId: string;
  locale: string;
  /** Authorized results from the service, keyed by the query's one-based source line. */
  queryResults?: ReadonlyMap<number, NoteQueryResult>;
};

const escape = highlight.escape;
const NOTICE_TONES = { note: "neutral", info: "info", success: "success", warning: "warning", danger: "danger" } as const;
type NoticeKind = keyof typeof NOTICE_TONES;

/** Reject scheme smuggling, protocol-relative URLs and browser-normalized backslashes. */
const safeUrl = (raw: string, image = false): string | null => {
  const url = raw.trim();
  if (!url || /[\u0000-\u0020\u007f-\u009f\\]/u.test(url) || url.startsWith("//")) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(url) && !(image ? /^https?:/i : /^(?:https?|mailto|tel):/i).test(url)) return null;
  return url;
};

const bookHref = (href: string): string => {
  if (!/^\/app\/notebooks\/[A-Za-z0-9]+(?:\/|\?|#|$)/.test(href)) return href;
  const url = new URL(href, "https://notebooks.invalid");
  url.searchParams.set("mode", "book");
  return `${url.pathname}${url.search}${url.hash}`;
};

/**
 * The application-owned Book renderer. No browser state, CodeMirror, database
 * access or executable notebook scripts. Only authorized query snapshots enter
 * here; both SSR and future refresh endpoints can use this same function.
 */
export const renderNotebookBook = (input: NotebookBookInput): { html: string; headings: BookHeading[] } => {
  const markdown = input.markdown.replace(/\r\n?/g, "\n");
  const { locale, t } = bookRendererMessages.resolve([input.locale]);
  const notebookId = encodeURIComponent(input.notebookId);
  const headings: BookHeading[] = [];
  const usedIds = new Set<string>();
  const queries = new Map(parseNotebookQueryBlocks(markdown).blocks.map((block) => [block.line, block]));
  const tocs = new Map(parseNotebookTocBlocks(markdown).blocks.map((block) => [block.line, block]));
  const namedBlocks = extractNamedBlocks(markdown);
  const handles = new Map(namedBlocks.map((block) => [block.line, block]));
  const dataNames = new Map(namedBlocks.filter((block) => block.type === "data").map((block) => [block.startLine, block.name]));
  const slots: Array<() => string> = [];
  const mathSlots: string[] = [];
  const mathLabels: string[] = [];
  // Markers never reach the output. Unpredictability also prevents a Markdown
  // entity or escape from reconstructing an authored marker during parsing.
  const prefix = `NOTEBOOKBOOKSLOT${crypto.randomUUID().replaceAll("-", "")}`;
  const anchorId = (base: string): string => {
    let id = base;
    for (let suffix = 2; usedIds.has(id); suffix++) id = `${base}-${suffix}`;
    usedIds.add(id);
    return id;
  };
  const slot = (render: () => string) => `${prefix}${slots.push(render) - 1}`;
  const diagnostic = (line: number) => `<p class="notebook-book-diagnostic" role="status">${escape(t.invalidBlock({ line }))}</p>`;
  const source = (code: string, language = "") =>
    `<pre><code${language ? ` class="language-${escape(language)}"` : ""}>${escape(code)}</code></pre>`;

  const renderMath = (latex: string, displayMode: boolean): string => {
    try {
      // KaTeX is a trusted HTML generator with all author-controlled HTML and
      // URL commands disabled. Keep its own exact layout styles and MathML.
      const html = katex.renderToString(latex, { displayMode, throwOnError: false, trust: false, strict: "error", maxExpand: 1_000 });
      mathSlots.push(`<${displayMode ? "div" : "span"} class="notebook-book-math">${html}</${displayMode ? "div" : "span"}>`);
      mathLabels.push(latex);
      return `${prefix}MATH${mathSlots.length - 1}END`;
    } catch {
      return `<code>${escape(latex)}</code>`;
    }
  };

  const resolveUrl = (raw: string, image = false): string | null => {
    const attachmentId = /^attach:\/\/([A-Za-z0-9]{6})$/.exec(raw)?.[1];
    if (attachmentId) return `/api/notebooks/${notebookId}/attachments/${attachmentId}/content?v=1`;
    const noteId = /^note:\/\/([A-Za-z0-9]{6})$/.exec(raw)?.[1];
    if (noteId && !image) return `/app/notebooks/${notebookId}/notes/${noteId}?mode=book`;
    const url = safeUrl(raw, image);
    return url && !image ? bookHref(url) : url;
  };
  const tag = (value: string) =>
    `<a class="notebook-book-tag" href="/app/notebooks/${notebookId}/tags/${encodeURIComponent(value.toLowerCase())}?mode=book">#${escape(value)}</a>`;
  const valueHtml = (value: NamedDataValue | null | undefined): string => {
    if (value === null || value === undefined) return "—";
    if (Array.isArray(value)) return value.map((item) => `<span class="md-data-chip">${escape(String(item))}</span>`).join(" ");
    return escape(String(value));
  };
  const columnTitle = (field: QueryField) => {
    if (field === "$title") return t.title;
    if (field === "$created") return t.created;
    if (field === "$updated") return t.updated;
    if (field === "$tags") return t.tags;
    return field;
  };
  const renderQuery = (query: QueryBlock): string => {
    const result = input.queryResults?.get(query.line);
    if (!result || result.diagnostics.length) return `<p class="notebook-book-diagnostic" role="status">${escape(t.unavailableQuery)}</p>`;
    if (!result.items.length) return `<p class="notebook-book-empty">${escape(t.emptyQuery)}</p>`;
    const link = (item: NoteQueryResult["items"][number]) => {
      const href = resolveUrl(item.href);
      return href ? `<a href="${escape(href)}">${escape(item.title)}</a>` : escape(item.title);
    };
    const body =
      query.columns.length === 0
        ? `<ul>${result.items.map((item) => `<li>${link(item)}</li>`).join("")}</ul>`
        : `<div class="md-table-wrap"><table class="md-table"><thead><tr>${query.columns.map((field) => `<th scope="col">${escape(columnTitle(field))}</th>`).join("")}</tr></thead><tbody>${result.items
            .map(
              (item) =>
                `<tr>${query.columns
                  .map((field) => {
                    const value = item.values[field];
                    let html = valueHtml(value);
                    if (field === "$title") html = link(item);
                    else if (field === "$tags" && Array.isArray(value)) html = value.map((entry) => tag(String(entry))).join(" ");
                    else if (
                      (field === "$created" || field === "$updated") &&
                      typeof value === "string" &&
                      Number.isFinite(Date.parse(value))
                    ) {
                      html = `<time datetime="${escape(value)}">${escape(dates.formatDateTime(value, { locale }))}</time>`;
                    }
                    return `<td>${html}</td>`;
                  })
                  .join("")}</tr>`,
            )
            .join("")}</tbody></table></div>`;
    const count = result.truncated
      ? `<p class="notebook-book-empty">${escape(t.queryCount({ shown: result.items.length, total: result.total }))}</p>`
      : "";
    return `<div class="notebook-book-query">${body}${count}</div>`;
  };

  let insideLink = false;
  const renderer = new Renderer();
  renderer.html = ({ text: html }) => escape(html);
  renderer.heading = function ({ depth, tokens }) {
    const body = this.parser.parseInline(tokens);
    const title = sanitizeHtml(body, { allowedTags: [], allowedAttributes: {} })
      .replace(new RegExp(`${prefix}MATH(\\d+)END`, "g"), (_raw, index: string) => mathLabels[Number(index)] ?? "")
      .replace(
        /&(amp|lt|gt|quot|#39);/g,
        (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" })[entity] ?? entity,
      );
    const base = `heading-${text.slugify(title) || "section"}`;
    const id = anchorId(base);
    headings.push({ id, depth, text: title });
    return `<h${depth} id="${id}">${body}</h${depth}>\n`;
  };
  renderer.link = function ({ href, title, tokens }) {
    const wasInsideLink = insideLink;
    insideLink = true;
    const body = this.parser.parseInline(tokens);
    insideLink = wasInsideLink;
    const url = resolveUrl(href);
    if (!url) return body;
    return `<a href="${escape(url)}"${title ? ` title="${escape(title)}"` : ""}${/^https?:/i.test(url) ? ' rel="noopener noreferrer"' : ""}>${body}</a>`;
  };
  renderer.image = ({ href, title, text: alt }) => {
    const url = resolveUrl(href, true);
    if (!url) return escape(alt);
    return `<img class="notebook-book-image" src="${escape(url)}" alt="${escape(alt)}" loading="lazy"${title ? ` title="${escape(title)}"` : ""}>`;
  };
  renderer.code = ({ text: code, lang }) => {
    const language = lang?.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (language === "math") return renderMath(code, true);
    if (language === "mermaid")
      return `<figure class="notebook-book-mermaid"><figcaption>${escape(t.diagramSource)}</figcaption>${source(code, "mermaid")}</figure>`;
    const colored = /^(?:js|jsx|ts|tsx|javascript|typescript|script|json|java|cpp|c|go|rust|python|py)$/.test(language)
      ? highlight.presets.code(code)
      : /^(?:bash|sh|shell|zsh)$/.test(language)
        ? highlight.presets.shell(code)
        : language === "sql"
          ? highlight.presets.sql(code)
          : escape(code);
    return `<pre><code${language ? ` class="language-${escape(language)}"` : ""}>${colored}</code></pre>`;
  };
  renderer.table = ({ header, rows, align }) =>
    renderPrettyTableHtml(
      { headers: header.map((cell) => cell.text), rows: rows.map((row) => row.map((cell) => cell.text)), align },
      { notebookId: input.notebookId, locale },
    );
  const marked = new Marked({ gfm: true, breaks: true, renderer });
  marked.use({
    extensions: [
      {
        name: "bookSlot",
        level: "block",
        start: (src) => src.indexOf(prefix),
        tokenizer(src) {
          const match = new RegExp(`^${prefix}(\\d+)(?:\\n|$)`).exec(src);
          return match ? { type: "bookSlot", raw: match[0], index: Number(match[1]) } : undefined;
        },
        renderer: (token) => slots[Number(token.index)]?.() ?? "",
      },
      {
        name: "bookBlockMath",
        level: "block",
        start: (src) => src.search(/(?:^|\n)(?:\$\$|\\\[)/),
        tokenizer(src) {
          const match = /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])(?:\n|$)/.exec(src);
          return match ? { type: "bookBlockMath", raw: match[0], latex: match[1] ?? match[2] } : undefined;
        },
        renderer: (token) => renderMath(String(token.latex), true),
      },
      {
        name: "bookInlineMath",
        level: "inline",
        start: (src) => src.search(/\$(?!\$)|\\\(/),
        tokenizer(src) {
          const match = /^(?:\$(?!\$)([^$\n]+)\$(?!\$)|\\\(([^\n]*?)\\\))/.exec(src);
          return match ? { type: "bookInlineMath", raw: match[0], latex: match[1] ?? match[2] } : undefined;
        },
        renderer: (token) => renderMath(String(token.latex), false),
      },
      {
        name: "bookInline",
        level: "inline",
        start: (src) => src.search(/==|(?<!~)~(?!~)|\^|(?:^|\s)#[A-Za-z]/),
        tokenizer(src) {
          const formatting = /^(?:==([^\n]+?)==|~([^~\s]+)~|\^([^\^\s]+)\^)/.exec(src);
          if (formatting)
            return {
              type: "bookInline",
              raw: formatting[0],
              tag: formatting[1] ? "mark" : formatting[2] ? "sub" : "sup",
              body: formatting[1] ?? formatting[2] ?? formatting[3],
            };
          const hash = /^(\s*)#([A-Za-z][\w-]*(?:\/[\w-]+)*)/.exec(src);
          return hash ? { type: "bookInline", raw: hash[0], hash: hash[2], prefix: hash[1] } : undefined;
        },
        renderer(token) {
          if (token.hash) return `${String(token.prefix)}${insideLink ? escape(`#${token.hash}`) : tag(String(token.hash))}`;
          return `<${token.tag}>${escape(String(token.body))}</${token.tag}>`;
        },
      },
      {
        // CodeMirror already accepts Pandoc-style image dimensions.
        name: "bookSizedImage",
        level: "inline",
        start: (src) => src.indexOf("!["),
        tokenizer(src) {
          const match = /^!\[([^\]\n]*)\]\(([^\s)]+)\s+=(\d+)?x(\d+)?\)/.exec(src);
          return match && (match[3] || match[4])
            ? { type: "bookSizedImage", raw: match[0], alt: match[1], href: match[2], width: match[3], height: match[4] }
            : undefined;
        },
        renderer(token) {
          const url = resolveUrl(String(token.href), true);
          return url
            ? `<img class="notebook-book-image" src="${escape(url)}" alt="${escape(String(token.alt))}" loading="lazy"${token.width ? ` width="${token.width}"` : ""}${token.height ? ` height="${token.height}"` : ""}>`
            : escape(String(token.alt));
        },
      },
    ],
  });

  const lines = markdown.split("\n");
  const prepared: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const marker = line.trim().match(/^(`{3,}|~{3,})/)?.[1];
    if (marker) {
      if (!fence) fence = { marker: marker[0]!, length: marker.length };
      else if (marker[0] === fence.marker && marker.length >= fence.length) fence = undefined;
      prepared.push(line);
      continue;
    }
    if (fence) {
      prepared.push(line);
      continue;
    }
    const handle = handles.get(index);
    if (handle && handle.type !== "unknown") {
      if (handle.type !== "data")
        prepared.push(
          "",
          slot(() => `<div class="md-block-handle" id="${anchorId(`block-${handle.name}`)}">@${escape(handle.name)}</div>`),
          "",
        );
      continue;
    }
    const opener = /^:::(query|toc|data|note|info|success|warning|danger)\s*$/.exec(line.trim());
    if (!opener) {
      prepared.push(line);
      continue;
    }
    const kind = opener[1]!;
    const start = index;
    while (++index < lines.length && lines[index]!.trim() !== ":::") {
      /* bounded by the document */
    }
    const closed = index < lines.length;
    const body = lines.slice(start + 1, index).join("\n");
    prepared.push(
      "",
      slot(() => {
        if (!closed) return diagnostic(start + 1) + source(lines.slice(start, index).join("\n"));
        if (kind === "query") {
          const query = queries.get(start + 1);
          return query ? renderQuery(query) : diagnostic(start + 1) + source(body);
        }
        if (kind === "toc") return tocs.has(start + 1) ? `<div data-book-toc="${start + 1}"></div>` : diagnostic(start + 1) + source(body);
        if (kind === "data") {
          const data = parseNamedDataBlockResult(body);
          if (data.diagnostics.length) return diagnostic(start + 1) + source(body);
          const name = dataNames.get(start);
          const title = name ? `<div class="md-block-handle" id="${anchorId(`block-${name}`)}">@${escape(name)}</div>` : "";
          return `<div class="md-data-block">${title}${data.entries.length ? `<dl class="md-data-grid">${data.entries.map((entry) => `<div class="md-data-row"><dt class="md-data-key">${escape(text.humanize(entry.key))}</dt><dd class="md-data-value">${valueHtml(entry.value)}</dd></div>`).join("")}</dl>` : `<p class="notebook-book-empty">${escape(t.emptyData)}</p>`}</div>`;
        }
        const noticeKind = kind as NoticeKind;
        const tone: NoticeTone = NOTICE_TONES[noticeKind];
        return `<aside class="${NOTICE_CARD_CLASSES.root}" data-tone="${tone}"><div class="${NOTICE_CARD_CLASSES.inner}"><i class="${NOTICE_CARD_ICONS[tone]} ${NOTICE_CARD_CLASSES.icon}" aria-hidden="true"></i><div class="${NOTICE_CARD_CLASSES.content}"><p class="${NOTICE_CARD_CLASSES.title}">${escape(t[noticeKind])}</p><div class="${NOTICE_CARD_CLASSES.body}">${marked.parse(body, { async: false })}</div></div></aside>`;
      }),
      "",
    );
  }
  let html = marked.parse(prepared.join("\n"), { async: false });
  html = html.replace(/<div data-book-toc="(\d+)"><\/div>/g, (_raw, line: string) => {
    const toc = tocs.get(Number(line))!;
    const items = headings.filter((heading) => heading.depth >= toc.minDepth && heading.depth <= toc.maxDepth);
    return `<nav class="notebook-book-toc" aria-label="${escape(t.toc)}">${items.length ? `<ol>${items.map((heading) => `<li data-depth="${heading.depth}"><a href="#${heading.id}">${escape(heading.text)}</a></li>`).join("")}</ol>` : `<p class="notebook-book-empty">${escape(t.emptyToc)}</p>`}</nav>`;
  });
  html = sanitizeHtml(html, {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, "img", "input", "time", "mark", "del"],
    allowedAttributes: {
      "*": ["class", "id", "title", "role", "aria-hidden", "aria-label", "data-tone", "data-depth", "data-block-name"],
      a: ["href", "rel"],
      img: ["src", "alt", "loading", "width", "height"],
      input: ["type", "disabled", "checked"],
      span: ["style"],
      th: ["scope"],
      time: ["datetime"],
      ol: ["start"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["http", "https"] },
    allowProtocolRelative: false,
    allowedStyles: { span: { width: [/^\d+(?:\.\d+)?%$/] } },
    transformTags: {
      a: (_tag, attrs) => {
        const href = attrs.href ? resolveUrl(attrs.href) : null;
        const { href: _href, ...other } = attrs;
        return { tagName: "a", attribs: { ...other, ...(href ? { href } : {}) } };
      },
      input: (_tag, attrs) => ({
        tagName: "input",
        attribs: { type: "checkbox", disabled: "", ...(Object.hasOwn(attrs, "checked") ? { checked: "" } : {}) },
      }),
    },
  });
  html = html.replace(new RegExp(`${prefix}MATH(\\d+)END`, "g"), (_raw, index: string) => mathSlots[Number(index)] ?? "");
  return { html, headings };
};
