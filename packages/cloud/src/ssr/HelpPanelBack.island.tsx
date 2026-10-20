import { IconButton, useLocale } from "@k2b/ui";
import { createSignal, onMount, Show } from "solid-js";
import { helpMessages } from "./help-messages";
import { capturePanelFocus, panelElement, restorePanelFocus } from "./layout-help-panel-lifecycle";
import { type HelpPanelState, helpPanelState } from "./layout-help-panel-state";

capturePanelFocus();
export default function HelpPanelBack(props: { back: boolean; tile: string }) {
  const locale = useLocale();
  const t = () => helpMessages.resolve([locale()]).t;
  const [state, setState] = createSignal<HelpPanelState>();
  onMount(() => {
    const wrapper = panelElement();
    setState(helpPanelState(wrapper));
    const button = wrapper.querySelector(".help-head-back");
    if (button) restorePanelFocus(button);
  });
  return (
    <Show
      when={state()?.view() === "article" || (!state() && props.back)}
      fallback={
        <span class="help-head-tile" aria-hidden="true">
          <i class={props.tile} />
        </span>
      }
    >
      <IconButton class="help-head-back" label={t().backToTopics} title={t().back} onClick={() => state()?.back()}>
        <i class="ti ti-arrow-left" />
      </IconButton>
    </Show>
  );
}
