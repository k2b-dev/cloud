import { type Component, createComponent, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Button } from "../actions/Button";
import { useUiMessages } from "../intl/messages";
import type { ImageEditorProps } from "./image-editor/types";

/** The editor engine and controls load only when this component mounts in a browser. */
export function ImageEditor(props: ImageEditorProps): JSX.Element {
  const messages = useUiMessages();
  const [view, setView] = createSignal<Component<ImageEditorProps>>();
  const [failed, setFailed] = createSignal(false);
  let disposed = false;
  const load = async () => {
    setFailed(false);
    try {
      const module = await import("./image-editor/ImageEditorView");
      if (!disposed) setView(() => module.default);
    } catch {
      if (!disposed) setFailed(true);
    }
  };
  onMount(() => void load());
  onCleanup(() => {
    disposed = true;
  });
  return (
    <Show
      when={view()}
      fallback={
        <div class={`k2b-image-editor k2b-image-editor--loading ${props.class ?? ""}`} aria-busy={!failed()}>
          <div role={failed() ? "alert" : "status"}>{failed() ? messages().couldNotLoadData : messages().loading}</div>
          <Show when={failed()}>
            <Button variant="secondary" onClick={() => void load()}>
              {messages().retry}
            </Button>
          </Show>
        </div>
      }
    >
      {(View) => createComponent(View(), props)}
    </Show>
  );
}
