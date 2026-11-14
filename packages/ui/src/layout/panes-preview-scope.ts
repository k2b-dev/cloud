import { inheritUiScope } from "../internal/portal-scope";

/** stdlib clones the preview into the body before onDragStart runs. */
export const preservePanesPreviewScope = (source: HTMLElement): void => {
  const preview = document.querySelector<HTMLElement>("body > .k2b-panes__drag-preview[aria-hidden='true']");
  if (!preview) return;
  inheritUiScope(preview, source);
};
