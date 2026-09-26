import type { CloudCliText } from "./locale";

/**
 * The syntactic form of a resource argument. Parsing never contacts the
 * server; each application resolves the result against its own API.
 *
 * - `local`: starts with `/`, `./`, `../`, or `~`, so it names a local file;
 * - `path`: `<container>:<path>`, split at the first colon;
 * - `ref`: anything else, usually an ID or an exact container name.
 */
export type CloudCliAddress =
  | { kind: "local"; path: string }
  | { kind: "path"; container: string; path: string }
  | { kind: "ref"; ref: string };

const LOCAL_PATH = /^(?:\/|\.{1,2}(?:\/|$)|~(?:\/|$))/;

export const parseCliAddress = (raw: string): CloudCliAddress => {
  if (LOCAL_PATH.test(raw)) return { kind: "local", path: raw };
  const colon = raw.indexOf(":");
  if (colon > 0) return { kind: "path", container: raw.slice(0, colon), path: raw.slice(colon + 1) };
  return { kind: "ref", ref: raw };
};

/** One resource that an ambiguous name or path matched. */
export type CloudCliCandidate = { path: string; id: string };

/** Candidates as `path (id), path (id)`. */
export const formatCliCandidates = (candidates: readonly CloudCliCandidate[]): string =>
  candidates.map((candidate) => `${candidate.path} (${candidate.id})`).join(", ");

/**
 * The shared ambiguity message. `resources` is the plural resource noun, in
 * German in the dative (`{ en: "notes", de: "Notizen" }`).
 */
export const cliAmbiguityText = (params: {
  value: string;
  resources: CloudCliText;
  candidates: readonly CloudCliCandidate[];
}): CloudCliText => {
  const list = formatCliCandidates(params.candidates);
  return {
    en: `"${params.value}" matches several ${params.resources.en}: ${list}. Use one of these paths or IDs.`,
    de: `„${params.value}“ passt zu mehreren ${params.resources.de}: ${list}. Verwende einen dieser Pfade oder eine ID.`,
  };
};
