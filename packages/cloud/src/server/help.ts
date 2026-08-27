import { Hono } from "hono";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { type HelpDocumentManifest, type HelpDocumentPayload, type HelpSearchPayload, helpLocaleChain } from "../shared/help";
import { markdownToPlainText, renderHelpMarkdown } from "../shared/markdown";

const metadataSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string().trim().min(1),
  icon: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
  order: z.number().int().optional(),
});

export type HelpDefinitionDocument = Omit<z.infer<typeof metadataSchema>, "order"> & {
  order: number;
  markdown: string;
  html: string;
  searchText: string;
};

export type HelpDefinition = {
  baseLocale?: string;
  documentsByLocale?: Readonly<Record<string, readonly HelpDefinitionDocument[]>>;
  documents: readonly HelpDefinitionDocument[];
  getMarkdown: (id: string, locale?: string) => string | undefined;
};

export type HelpCollection = {
  manifest: readonly HelpDocumentManifest[];
  router: Hono;
  /** Raw Markdown for future agent context and non-UI consumers. */
  getMarkdown: (id: string) => string | undefined;
};

type ParsedHelpDocument = Omit<HelpDefinitionDocument, "order"> & { order?: number };

const parseSource = (source: string): ParsedHelpDocument => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (!match) throw new Error("Help documents require YAML frontmatter wrapped in --- markers");

  const metadata = metadataSchema.parse(parseYaml(match[1]!));
  const markdown = match[2]!.trim();
  if (!markdown) throw new Error(`Help document "${metadata.id}" has no body`);

  return {
    ...metadata,
    markdown,
    html: renderHelpMarkdown(markdown),
    searchText: markdownToPlainText(markdown),
  };
};

const canonicalLocale = (value: string): string => {
  try {
    return Intl.getCanonicalLocales(value)[0]!;
  } catch {
    throw new Error(`Invalid help locale "${value}"`);
  }
};

const parseDocuments = (
  sources: readonly string[],
  locale: string,
  baseById?: ReadonlyMap<string, HelpDefinitionDocument>,
): readonly HelpDefinitionDocument[] => {
  const documents = sources
    .map(parseSource)
    .map((document): HelpDefinitionDocument => {
      const base = baseById?.get(document.id);
      if (!baseById) return { ...document, order: document.order ?? 100 };
      if (!base) throw new Error(`Help locale "${locale}" contains unknown document id "${document.id}"`);
      if ((document.icon !== undefined && document.icon !== base.icon) || (document.order !== undefined && document.order !== base.order)) {
        throw new Error(`Help locale "${locale}" must preserve icon and order for document "${document.id}"`);
      }
      return { ...document, icon: base.icon, description: document.description ?? base.description, order: base.order };
    })
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
    .map((document) => Object.freeze(document));
  const ids = new Set<string>();
  for (const document of documents) {
    if (ids.has(document.id)) throw new Error(`Duplicate help document id "${document.id}" in locale "${locale}"`);
    ids.add(document.id);
  }
  return Object.freeze(documents);
};

/** Define one app-owned Help corpus without routing or authorization config. */
export const defineHelp = (
  options:
    | { documents: readonly string[]; baseLocale?: never }
    | { baseLocale: string; documents: Readonly<Record<string, readonly string[]>> },
): HelpDefinition => {
  const localized = (value: typeof options): value is { baseLocale: string; documents: Readonly<Record<string, readonly string[]>> } =>
    typeof value.baseLocale === "string";
  const baseLocale = canonicalLocale(localized(options) ? options.baseLocale : "en");
  const rawSourceMap: Readonly<Record<string, readonly string[]>> = localized(options)
    ? options.documents
    : { [baseLocale]: options.documents };
  const sourceMap: Record<string, readonly string[]> = {};
  for (const [rawLocale, sources] of Object.entries(rawSourceMap)) {
    const locale = canonicalLocale(rawLocale);
    if (sourceMap[locale]) throw new Error(`Duplicate help locale "${locale}"`);
    sourceMap[locale] = sources;
  }
  const documentsByLocale: Record<string, readonly HelpDefinitionDocument[]> = {};
  const baseSources = sourceMap[baseLocale];
  if (!baseSources) throw new Error(`Help documents require the base locale "${baseLocale}"`);
  const documents = parseDocuments(baseSources, baseLocale);
  documentsByLocale[baseLocale] = documents;
  const baseById = new Map(documents.map((document) => [document.id, document]));
  for (const [locale, sources] of Object.entries(sourceMap)) {
    if (locale === baseLocale) continue;
    if (documentsByLocale[locale]) throw new Error(`Duplicate help locale "${locale}"`);
    documentsByLocale[locale] = parseDocuments(sources, locale, baseById);
  }

  return {
    baseLocale,
    documentsByLocale: Object.freeze(documentsByLocale),
    documents: Object.freeze(documents),
    getMarkdown: (id, locale = baseLocale) => {
      for (const candidate of helpLocaleChain(canonicalLocale(locale), baseLocale)) {
        const localized = documentsByLocale[candidate]?.find((document) => document.id === id);
        if (localized) return localized.markdown;
      }
      return undefined;
    },
  };
};

/**
 * Define one app-owned help corpus. The explicit source list is deliberate:
 * IDs, ordering and ownership stay visible in code; no filesystem scanning or
 * build-time convention is required.
 */
export const defineHelpCollection = (options: { basePath: string; sources: readonly string[] }): HelpCollection => {
  const basePath = options.basePath.replace(/\/$/, "");
  const definition = defineHelp({ documents: options.sources });
  const documents = definition.documents;
  const byId = new Map(documents.map((document) => [document.id, document]));

  const searchUrl = `${basePath}/search`;
  const manifest = documents.map<HelpDocumentManifest>(({ id, title, icon, description, order }) => ({
    id,
    title,
    icon,
    description,
    order,
    searchUrl,
    url: `${basePath}/${encodeURIComponent(id)}`,
  }));

  const router = new Hono()
    .get("/search", (context) => {
      const query = context.req.query("q")?.trim().toLocaleLowerCase().slice(0, 200) ?? "";
      const payload: HelpSearchPayload = {
        locale: "en",
        ids: query
          ? documents
              .filter((document) =>
                [document.title, document.description, document.searchText].some((value) => value?.toLocaleLowerCase().includes(query)),
              )
              .map((document) => document.id)
          : [],
      };
      return context.json(payload);
    })
    .get("/:id", (context) => {
      const document = byId.get(context.req.param("id"));
      if (!document) return context.json({ error: "Help document not found" }, 404);
      const payload: HelpDocumentPayload = {
        locale: "en",
        id: document.id,
        title: document.title,
        markdown: document.markdown,
        html: document.html,
      };
      return context.json(payload);
    });

  return {
    manifest,
    router,
    getMarkdown: definition.getMarkdown,
  };
};
