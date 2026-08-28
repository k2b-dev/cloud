import { Match, Switch } from "solid-js";
import { useLocale } from "@k2b/ui";
import { notebookSettingsMessages } from "./messages";

export const settingsChoiceClass = (active: boolean) =>
  `relative rounded-[var(--ui-radius-surface)] border border-[var(--ui-border)] bg-[var(--ui-surface)] p-4 text-left shadow-[var(--ui-shadow-surface)] transition-[background-color,box-shadow,color] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 ${
    active
      ? "text-blue-700 dark:text-blue-300 before:absolute before:left-2 before:top-4 before:h-3.5 before:w-0.5 before:rounded-full before:bg-blue-500 dark:before:bg-blue-400"
      : "text-secondary"
  }`;

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
