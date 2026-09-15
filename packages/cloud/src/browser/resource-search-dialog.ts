import type { OpenDialogOptions } from "@k2b/ui";

/** One shell for global navigation and resource selection, with native focus/escape handling. */
export const resourceSearchDialogOptions = (ariaLabel: string): OpenDialogOptions => ({
  panelClassName: "cloud-search-dialog",
  contentClassName: "cloud-search-dialog__content",
  initialFocus: "first-input",
  ariaLabel,
});
