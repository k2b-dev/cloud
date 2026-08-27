import type { AppRegistryEntry, HelpRegistryDocument, HelpRegistryEntry } from "../contracts/registry";
import { helpLocaleChain } from "../shared/help";
import { markdownToPlainText } from "../shared/markdown";
import { getApp, getHelp, listApps, listHelp } from "./registry";

export const HELP_SEARCH_MAX_LIMIT = 25;
export const HELP_READ_MAX_CHARS = 7_000;

export type HelpCatalogDocument = {
  appId: string;
  appName: string;
  appIcon?: string;
  manifestHash: string;
  locale: string;
  documentId: string;
  title: string;
  description?: string;
  order: number;
  markdown: string;
  searchText: string;
};

export type HelpCatalogItem = Omit<HelpCatalogDocument, "appIcon" | "manifestHash" | "order" | "markdown" | "searchText"> & {
  kind: "help";
};

export type HelpCatalogRead = HelpCatalogItem & {
  markdown: string;
  truncated: boolean;
};

export type HelpCatalogDependencies = {
  listApps?: () => Promise<AppRegistryEntry[]>;
  listHelp?: () => Promise<HelpRegistryEntry[]>;
};

export type AppHelpDependencies = {
  getApp?: (appId: string) => Promise<AppRegistryEntry | null>;
  getHelp?: (appId: string) => Promise<HelpRegistryEntry | null>;
};

export type ResolvedAppHelp =
  | { status: "available"; app: AppRegistryEntry; help: HelpRegistryEntry }
  | { status: "missing" }
  | { status: "stale" };

const normalizeSearchText = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const searchTerms = (value: string): string[] =>
  Array.from(
    new Set(
      normalizeSearchText(value)
        .split(" ")
        .filter((term) => term.length > 0),
    ),
  );

export const resolveAppHelp = async (appId: string, dependencies: AppHelpDependencies = {}): Promise<ResolvedAppHelp> => {
  const [app, help] = await Promise.all([(dependencies.getApp ?? getApp)(appId), (dependencies.getHelp ?? getHelp)(appId)]);
  if (!app?.help || !help) return { status: "missing" };
  if (app.help.manifestHash !== help.manifestHash) return { status: "stale" };
  return { status: "available", app, help };
};

export const loadCurrentHelp = async (dependencies: HelpCatalogDependencies = {}): Promise<HelpRegistryEntry[]> => {
  const [apps, entries] = await Promise.all([(dependencies.listApps ?? listApps)(), (dependencies.listHelp ?? listHelp)()]);
  const manifestHashes = new Map(apps.flatMap((app) => (app.help ? [[app.id, app.help.manifestHash] as const] : [])));
  return entries.filter((entry) => manifestHashes.get(entry.appId) === entry.manifestHash);
};

const resolveRegistryDocuments = (
  entry: HelpRegistryEntry,
  requestedLocale: string,
): { locale: string; documents: HelpRegistryDocument[] } => {
  const baseLocale = entry.baseLocale ?? "en";
  const variants = entry.documentsByLocale ?? {};
  const chain = helpLocaleChain(requestedLocale, baseLocale);
  const locale = chain.find((candidate) => candidate === baseLocale || variants[candidate] !== undefined) ?? baseLocale;
  const byId = new Map(entry.documents.map((document) => [document.id, document]));
  for (const candidate of [...chain.slice(0, chain.indexOf(baseLocale)), baseLocale].reverse()) {
    if (candidate === baseLocale) continue;
    for (const document of variants[candidate] ?? []) byId.set(document.id, { ...byId.get(document.id), ...document });
  }
  return { locale, documents: entry.documents.map((document) => byId.get(document.id) ?? document) };
};

export const createHelpCatalog = (entries: readonly HelpRegistryEntry[], requestedLocale = "en"): HelpCatalogDocument[] =>
  entries
    .flatMap((entry) => {
      const resolved = resolveRegistryDocuments(entry, requestedLocale);
      return resolved.documents.map((document) => ({
        appId: entry.appId,
        appName: entry.appName,
        appIcon: entry.appIcon,
        manifestHash: entry.manifestHash,
        locale: resolved.locale,
        documentId: document.id,
        title: document.title,
        description: document.description,
        order: document.order,
        markdown: document.markdown,
        searchText: document.searchText ?? markdownToPlainText(document.markdown),
      }));
    })
    .sort(
      (left, right) => left.appId.localeCompare(right.appId) || left.order - right.order || left.documentId.localeCompare(right.documentId),
    );

export const loadHelpCatalog = async (dependencies: HelpCatalogDependencies = {}, requestedLocale = "en"): Promise<HelpCatalogDocument[]> =>
  createHelpCatalog(await loadCurrentHelp(dependencies), requestedLocale);

const catalogItem = (document: HelpCatalogDocument): HelpCatalogItem => ({
  appId: document.appId,
  appName: document.appName,
  kind: "help",
  locale: document.locale,
  documentId: document.documentId,
  title: document.title,
  description: document.description,
});

const searchScore = (document: HelpCatalogDocument, query: string): number => {
  const phrase = normalizeSearchText(query);
  const terms = searchTerms(query);
  if (!phrase || terms.length === 0) return 0;

  const app = normalizeSearchText(`${document.appId} ${document.appName}`);
  const identity = normalizeSearchText(`${document.documentId} ${document.title}`);
  const description = normalizeSearchText(document.description ?? "");
  const body = normalizeSearchText(document.searchText);
  let score = 0;
  if (identity === phrase) score += 80;
  else if (identity.includes(phrase)) score += 40;
  if (app.includes(phrase)) score += 30;
  if (description.includes(phrase)) score += 20;
  if (body.includes(phrase)) score += 10;
  for (const term of terms) {
    if (identity.includes(term)) score += 8;
    if (app.includes(term)) score += 6;
    if (description.includes(term)) score += 4;
    if (body.includes(term)) score += 1;
  }
  return score;
};

export const searchHelpCatalog = (
  catalog: readonly HelpCatalogDocument[],
  input: { query: string; appId?: string; limit?: number },
): HelpCatalogItem[] => {
  const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 10), HELP_SEARCH_MAX_LIMIT));
  return catalog
    .filter((document) => !input.appId || document.appId === input.appId)
    .map((document) => ({ document, score: searchScore(document, input.query) }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.document.appId.localeCompare(right.document.appId) ||
        left.document.documentId.localeCompare(right.document.documentId),
    )
    .slice(0, limit)
    .map(({ document }) => catalogItem(document));
};

export const findHelpDocument = (catalog: readonly HelpCatalogDocument[], appId: string, documentId: string): HelpCatalogDocument | null =>
  catalog.find((document) => document.appId === appId && document.documentId === documentId) ?? null;

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

const selectMarkdown = (markdown: string, query?: string): { markdown: string; truncated: boolean } => {
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

export const readHelpCatalog = (
  catalog: readonly HelpCatalogDocument[],
  input: { appId: string; documentId: string; query?: string },
): HelpCatalogRead | null => {
  const document = findHelpDocument(catalog, input.appId, input.documentId);
  if (!document) return null;
  const selected = selectMarkdown(document.markdown, input.query);
  return { ...catalogItem(document), ...selected };
};

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
