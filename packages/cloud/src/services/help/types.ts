import type { AppRegistryHelpSummary } from "../../contracts/registry";
import type { HelpDocumentManifest } from "../../shared/help";

export type HelpDocument = {
  id: string;
  title: string;
  icon?: string;
  description?: string;
  order: number;
  markdown: string;
  searchText: string;
};

export type HelpCorpus = {
  appId: string;
  manifestHash: string;
  baseLocale: string;
  documents: readonly HelpDocument[];
  documentsByLocale: Readonly<Record<string, readonly HelpDocument[]>>;
};

export type HelpMetadata = {
  appId: string;
  appName: string;
  manifestHash: string;
  locale: string;
  documentId: string;
  title: string;
  description?: string;
  icon?: string;
  order: number;
};
export type HelpArticle = HelpMetadata & { markdown: string };
export type HelpMatch = Pick<HelpMetadata, "appId" | "appName" | "locale" | "documentId" | "title" | "description"> & { kind: "help" };
export type HelpSearchInput = { query: string; appId?: string; limit?: number };
export type HelpReadInput = { appId: string; documentId: string };
export type HelpManifestResult = AppRegistryHelpSummary & { locale: string; documents: readonly HelpDocumentManifest[] };

/** One request's language; operations resolve the current published app versions. */
export type HelpReader = {
  manifest(appId: string): Promise<HelpManifestResult | null>;
  list(cursor?: string): Promise<HelpMetadata[]>;
  search(input: HelpSearchInput): Promise<HelpMatch[]>;
  read(input: HelpReadInput): Promise<HelpArticle | null>;
};
export type HelpReaderFactory = (locale: string) => HelpReader;
