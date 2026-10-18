import { Dropdown, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount } from "solid-js";
import { isServer } from "solid-js/web";
import type { PanelState } from "../browser/panel-context-bridge";
import { platformMessages } from "./platform-messages";

/** Only document events cross the menu/controller boundary, including when either bundle arrives late. */
export default function PanelMenu(props: { initial: PanelState }) {
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  const initial = () => {
    if (isServer) return props.initial;
    const slot = document.getElementById("cloud-panel");
    return slot
      ? {
          provider: slot.dataset.provider ?? props.initial.provider,
          appName: slot.dataset.appName ?? props.initial.appName,
          consent: slot.dataset.providerConsent === "true",
          allowed: slot.dataset.contextAllowed === "true",
          // Until the lazy controller has installed (it writes this attribute), a change would have no listener.
          saving: slot.dataset.consentSaving !== "false",
        }
      : props.initial;
  };
  const [state, setState] = createSignal(initial());
  const [open, setOpen] = createSignal(false);
  onMount(() => {
    const changed = (event: CustomEvent<PanelState>) => {
      if (event.detail.provider !== state().provider || !event.detail.consent) setOpen(false);
      setState(event.detail);
    };
    window.addEventListener("cloud.panel.state", changed);
    onCleanup(() => window.removeEventListener("cloud.panel.state", changed));
  });
  return (
    <span
      data-cloud-panel-menu=""
      class="cloud-panel__menu"
      style={{ visibility: state().consent ? "visible" : "hidden" }}
      inert={!state().consent}
    >
      <Dropdown.Root
        open={open()}
        onOpenChange={setOpen}
        label={t().panelMenu}
        position="bottom-left"
        items={[
          {
            sectionLabel: t().panelFrom({ app: state().appName }),
            items: [
              {
                label: t().panelShareContext,
                choice: "checkbox",
                // A getter: the menu keeps its rows, so a plain value would show the answer from when it opened.
                checked: () => state().allowed,
                disabled: state().saving,
                action: () =>
                  window.dispatchEvent(
                    new CustomEvent("cloud.panel.consent", {
                      detail: { provider: state().provider, allowed: !state().allowed },
                    }),
                  ),
              },
            ],
          },
        ]}
      >
        <Dropdown.Trigger iconOnly label={t().panelMenu} disabled={!state().consent}>
          <i class="ti ti-dots" aria-hidden="true" />
        </Dropdown.Trigger>
      </Dropdown.Root>
    </span>
  );
}
