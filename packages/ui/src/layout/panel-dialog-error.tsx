import { createComputed, createSignal, type JSX, on, onMount, Show } from "solid-js";
import { keepDialogFoot } from "../feedback/dialog-foot";
import type { PanelDialogError } from "./PanelDialog";

const text = (error: PanelDialogError | undefined) => (typeof error === "string" ? { title: error } : error?.title ? error : undefined);

/**
 * The tinted cell of a dialog error, the footer's first row (K10, K16). It loads with the first error, so dialogs
 * without one carry none of it. Every change of the cell keeps the footer where it was: the footer's place is read
 * before the cell changes (computations run before the DOM updates) and kept after it.
 */
export function PanelDialogErrorCell(props: {
  error: () => PanelDialogError | undefined;
  footer: () => HTMLElement | undefined;
}): JSX.Element {
  // Empty at first, so even the first error is measured before it shows.
  const [shown, setShown] = createSignal<{ title: string; description?: string }>();
  let before: number | undefined;
  const measure = () => {
    const footer = props.footer();
    before = footer?.isConnected ? footer.getBoundingClientRect().bottom : undefined;
  };
  const key = (error = text(props.error())) => (error ? `${error.title}\n${error.description ?? ""}` : "");
  onMount(() => {
    measure();
    setShown(text(props.error()));
    // The cell shows with this update's DOM changes, which run after this effect.
    queueMicrotask(() => keepDialogFoot(props.footer(), before));
    // One computation: it reads the footer's place, then hands the cell its new text, which shows with the next DOM
    // update; the footer is kept right after it, before the frame paints.
    createComputed(
      on(
        () => key(),
        () => {
          measure();
          setShown(text(props.error()));
          queueMicrotask(() => keepDialogFoot(props.footer(), before));
        },
        { defer: true },
      ),
    );
  });
  return (
    <Show when={shown()}>
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
