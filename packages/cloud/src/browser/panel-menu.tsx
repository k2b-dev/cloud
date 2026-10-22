import { Dropdown } from "@k2b/ui";
import { createSignal, onCleanup, onMount } from "solid-js";
import { platformMessages } from "../ssr/platform-messages";
import type { PanelState } from "./panel-context-bridge";

/**
 * The slot head's ⋯ menu for providers that need consent. The lazy slot controller mounts it over the server's
 * placeholder button, so it costs no island and can never change an answer before the controller listens. Only
 * document events cross the menu/controller boundary.
 */
export default function PanelMenu(props: { initial: PanelState; locale: string }) {
  const t = () => platformMessages.resolve([props.locale]).t;
  const [state, setState] = createSignal(props.initial);
  const [open, setOpen] = createSignal(false);
  onMount(() => {
    const changed = (event: CustomEvent<PanelState>) => {
      // A closed slot, another provider or one without consent leaves no reason for the menu to stay expanded.
      if (!event.detail.open || event.detail.provider !== state().provider || !event.detail.consent) setOpen(false);
      setState(event.detail);
    };
    window.addEventListener("cloud.panel.state", changed);
    onCleanup(() => window.removeEventListener("cloud.panel.state", changed));
  });
  return (
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
  );
}
