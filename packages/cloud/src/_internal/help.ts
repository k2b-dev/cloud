import { createHash } from "node:crypto";
import type { AppRegistryHelpSummary } from "../contracts/registry";
import type { HelpDefinition } from "../server/help";
import type { HelpCorpus, HelpDocument } from "../services/help/types";

export const HELP_DOCUMENT_MAX_BYTES = 128 * 1024;
export type CompiledHelp = { summary: AppRegistryHelpSummary; corpus: HelpCorpus };

export const compileHelp = (input: { appId: string; basePath?: string; definition: HelpDefinition }): CompiledHelp => {
  const compileDocuments = (source: HelpDefinition["documents"]): HelpDocument[] =>
    source.map(({ id, title, icon, description, order, markdown, searchText }) => {
      if (Buffer.byteLength(markdown) > HELP_DOCUMENT_MAX_BYTES) {
        throw new Error(`Help document "${id}" exceeds the ${HELP_DOCUMENT_MAX_BYTES}-byte limit`);
      }
      return { id, title, icon, description, order, markdown, searchText };
    });
  const baseLocale = input.definition.baseLocale ?? "en";
  const documents = compileDocuments(input.definition.documents);
  const documentsByLocale = Object.fromEntries(
    Object.entries(input.definition.documentsByLocale ?? {})
      .filter(([locale]) => locale !== baseLocale)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([locale, docs]) => [locale, compileDocuments(docs)]),
  );
  const manifestHash = createHash("sha256")
    .update(JSON.stringify({ revision: 1, appId: input.appId, baseLocale, documents, documentsByLocale }))
    .digest("hex");
  return {
    summary: { manifestHash, pageBase: `${input.basePath?.replace(/\/$/, "") ?? ""}/help`, baseLocale },
    corpus: { appId: input.appId, manifestHash, baseLocale, documents, documentsByLocale },
  };
};
