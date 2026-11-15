/**
 * The renderer of capability views and the panel description Code pages share with it. Kept apart from
 * `@k2b/cloud/blocks`, so servers that only bind and check views never load components.
 */
export type { BlockChoiceState, BlockDraftState, BlockTreeProps } from "./BlockTree";
export { BlockTree } from "./BlockTree";
export { BLOCK_PANEL_HEIGHTS, blockChartHeight, blockDescription, blockJson } from "./description";
