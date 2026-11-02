import type { JSX } from "solid-js";
import { dialogCore } from "../feedback/dialog-core";
import { LocaleProvider } from "../intl/locale";
import BottomSheet, { bottomSheetOptions } from "../layout/BottomSheet";

/**
 * The phone calendar of a typed date field as a bottom sheet. Date pickers load this module only when the sheet opens:
 * the sheet reaches `PanelDialog`, whose prompts render date pickers, so a static import would be a cycle.
 */
export const openDateSheet = <T,>(options: {
  title: JSX.Element;
  subtitle: string;
  ariaLabel?: string;
  locale: string;
  content: (close: (result: T) => void) => JSX.Element;
}): Promise<T | undefined> =>
  dialogCore.open<T>(
    (close, context) => (
      <LocaleProvider locale={options.locale}>
        <BottomSheet onDismiss={context.requestDismiss}>
          <BottomSheet.Header title={options.title} subtitle={options.subtitle} />
          <BottomSheet.Body>
            <div class="k2b-date-sheet">{options.content((result) => close(result))}</div>
          </BottomSheet.Body>
        </BottomSheet>
      </LocaleProvider>
    ),
    { ...bottomSheetOptions, ariaLabel: options.ariaLabel, history: true },
  );
