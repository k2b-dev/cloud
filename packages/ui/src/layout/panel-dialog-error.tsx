import { type JSX, Show } from "solid-js";
import type { PanelDialogError } from "./PanelDialog";

const text = (error: PanelDialogError | undefined) => (typeof error === "string" ? { title: error } : error?.title ? error : undefined);

/**
 * The tinted cell of a dialog error, the footer's first row (K10, K16). It loads with the first error, so dialogs
 * without one carry none of it; the footer holds its place while the cell comes and goes (`dialog-foot.ts`).
 */
export function PanelDialogErrorCell(props: { error: () => PanelDialogError | undefined }): JSX.Element {
  return (
    <Show when={text(props.error())}>
      {(error) => (
        <div class="k2b-panel-dialog__error" role="alert">
          <i class="ti ti-circle-x" aria-hidden="true" />
          <div class="k2b-panel-dialog__error-copy">
            <strong>{error().title}</strong>
            <Show when={error().description}>{(detail) => <p>{detail()}</p>}</Show>
          </div>
        </div>
      )}
    </Show>
  );
}
