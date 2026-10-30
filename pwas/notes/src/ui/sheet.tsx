import { BottomSheet, bottomSheetAdaptiveOptions, dialogCore } from "@k2b/ui";
import type { JSX } from "solid-js";

/** Decisions and short forms: a sheet from the bottom on phones, a centered dialog from 48rem up (mockup v4). */
export function openSheet<T = void>(render: (close: (result?: T) => void) => JSX.Element, options: { label?: string } = {}) {
  return dialogCore.open<T>(
    (close, context) => (
      <BottomSheet onDismiss={() => context.requestDismiss()}>
        <div class="n-sheet">{render(close)}</div>
      </BottomSheet>
    ),
    { ...bottomSheetAdaptiveOptions, history: true, ariaLabel: options.label },
  );
}
