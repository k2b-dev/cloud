import { panelDialogOptions } from "@k2b/ui";

export const itemCreateDialogOptions = {
  ...panelDialogOptions,
  panelClassName: `${panelDialogOptions.panelClassName} spaces-item-create-dialog`,
  initialFocus: (dialog: HTMLDialogElement) => dialog.querySelector<HTMLElement>(".spaces-item-form [autofocus]"),
};
