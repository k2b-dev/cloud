import { helpResourceUri } from "../src/_internal/help-catalog";
import type { HelpArticle, HelpReaderFactory } from "../src/services/help";
import { helpLocaleChain } from "../src/shared/help";

export type FixtureCorpus = {
  appId: string;
  appName: string;
  appIcon?: string;
  manifestHash: string;
  baseLocale?: string;
  documents: { id: string; title: string; order: number; markdown: string; description?: string; searchText?: string }[];
  documentsByLocale?: Record<string, FixtureCorpus["documents"]>;
};
/** Transport fixtures only. Ranking/locale/publication correctness is tested against real Postgres. */
export const fixtureHelpReader =
  (source: () => Promise<FixtureCorpus[]>): HelpReaderFactory =>
  (locale) => {
    const articles = async (): Promise<HelpArticle[]> =>
      (await source()).flatMap((corpus) =>
        corpus.documents.map((base) => {
          const resolved = helpLocaleChain(locale, corpus.baseLocale ?? "en")
            .map((lang) => ({
              lang,
              doc: lang === (corpus.baseLocale ?? "en") ? base : corpus.documentsByLocale?.[lang]?.find((d) => d.id === base.id),
            }))
            .find((entry) => entry.doc)!;
          const doc = resolved.doc!;
          return {
            appId: corpus.appId,
            appName: corpus.appName,
            manifestHash: corpus.manifestHash,
            locale: resolved.lang,
            documentId: doc.id,
            title: doc.title,
            description: doc.description,
            order: doc.order,
            markdown: doc.markdown,
          };
        }),
      );
    return {
      manifest: async () => null,
      list: async (cursor = "") =>
        (await articles())
          .filter((d) => helpResourceUri(d.appId, d.documentId) > cursor)
          .sort((a, b) => helpResourceUri(a.appId, a.documentId).localeCompare(helpResourceUri(b.appId, b.documentId)))
          .slice(0, 101),
      read: async (input) => (await articles()).find((d) => d.appId === input.appId && d.documentId === input.documentId) ?? null,
      search: async (input) =>
        (await articles())
          .filter((d) => !input.appId || input.appId === d.appId)
          .slice(0, input.limit ?? 25)
          .map((d) => ({
            kind: "help",
            appId: d.appId,
            appName: d.appName,
            locale: d.locale,
            documentId: d.documentId,
            title: d.title,
            description: d.description,
          })),
    };
  };
