import { importOnDemand } from "@k2b/cloud/browser/reload";
import { Button, InlineGuidance, useLocale } from "@k2b/ui";
import { type Component, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { assistantMessages } from "./messages";

/** Load only inside a mounted destination; a closed destination never opens again when its import finishes. */
export function DeferredCodeContent<P extends object>(props: { load: () => Promise<Component<P>>; contentProps: P }): JSX.Element {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
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
    if (loaded) setComponent(() => loaded);
    else setFailed(true);
  };
  onMount(() => void load());
  return (
    <div class="assistant-deferred-view">
      <Show
        when={component()}
        fallback={
          <div class="assistant-deferred-feedback">
            <InlineGuidance loading={!failed()} tone={failed() ? "danger" : "neutral"} role={failed() ? "alert" : "status"}>
              {failed() ? t().codeViewLoadFailed : t().codeViewLoading}
              <Show when={failed()}>
                <Button size="sm" variant="ghost" onClick={() => void load()}>
                  {t().codeViewRetry}
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
