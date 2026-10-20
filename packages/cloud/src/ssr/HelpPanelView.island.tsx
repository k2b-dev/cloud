import { createSignal, onCleanup, onMount } from "solid-js";
import { getContext, onContextChange } from "../browser/panel";
import { capturePanelFocus, panelElement, restorePanelFocus } from "./layout-help-panel-lifecycle";
import { helpPanelState } from "./layout-help-panel-state";
import type { HelpTopic } from "./layout-help-registry";
import { helpStart } from "./layout-help-start";
import { HelpViewSection } from "./layout-help-views";

capturePanelFocus();
export default function HelpPanelView(props: { topics: readonly HelpTopic[] }) {
  const [topics, setTopics] = createSignal(props.topics);
  onMount(() => {
    const wrapper = panelElement();
    const state = helpPanelState(wrapper);
    const update = (context: ReturnType<typeof getContext>) => {
      const next = helpStart(state.data.documents, context && context.app === state.data.appId ? (context.help ?? []) : []).view;
      // Retain row identity when the blob and island props name the same topic, including the first host snapshot.
      setTopics((previous) => next.map((topic) => previous.find((candidate) => candidate.id === topic.id) ?? topic));
    };
    onCleanup(onContextChange(update));
    const section = wrapper.querySelector("[data-help-view]");
    if (section) restorePanelFocus(section);
    const context = getContext();
    if (context) update(context);
  });
  return <HelpViewSection items={topics()} onOpen={() => {}} />;
}
