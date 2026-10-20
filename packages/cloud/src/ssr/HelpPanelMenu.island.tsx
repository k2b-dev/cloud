import { Button, NoticeCard, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { helpMessages } from "./help-messages";
import { HelpPanelMenuTrigger } from "./layout-help-panel-controls";
import { capturePanelFocus, panelElement, restorePanelFocus } from "./layout-help-panel-lifecycle";
import type { MenuActivation } from "./layout-help-panel-menu";
import { type HelpPanelState, helpPanelState } from "./layout-help-panel-state";
import { panelIdle } from "./panel-idle";

capturePanelFocus();
export default function HelpPanelMenu() {
  const locale = useLocale();
  const t = () => helpMessages.resolve([locale()]).t;
  const [menu, setMenu] = createSignal<typeof import("./layout-help-panel-menu")>();
  const [error, setError] = createSignal(false);
  let state: HelpPanelState | undefined;
  let loaded: typeof import("./layout-help-panel-menu") | undefined;
  let pending: Promise<typeof import("./layout-help-panel-menu")> | undefined;
  let activation: MenuActivation = { key: "ArrowDown", focus: false };
  let disposed = false;
  let pressed = false;
  let queued: { key: string; trigger: HTMLButtonElement; pointer: boolean } | undefined;
  const load = () =>
    (pending ??= import("./layout-help-panel-menu")
      .then((module) => {
        loaded = module;
        return module;
      })
      .catch((error: unknown) => {
        pending = undefined;
        throw error;
      }));
  const warm = () => {
    void load().catch(() => {});
  };
  const activate = (key: string, trigger: HTMLButtonElement, pointer = false) => {
    if (pressed) {
      queued = { key, trigger, pointer };
      return;
    }
    activation = { key, focus: document.activeElement === trigger, pointer };
    setError(false);
    if (loaded) {
      setMenu(loaded);
      return;
    }
    void load()
      .then((module) => {
        if (disposed) return;
        if (pressed) {
          queued = { key, trigger, pointer };
          return;
        }
        setMenu(module);
      })
      .catch(() => {
        if (!disposed) setError(true);
      });
  };
  const endPress = () => {
    pressed = false;
    const next = queued;
    queued = undefined;
    if (next) activate(next.key, next.trigger, next.pointer);
  };
  const cancelPress = () => {
    pressed = false;
    queued = undefined;
  };
  onMount(() => {
    const wrapper = panelElement();
    state = helpPanelState(wrapper);
    const button = wrapper.querySelector("[data-help-menu]");
    if (button) restorePanelFocus(button);
    onCleanup(panelIdle(warm));
    window.addEventListener("pointerup", endPress);
    window.addEventListener("pointercancel", cancelPress);
    onCleanup(() => {
      window.removeEventListener("pointerup", endPress);
      window.removeEventListener("pointercancel", cancelPress);
    });
  });
  onCleanup(() => {
    disposed = true;
  });
  return (
    <Show
      when={menu()}
      fallback={
        <>
          <HelpPanelMenuTrigger
            label={t().moreActions}
            onPointerEnter={warm}
            onPointerDown={() => {
              pressed = true;
              warm();
            }}
            onFocus={warm}
            onClick={(event) => activate("ArrowDown", event.currentTarget, event.detail > 0)}
            onKeyDown={(event) => {
              warm();
              if (!["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) return;
              event.preventDefault();
              event.stopPropagation();
              activate(event.key, event.currentTarget);
            }}
          />
          <Show when={error()}>
            <NoticeCard class="absolute z-50" tone="danger" title={t().loadFailed} detail={t().loadFallback}>
              <Button size="sm" variant="secondary" onClick={(event) => activate("ArrowDown", event.currentTarget)}>
                {t().tryAgain}
              </Button>
            </NoticeCard>
          </Show>
        </>
      }
    >
      {(module) => {
        const Menu = module().HelpPanelMenu;
        return state && <Menu state={state} activation={activation} />;
      }}
    </Show>
  );
}
