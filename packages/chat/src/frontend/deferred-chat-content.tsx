import { importOnDemand } from "@k2b/cloud/browser/reload";
import { Button, InlineGuidance } from "@k2b/ui";
import { type Component, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { useChatMessages } from "./chat-dialog";

/** Load only inside a mounted destination; a closed destination never opens again when its import finishes. */
export function DeferredChatContent<P extends object>(props: {
  load: () => Promise<Component<P>>;
  contentProps: P;
  dialog?: boolean;
}): JSX.Element {
  const t = useChatMessages();
  let host!: HTMLDivElement;
  let interacted = false;
  const [component, setComponent] = createSignal<Component<P>>();
  const [failed, setFailed] = createSignal(false);
  let active = true;
  onCleanup(() => {
    active = false;
  });
  const load = async () => {
    setFailed(false);
    const loaded = await importOnDemand(props.load);
    if (!active) return;
    if (loaded) {
      setComponent(() => loaded);
      // The dialog chose its initial focus while only loading feedback existed.
      // Hand it to the form once, unless the reader already took control.
      if (props.dialog && !interacted && host.closest("dialog")?.contains(document.activeElement)) {
        host
          .querySelector<HTMLElement>(
            "input:not([type='hidden']):not([disabled]), textarea:not([disabled]), select:not([disabled]), [role='combobox']:not([aria-disabled='true'])",
          )
          ?.focus({ preventScroll: true });
      }
    } else setFailed(true);
  };
  onMount(() => {
    const dialog = props.dialog ? host.closest("dialog") : null;
    const claimFocus = () => {
      interacted = true;
    };
    dialog?.addEventListener("pointerdown", claimFocus);
    dialog?.addEventListener("keydown", claimFocus);
    onCleanup(() => {
      dialog?.removeEventListener("pointerdown", claimFocus);
      dialog?.removeEventListener("keydown", claimFocus);
    });
    void load();
  });
  return (
    <div ref={host} class={props.dialog ? "chat-deferred-dialog" : "chat-deferred-view"}>
      <Show
        when={component()}
        fallback={
          <div class="chat-deferred-feedback">
            <InlineGuidance loading={!failed()} tone={failed() ? "danger" : "neutral"} role={failed() ? "alert" : "status"}>
              {failed() ? t().requestFailed : t().loadingCode}
              <Show when={failed()}>
                <Button size="sm" variant="ghost" onClick={() => void load()}>
                  {t().retry}
                </Button>
              </Show>
            </InlineGuidance>
          </div>
        }
      >
        {(Content) => <Dynamic component={Content()} {...props.contentProps} />}
      </Show>
    </div>
  );
}
