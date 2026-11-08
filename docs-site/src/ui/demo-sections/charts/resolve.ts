/**
 * The showcase draws every description through Cloud's description adapter, the same one Chat, Pulse and Code pages
 * use. These names keep the showcase's own vocabulary.
 */
export {
  type DescriptionDrawing as ShowcaseDrawing,
  type DescriptionRow as ShowcaseRow,
  descriptionBlockComponent as blockComponent,
  descriptionBlockComponents as blockComponents,
  descriptionSubtitle as specSubtitle,
  descriptionTitle as specTitle,
  resolveDescription as resolveDrawing,
} from "@k2b/cloud/descriptions";
