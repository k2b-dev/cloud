import type { MarkdownRangeOptions } from "./_lib/list-structure";
import { extractDataBlocks } from "./lib/named-blocks";
import { extractNotebookDirectiveRanges } from "./lib/query-blocks";

export const directiveOptions: MarkdownRangeOptions = {
  excludedRanges: (markdown) => [
    ...extractDataBlocks(markdown).map((block) => ({ from: block.blockStart, to: block.blockEnd })),
    ...extractNotebookDirectiveRanges(markdown),
  ],
};
