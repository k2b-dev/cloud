import { resolveCapabilityManifestPresentation } from "../_internal/capabilities";
import { listCapabilities } from "../_internal/registry";
import type { CapabilityRegistryEntry } from "../contracts/registry";

/**
 * How many resources of each type, in the reader's words: `{ "mail.message": "3 Mails" }`. A type names its nouns in
 * its capability presentation (`count: { one, other }`); a type without them is left out, and the caller keeps its own
 * generic wording. Reads the observed capability registry, no database.
 */
export const describeAiResourceTypeCounts = async (
  counts: ReadonlyMap<string, number>,
  locale: string,
  deps: { listRegistry?: () => Promise<CapabilityRegistryEntry[]> } = {},
): Promise<Map<string, string>> => {
  const described = new Map<string, string>();
  if (counts.size === 0) return described;
  const entries = await (deps.listRegistry ?? listCapabilities)();
  for (const [type, count] of counts) {
    const appId = type.slice(0, type.indexOf("."));
    const entry = entries.find((candidate) => candidate.appId === appId);
    if (!entry || count <= 0) continue;
    const manifest = resolveCapabilityManifestPresentation(entry.manifest, entry.presentation, locale);
    const nouns = manifest.types.find((candidate) => `${entry.appId}.${candidate.localId}` === type)?.count;
    if (nouns) described.set(type, `${new Intl.NumberFormat(locale).format(count)} ${count === 1 ? nouns.one : nouns.other}`);
  }
  return described;
};
