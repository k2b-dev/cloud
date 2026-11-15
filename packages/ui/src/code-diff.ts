/**
 * A separate entry for `CodeDiff`: only the pages that show code load it. Kept out of the root entry, because a bundle
 * that splits chunks places every module the root re-exports into the chunks its islands load first.
 */
export type { CodeDiffFile, CodeDiffLine, CodeDiffLineKind, CodeDiffLocation, CodeDiffProps } from "./content/CodeDiff";
export { CodeDiff } from "./content/CodeDiff";
