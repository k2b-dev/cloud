import { Button, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import { venueMessages } from "../messages";

export type RefreshDiagnostics = {
  refreshEnabled: boolean;
  refreshedAt: string | null;
  refreshError: string | null;
  refreshing: boolean;
  retryRefresh: () => void;
};

export function PublicRefreshNotice(props: RefreshDiagnostics & { display?: boolean }) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  return (
    <Show when={props.refreshError}>
      <div
        role="status"
        class={`${props.display ? "absolute right-5 top-5 z-20 lg:right-8 lg:top-8" : "fixed right-4 top-4 z-30"} flex items-center gap-3 rounded-xl bg-zinc-950/90 px-3 py-2 text-sm text-white shadow-lg ring-1 ring-white/15 backdrop-blur`}
      >
        <i class="ti ti-cloud-off shrink-0 text-amber-300" aria-hidden="true" />
        <span>{t().liveUpdatesPaused}</span>
        <Button type="button" variant="secondary" size="sm" disabled={props.refreshing} onClick={props.retryRefresh}>
          {props.refreshing ? t().retrying : t().retry}
        </Button>
      </div>
    </Show>
  );
}
