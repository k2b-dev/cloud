import { navigateTo } from "@k2b/ssr/nav";
import { Button, IconButton, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, Show } from "solid-js";
import type { Dashboard } from "../../dashboard-contracts";
import { usePulseMessages } from "../use-messages";
import { createDashboardSharing } from "./dashboard-sharing";
import { launchPulseDashboardAssistant } from "./pulse-assistant-launch";

/** One action state shared by the desktop toolbar and the phone heading. */
export const createDashboardActions = (input: { dashboard: Dashboard; base: { id: string; name: string }; canWrite: boolean }) => {
  const t = usePulseMessages(),
    locale = useLocale();
  const sharing = createDashboardSharing(input.dashboard);
  const [assistantPending, setAssistantPending] = createSignal(false);
  const [assistantError, setAssistantError] = createSignal(false);
  const [denied, setDenied] = createSignal(false);
  let disposed = false;
  const dispose = () => {
    disposed = true;
    sharing.dispose();
  };
  onCleanup(dispose);
  const askAssistant = async () => {
    if (assistantPending() || denied()) return;
    setAssistantPending(true);
    setAssistantError(false);
    try {
      const result = await launchPulseDashboardAssistant({ base: input.base, dashboard: input.dashboard, locale: locale() });
      if (!disposed) navigateTo(result.href);
    } catch {
      if (!disposed) setAssistantError(true);
    } finally {
      if (!disposed) setAssistantPending(false);
    }
  };
  const Buttons = (props: { compact?: boolean }) => (
    <Show when={!denied()}>
      <Show when={input.canWrite}>
        <Show
          when={props.compact}
          fallback={
            <Button variant="ghost" disabled={sharing.pending()} onClick={() => void sharing.open()}>
              <i class="ti ti-share" aria-hidden="true" />
              {t().dashboardShare}
            </Button>
          }
        >
          <IconButton label={t().dashboardShare} disabled={sharing.pending()} onClick={() => void sharing.open()}>
            <i class="ti ti-share" aria-hidden="true" />
          </IconButton>
        </Show>
      </Show>
      <Show
        when={props.compact}
        fallback={
          <Button variant="ai" disabled={assistantPending()} onClick={() => void askAssistant()}>
            <i class="ti ti-sparkles" aria-hidden="true" />
            {t().sqlAskAssistant}
          </Button>
        }
      >
        <IconButton label={t().sqlAskAssistant} variant="ai" disabled={assistantPending()} onClick={() => void askAssistant()}>
          <i class="ti ti-sparkles" aria-hidden="true" />
        </IconButton>
      </Show>
    </Show>
  );
  return { Buttons, assistantPending, assistantError, askAssistant, denied, setDenied, dispose };
};
export type DashboardActions = ReturnType<typeof createDashboardActions>;
