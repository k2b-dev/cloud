import type { HelpArticle } from "../services/help/types";
import { markdownToPlainText } from "../shared/markdown";
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

export const selectHelpMarkdown = (markdown: string, query?: string): { markdown: string; truncated: boolean } => {
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
      const text = normalizeSearchText(markdownToPlainText(section));
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
  ...selectHelpMarkdown(document.markdown, query),
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
