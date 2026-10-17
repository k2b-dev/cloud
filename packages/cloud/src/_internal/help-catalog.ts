import { i18n } from "@k2b/stdlib";
import { formatShortcut } from "@k2b/ui";
import type { Token } from "marked";
import type { HelpArticle } from "../services/help/types";
import { parseHelpReference } from "../shared/help";
import { lexHelpMarkdown, markdownToPlainText } from "../shared/markdown";

const helpAgentMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: { apple: ({ shortcut }: { shortcut: string }) => `${shortcut} on Mac` },
    de: { apple: ({ shortcut }) => `${shortcut} auf dem Mac` },
  },
});

const helpLinkLabel = (source: string, fallback: string): string => {
  // Index backtick runs once so unmatched runs cannot repeatedly scan the remaining source.
  const backticks = new Map<number, { positions: number[]; next: number }>();
  for (const run of source.matchAll(/`+/g)) {
    const length = run[0].length;
    if (!backticks.has(length)) backticks.set(length, { positions: [], next: 0 });
    backticks.get(length)!.positions.push(run.index);
  }
  let depth = 0;
  for (let index = 1; index < source.length; index++) {
    const char = source[index];
    if (char === "\\") index++;
    else if (char === "`") {
      let end = index + 1;
      while (source[end] === "`") end++;
      const length = end - index;
      const runs = backticks.get(length);
      if (runs) {
        while (runs.next < runs.positions.length && runs.positions[runs.next]! <= index) runs.next++;
      }
      const closing = runs?.positions[runs.next];
      index = closing === undefined ? end - 1 : closing + length - 1;
    } else if (char === "[") depth++;
    else if (char === "]") {
      if (depth === 0) return source.slice(1, index);
      depth--;
    }
  }
  return fallback;
};

/** Portable source for agents and Copy as Markdown; code is kept verbatim. */
export const helpAgentMarkdown = (
  article: Pick<HelpArticle, "markdown" | "locale" | "appId" | "links">,
  tokens: readonly Token[] = lexHelpMarkdown(article.markdown, article.locale),
): string => {
  const { t } = helpAgentMessages.resolve([article.locale]);
  const rewriteChildren = (raw: string, children: readonly Token[]): string => {
    let offset = 0;
    let result = "";
    for (const child of children) {
      let start = raw.indexOf(child.raw, offset);
      let source = child.raw;
      if (start < 0 && child.raw.includes("|")) {
        source = child.raw.replaceAll("|", "\\|");
        start = raw.indexOf(source, offset);
      }
      // Marked removes quote markers and list indentation from child block sources.
      if (start < 0 && child.raw.includes("\n")) {
        const pattern = child.raw
          .split("\n")
          .map((line, index) => (index > 0 ? line.replace(/^[ \t]+/, "") : line).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("\\r?\\n[ \\t>]*");
        const match = new RegExp(pattern).exec(raw.slice(offset));
        if (match) {
          start = offset + match.index;
          source = match[0];
        }
      }
      if (start < 0) break;
      result += raw.slice(offset, start) + rewrite(child, source);
      offset = start + source.length;
    }
    return result + raw.slice(offset);
  };
  const rewrite = (token: Token, source: string): string => {
    if (token.type === "code" || token.type === "codespan") return source;
    if (token.type === "helpKbd") {
      const keys = String(token.keys);
      const other = formatShortcut(keys, { platform: "other", locale: article.locale });
      const apple = formatShortcut(keys, { platform: "apple", locale: article.locale }).label;
      // Key labels such as | or ` stay text in a table cell or a sentence.
      const escape = (text: string) => text.replace(/[\\`*_[\]|<>~]/g, "\\$&");
      // A key without a platform modifier reads by its name: "Enter", not "↵".
      return other.label === apple ? escape(other.name) : `${escape(other.label)} (${t.apple({ shortcut: escape(apple) })})`;
    }
    if (token.type === "helpDetails") {
      const newline = source.includes("\r\n") ? "\r\n" : "\n";
      const bodyStart = source.indexOf("\n") + 1;
      const closing = [...source.matchAll(/^[ \t>]*:::[ \t]*(?:\r?\n|$)/gm)].at(-1)!;
      const body = source.slice(bodyStart, closing.index);
      const prefix = body.match(/^[ \t>]+/)?.[0] ?? "";
      const trailing = source.slice(closing.index + closing[0].length);
      return `**${rewriteChildren(String(token.title), token.titleTokens ?? [])}**${newline}${prefix}${newline}${rewriteChildren(body, token.tokens ?? [])}${trailing}`;
    }
    if (token.type === "helpLabel") return rewriteChildren(source.replace(/\{icon="[a-z0-9-]+"\}$/, ""), token.tokens ?? []);
    if (token.type === "link" && token.href.startsWith("help:")) {
      const ref = parseHelpReference(token.href.slice(5));
      const target = ref && article.links[`${ref.appId ?? article.appId}/${ref.documentId}`];
      const label = rewriteChildren(helpLinkLabel(source, token.text), token.tokens ?? []);
      return target ? `[${label}](${target.url}${ref.fragment})` : label;
    }
    const children =
      token.type === "list"
        ? token.items
        : token.type === "table"
          ? [...token.header, ...token.rows.flat()].flatMap((cell) => cell.tokens)
          : "tokens" in token
            ? (token.tokens ?? [])
            : [];
    const raw = rewriteChildren(source, children);
    return token.type === "heading" ? raw.replace(/[ \t]+\{icon="[a-z0-9-]+"\}(?=[ \t]*\r?\n?$)/i, "") : raw;
  };
  return rewriteChildren(article.markdown, tokens);
};

export const HELP_SEARCH_MAX_LIMIT = 25;
export const HELP_READ_MAX_CHARS = 7_000;
const normalizeSearchText = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const searchTerms = (value: string): string[] => [...new Set(normalizeSearchText(value).split(" ").filter(Boolean))];

const splitSections = (markdown: string): string[] => {
  const starts = [
    0,
    ...Array.from(markdown.matchAll(/^##\s+/gm)).flatMap((match) =>
      typeof match.index === "number" && match.index > 0 ? [match.index] : [],
    ),
  ];
  return starts.map((start, index) => markdown.slice(start, starts[index + 1] ?? markdown.length).trim()).filter(Boolean);
};

const boundedExcerpt = (markdown: string, terms: readonly string[]): string => {
  if (markdown.length <= HELP_READ_MAX_CHARS) return markdown;
  const marker = "[…]";
  const budget = HELP_READ_MAX_CHARS - marker.length * 2 - 4;
  const lower = markdown.toLocaleLowerCase();
  const anchors = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
  const anchor = anchors.length > 0 ? Math.min(...anchors) : 0;
  const start = Math.max(0, Math.min(markdown.length - budget, anchor - Math.floor(budget / 3)));
  const body = markdown.slice(start, start + budget).trim();
  return `${start > 0 ? `${marker}\n\n` : ""}${body}${start + budget < markdown.length ? `\n\n${marker}` : ""}`;
};

export const selectHelpMarkdown = (markdown: string, query?: string, locale?: string): { markdown: string; truncated: boolean } => {
  // An exact heading identifies one complete reference section, even in short articles.
  const headingQuery = query?.trim().toLocaleLowerCase();
  const exact =
    headingQuery &&
    splitSections(markdown).find((section) => {
      const heading = section
        .match(/^##\s+([^\n]+)/)?.[1]
        ?.replace(/\s*\{icon="[^"]*"\}\s*$/, "")
        .replaceAll("`", "")
        .trim()
        .toLocaleLowerCase();
      return heading === headingQuery;
    });
  if (exact) return { markdown: boundedExcerpt(exact, [headingQuery]), truncated: exact !== markdown };
  if (markdown.length <= HELP_READ_MAX_CHARS) return { markdown, truncated: false };
  const terms = searchTerms(query ?? "");
  const phrase = normalizeSearchText(query ?? "");
  const ranked = splitSections(markdown)
    .map((section, index) => {
      const text = normalizeSearchText(markdownToPlainText(section, locale));
      const score = (phrase && text.includes(phrase) ? 10 : 0) + terms.filter((term) => text.includes(term)).length;
      return { section, index, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);

  if (ranked.length === 0) return { markdown: boundedExcerpt(markdown, terms), truncated: true };

  let excerpt = "";
  for (const { section } of ranked) {
    const candidate = excerpt ? `${excerpt}\n\n${section}` : section;
    if (candidate.length <= HELP_READ_MAX_CHARS) excerpt = candidate;
    else if (!excerpt) excerpt = boundedExcerpt(section, terms);
  }
  return { markdown: excerpt || boundedExcerpt(markdown, terms), truncated: true };
};

export const readHelpArticle = (document: HelpArticle, query?: string) => ({
  kind: "help" as const,
  appId: document.appId,
  appName: document.appName,
  locale: document.locale,
  documentId: document.documentId,
  title: document.title,
  description: document.description,
  ...selectHelpMarkdown(helpAgentMarkdown(document), query, document.locale),
});

export const helpResourceUri = (appId: string, documentId: string): string =>
  `cloud://help/${encodeURIComponent(appId)}/${encodeURIComponent(documentId)}`;

export const parseHelpResourceUri = (uri: string): { appId: string; documentId: string } | null => {
  const match = /^cloud:\/\/help\/([^/]+)\/([^/]+)$/.exec(uri);
  if (!match?.[1] || !match[2]) return null;
  try {
    return { appId: decodeURIComponent(match[1]), documentId: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
};
