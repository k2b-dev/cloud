import { useLocale } from "@k2b/ui";
import { Match, Switch } from "solid-js";
import { notebookSettingsMessages } from "./messages";

export function SaveStatus(props: { loading: boolean; saved: boolean; error?: string | null; label?: string }) {
  const locale = useLocale();
  const t = () => notebookSettingsMessages.resolve([locale()]).t;
  return (
    <span aria-live="polite">
      <Switch>
        <Match when={props.loading}>
          <span class="inline-flex items-center gap-1.5 text-xs text-dimmed">
            <i class="ti ti-loader-2 animate-spin" aria-hidden="true" />
            {t().saving}
          </span>
        </Match>
        <Match when={props.error}>
          <span class="inline-flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
            <i class="ti ti-alert-circle" aria-hidden="true" />
            {t().failed}
          </span>
        </Match>
        <Match when={props.saved}>
          <span class="inline-flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
            <i class="ti ti-check" aria-hidden="true" />
            {props.label ?? t().saved}
          </span>
        </Match>
      </Switch>
    </span>
  );
}
