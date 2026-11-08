/** Host-held source. Only hashes enter srcdoc; requested parts cross the existing bridge. */
export type ChartPart = { readonly code: string; readonly hash: string };
export type ChartParts = { shared: ChartPart; kinds: Record<string, ChartPart> };
export type ChartHashes = { shared: string; kinds: Record<string, string> };

/** The only allowed import in a kind asset; replaced with its frame's shared blob URL. */
export const CHART_SHARED_IMPORT = "cloud:shared";

export function chartHashes(parts: ChartParts): ChartHashes {
  return { shared: parts.shared.hash, kinds: Object.fromEntries(Object.entries(parts.kinds).map(([kind, part]) => [kind, part.hash])) };
}
