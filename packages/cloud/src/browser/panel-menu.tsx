import { Dropdown } from "@k2b/ui";
import { type Accessor, createEffect, createSignal } from "solid-js";
import { platformMessages } from "../ssr/platform-messages";
import type { PanelState } from "./panel-context-bridge";

/** The lazy controller mounts this menu over the server-rendered button after its consent listener is ready. */
export default function PanelMenu(props: { state: Accessor<PanelState>; locale: string }) {
  const t = () => platformMessages.resolve([props.locale]).t;
  const state = props.state;
  const [open, setOpen] = createSignal(false);
  let provider = state().provider;
  createEffect(() => {
    const current = state();
    // A closed slot, another provider or one without consent leaves no reason for the menu to stay expanded.
    if (!current.open || current.provider !== provider || !current.consent) setOpen(false);
    provider = current.provider;
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
              // Rows persist while consent changes: read both the answer and saving state reactively.
              checked: () => state().allowed,
              get disabled() {
                return state().saving;
              },
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
