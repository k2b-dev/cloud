import { createHash } from "node:crypto";
import type { AppRegistryHelpSummary } from "../contracts/registry";
import type { HelpDefinition } from "../server/help";
import type { HelpCorpus, HelpDocument } from "../services/help/types";
import { parseHelpReference } from "../shared/help";
import { lexHelpMarkdown, walkHelpTokens } from "../shared/markdown";

export const HELP_DOCUMENT_MAX_BYTES = 128 * 1024;
export type CompiledHelp = { summary: AppRegistryHelpSummary; corpus: HelpCorpus };

export const compileHelp = (input: { appId: string; basePath?: string; definition: HelpDefinition }): CompiledHelp => {
  const baseIds = new Set(input.definition.documents.map((document) => document.id));
  const compileDocuments = (source: HelpDefinition["documents"], locale: string): HelpDocument[] =>
    source.map(({ id, title, icon, description, order, kind, needs, next, related, markdown, searchText }) => {
      if (Buffer.byteLength(markdown) > HELP_DOCUMENT_MAX_BYTES) {
        throw new Error(`Help document "${id}" exceeds the ${HELP_DOCUMENT_MAX_BYTES}-byte limit`);
      }
      const validate = (reference: string) => {
        const ref = parseHelpReference(reference);
        if (ref?.appId === input.appId && !baseIds.has(ref.documentId))
          throw new Error(`Help locale "${locale}" document "${id}" has unknown reference "${reference}"`);
      };
      for (const reference of related) validate(reference);
      walkHelpTokens(lexHelpMarkdown(markdown, locale), (token) => {
        if (token.type === "link" && token.href.startsWith("help:")) validate(token.href.slice(5));
      });
      return { id, title, icon, description, order, kind, needs, next, related, markdown, searchText };
    });
  const baseLocale = input.definition.baseLocale ?? "en";
  const documents = compileDocuments(input.definition.documents, baseLocale);
  const documentsByLocale = Object.fromEntries(
    Object.entries(input.definition.documentsByLocale ?? {})
      .filter(([locale]) => locale !== baseLocale)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([locale, docs]) => [locale, compileDocuments(docs, locale)]),
  );
  // A revision bump republishes every corpus, here to fill the new metadata columns.
  const manifestHash = createHash("sha256")
    .update(JSON.stringify({ revision: 2, appId: input.appId, baseLocale, documents, documentsByLocale }))
    .digest("hex");
  return {
    summary: { manifestHash, pageBase: `${input.basePath?.replace(/\/$/, "") ?? ""}/help`, baseLocale },
    corpus: { appId: input.appId, manifestHash, baseLocale, documents, documentsByLocale },
  };
};
