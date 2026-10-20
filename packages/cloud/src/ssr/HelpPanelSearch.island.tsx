import { Button, NoticeCard, useLocale } from "@k2b/ui";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { helpMessages } from "./help-messages";
import { panelElement } from "./layout-help-panel-lifecycle";
import { helpPanelModules } from "./layout-help-panel-modules";
import { type HelpPanelState, helpPanelState } from "./layout-help-panel-state";
import { panelIdle } from "./panel-idle";

export default function HelpPanelSearch() {
  const locale = useLocale();
  const t = () => helpMessages.resolve([locale()]).t;
  const [state, setState] = createSignal<HelpPanelState>();
  const [engine, setEngine] = createSignal<typeof import("./layout-help-panel-search")>();
  const [failed, setFailed] = createSignal(false);
  let input: HTMLInputElement | null = null;
  let pending: Promise<void> | undefined;
  let disposed = false;
  let lastValue = "";
  const reserve = () => {
    if (!input) return;
    const region = state()?.results();
    if (input.value.trim() && !lastValue.trim() && region) region.style.minHeight = `${region.offsetHeight}px`;
    if (!input.value.trim() && region) region.style.minHeight = "";
    lastValue = input.value;
  };
  const adopt = () => {
    reserve();
    // An empty field shows the start again, also after the search code failed to load.
    if (input && !input.value.trim()) setFailed(false);
    if (input && (engine() || failed() || !input.value.trim())) state()?.changeQuery(input.value);
  };
  const load = () =>
    (pending ??= helpPanelModules
      .search()
      .then((module) => {
        if (disposed) return;
        setFailed(false);
        setEngine(module);
        adopt();
      })
      .catch(() => {
        pending = undefined;
        if (!disposed && input?.value.trim()) {
          state()?.changeQuery(input.value);
          setFailed(true);
        }
      }));
  const intent = () => {
    void load();
  };
  onMount(() => {
    const current = helpPanelState(panelElement());
    setState(current);
    input = current.root.querySelector<HTMLInputElement>("[data-help-search]");
    if (!input) return;
    const typed = () => {
      reserve();
      intent();
      adopt();
    };
    // TextInput publishes every input event, including IME input; keep that existing behavior.
    input.addEventListener("input", typed);
    input.addEventListener("compositionend", typed);
    const intents = ["focus", "pointerdown", "keydown", "compositionstart"] as const;
    for (const event of intents) input.addEventListener(event, intent);
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === "Escape" && event.target === input && input?.value) {
        event.preventDefault();
        input.value = "";
        adopt();
        setFailed(false);
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (
        event.key === "/" &&
        !(
          event.target instanceof Element &&
          event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
        )
      ) {
        event.preventDefault();
        input?.focus();
      }
    };
    document.addEventListener("keydown", key);
    // A user can type before even the eager island arrives. The field itself has never been replaced.
    if (input.value) typed();
    onCleanup(panelIdle(intent));
    onCleanup(() => {
      input?.removeEventListener("input", typed);
      input?.removeEventListener("compositionend", typed);
      for (const event of intents) input?.removeEventListener(event, intent);
      document.removeEventListener("keydown", key);
    });
  });
  onCleanup(() => {
    disposed = true;
  });
  createEffect(() => {
    const current = state();
    const content = current?.root.querySelector<HTMLElement>("[data-help-start-content]");
    if (content) content.hidden = !!current?.query().trim() || failed();
  });
  return (
    <>
      <Show when={engine()}>
        {(module) => {
          const Results = module().HelpPanelSearchResults;
          return <Show when={state()}>{(current) => <Results state={current()} />}</Show>;
        }}
      </Show>
      <Show when={failed()}>
        <NoticeCard tone="danger" title={t().helpUnavailable} detail={t().helpUnavailableDetail}>
          <Button size="sm" variant="secondary" onClick={() => location.reload()}>
            {t().reload}
          </Button>
        </NoticeCard>
      </Show>
    </>
  );
}
