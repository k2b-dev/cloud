import { formatShortcut } from "@k2b/ui";
import { Hono } from "hono";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { helpAgentMarkdown } from "../_internal/help-catalog";
import {
  HELP_ACCESS_LEVELS,
  HELP_KINDS,
  HELP_REFERENCE_PATTERN,
  type HelpDocumentManifest,
  type HelpDocumentPayload,
  type HelpKind,
  type HelpSearchPayload,
  helpLocaleChain,
  parseHelpReference,
} from "../shared/help";
import { lexHelpMarkdown, markdownToPlainText, renderHelpMarkdown, walkHelpTokens } from "../shared/markdown";
import { auth } from "./middleware/auth";

const metadataSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string().trim().min(1),
  icon: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
  order: z.number().int().optional(),
  kind: z.enum(HELP_KINDS).optional(),
  needs: z.enum(HELP_ACCESS_LEVELS).optional(),
  next: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),
  related: z
    .array(z.string().regex(HELP_REFERENCE_PATTERN))
    .refine((refs) => new Set(refs).size === refs.length, "Duplicate related Help reference")
    .optional(),
});

export type HelpDefinitionDocument = Omit<z.infer<typeof metadataSchema>, "order" | "kind" | "related"> & {
  order: number;
  kind: HelpKind;
  related: readonly string[];
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

type ParsedHelpDocument = z.infer<typeof metadataSchema> & Pick<HelpDefinitionDocument, "markdown" | "html" | "searchText">;

const parseSource = (source: string, locale: string): ParsedHelpDocument => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (!match) throw new Error("Help documents require YAML frontmatter wrapped in --- markers");

  const metadata = metadataSchema.parse(parseYaml(match[1]!));
  const markdown = match[2]!.trim();
  if (!markdown) throw new Error(`Help document "${metadata.id}" has no body`);

  return {
    ...metadata,
    markdown,
    html: renderHelpMarkdown(markdown, { locale }),
    searchText: markdownToPlainText(markdown, locale),
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
    .map((source) => parseSource(source, locale))
    .map((document): HelpDefinitionDocument => {
      const base = baseById?.get(document.id);
      if (!baseById)
        return { ...document, order: document.order ?? 100, kind: document.kind ?? "task", related: Object.freeze(document.related ?? []) };
      if (!base) throw new Error(`Help locale "${locale}" contains unknown document id "${document.id}"`);
      if ((document.icon !== undefined && document.icon !== base.icon) || (document.order !== undefined && document.order !== base.order)) {
        throw new Error(`Help locale "${locale}" must preserve icon and order for document "${document.id}"`);
      }
      for (const field of ["kind", "needs", "next", "related"] as const) {
        if (document[field] !== undefined && JSON.stringify(document[field]) !== JSON.stringify(base[field])) {
          throw new Error(`Help locale "${locale}" must preserve ${field} for document "${document.id}"`);
        }
      }
      return {
        ...document,
        icon: base.icon,
        description: document.description ?? base.description,
        order: base.order,
        kind: base.kind,
        needs: base.needs,
        next: base.next,
        related: base.related,
      };
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

  for (const [locale, localizedDocuments] of Object.entries(documentsByLocale)) {
    for (const document of localizedDocuments) {
      const validate = (reference: string, field: string) => {
        const ref = parseHelpReference(reference);
        if (!ref || (!ref.appId && !baseById.has(ref.documentId))) {
          throw new Error(`Help locale "${locale}" document "${document.id}" has unknown ${field} reference "${reference}"`);
        }
      };
      if (document.next === document.id)
        throw new Error(`Help locale "${locale}" document "${document.id}" must not reference itself in next`);
      if (document.next) validate(document.next, "next");
      for (const reference of document.related) validate(reference, "related");
      const unreadableLink = () =>
        new Error(
          `Help document "${document.id}" has a help: link that agents cannot read in locale "${locale}"; write it inline as [text](help:id)`,
        );
      walkHelpTokens(lexHelpMarkdown(document.markdown, locale), (token) => {
        if (
          (token.type === "link" && token.href.startsWith("help:") && !token.raw.startsWith("[")) ||
          (token.type === "image" && token.href.startsWith("help:")) ||
          (token.type === "html" && /[\w:-]+\s*=\s*(?:"[^"]*help:[^"]*"|'[^']*help:[^']*'|[^\s>"']*help:[^\s>"']*)/i.test(token.raw))
        )
          throw unreadableLink();
        if ((token.type === "paragraph" || token.type === "text") && token.tokens?.length) {
          let prose = token.raw;
          // Keep line positions while excluding multiline code spans from the author contract.
          walkHelpTokens(token.tokens, (child) => {
            if (child.type === "codespan") prose = prose.replaceAll(child.raw, child.raw.replace(/[^\r\n]/g, "x"));
          });
          if (/^ {0,3}:::details\b/m.test(prose)) {
            throw new Error(`Help document "${document.id}" has a :::details block without a title or closing ::: in locale "${locale}"`);
          }
        }
        if (token.type === "link" && token.href.startsWith("help:")) validate(token.href.slice(5), "help:");
        // Callouts do not render inside details, and a warning must stay where the reader sees it.
        if (token.type === "helpDetails" && token.callout === true) {
          throw new Error(
            `Help document "${document.id}" has a callout inside details in locale "${locale}"; place it outside the details`,
          );
        }
        if (token.type === "helpKbd" && formatShortcut(String(token.keys), { platform: "other", locale }).keys.length === 0) {
          throw new Error(`Help document "${document.id}" has an invalid key shortcut "${token.keys}" in locale "${locale}"`);
        }
      });
      // Unconverted Help syntax and targets fail here instead of reaching agents.
      const agentTokens = lexHelpMarkdown(helpAgentMarkdown({ markdown: document.markdown, locale, appId: "", links: {} }), locale);
      let unconvertedLink = Object.values(agentTokens.links).some((link) => link.href.startsWith("help:"));
      let unconvertedSyntax = false;
      walkHelpTokens(agentTokens, (token) => {
        if (token.type === "link" && token.href.startsWith("help:")) unconvertedLink = true;
        if (token.type === "helpKbd" || token.type === "helpLabel" || token.type === "helpDetails") unconvertedSyntax = true;
      });
      if (unconvertedLink) throw unreadableLink();
      if (unconvertedSyntax) {
        throw new Error(`Help document "${document.id}" has Help syntax that agents cannot read in locale "${locale}"`);
      }
    }
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
 *
 * Its payload includes kind and needs, but no next and an empty related list: it has no page route to link to.
 *
 * @deprecated Declare Help with `defineHelp()` and pass it to `app.start({ help })`. This router only
 * requires sign-in; it does not apply the app's Help visibility, so the mounting app's routes must guard it.
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

  // Help is for signed-in people wherever an app mounts this router; its own route policy may narrow it further.
  const router = new Hono();
  router.use(auth.requireRole("authenticated"), auth.requireUser());
  router
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
        markdown: helpAgentMarkdown({ markdown: document.markdown, locale: "en", appId: "", links: {} }),
        html: document.html,
        kind: document.kind,
        needs: document.needs,
        related: [],
      };
      return context.json(payload);
    });

  return {
    manifest,
    router,
    getMarkdown: definition.getMarkdown,
  };
};
