import type { JSX } from "solid-js";
import type { DialogCall } from "../feedback/dialog-call";
import { dialogOpenFor } from "../feedback/dialog-core";
import { LocaleProvider } from "../intl/locale";
import BottomSheet, { bottomSheetOptions } from "../layout/BottomSheet";

/**
 * The phone calendar of a typed date field as a bottom sheet. Date pickers load this module only when the sheet opens:
 * the sheet reaches `PanelDialog`, whose prompts render date pickers, so a static import would be a cycle. `open` comes
 * `call` is read with `readDialogCall()` before the load, so the sheet keeps the palette, page and opener of the tap.
 */
export const openDateSheet = <T,>(
  call: DialogCall,
  options: {
    title: JSX.Element;
    subtitle: string;
    ariaLabel?: string;
    /** The calendar's id, which the field's `aria-controls` names while the sheet is open. */
    id: string;
    locale: string;
    content: (close: (result: T) => void) => JSX.Element;
  },
): Promise<T | undefined> =>
  dialogOpenFor(call)<T>(
    (close, context) => (
      <LocaleProvider locale={options.locale}>
        <BottomSheet onDismiss={context.requestDismiss}>
          <BottomSheet.Header title={options.title} subtitle={options.subtitle} />
          <BottomSheet.Body>
            <div id={options.id} class="k2b-date-sheet">
              {options.content((result) => close(result))}
            </div>
          </BottomSheet.Body>
        </BottomSheet>
      </LocaleProvider>
    ),
    { ...bottomSheetOptions, ariaLabel: options.ariaLabel, history: true },
  );
