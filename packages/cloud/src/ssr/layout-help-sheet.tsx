import { BottomSheet, bottomSheetOptions, dialogCore } from "@k2b/ui";
import type { JSX } from "solid-js";

/**
 * The help as the shared bottom sheet at full height on a phone, like the panel's phone sheet. It loads with the first
 * help a phone opens without the panel, so the sheet's code stays out of every page's first JavaScript.
 */
export const openHelpSheet = (content: (close: () => void) => JSX.Element, ariaLabel: string): Promise<void | undefined> =>
  dialogCore.open<void>((close, context) => <BottomSheet onDismiss={context.requestDismiss}>{content(() => close())}</BottomSheet>, {
    ...bottomSheetOptions,
    panelClassName: `${bottomSheetOptions.panelClassName} cloud-help-sheet`,
    ariaLabel,
    history: true,
  });
