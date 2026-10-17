/**
 * Stored settings this application cannot read (#1303).
 *
 * The server reports `unreadable` when a row exists but does not decrypt or
 * validate here; the value on the page is the fallback in use. The notice
 * explains that state once per page and offers the explicit reset. Entering a
 * new value in the field is the other recovery: the form then sends the key in
 * `replaceUnreadable`, the only way the server accepts a write over that row.
 */

import { Button, NoticeCard, StatusBadge, useLocale } from "@k2b/ui";
import { For, Show } from "solid-js";
import type { SettingFieldDef } from "./CoreSettingsForm.island";
import { settingsMessages } from "./messages";

type UnreadableEntry = Pick<SettingFieldDef, "key" | "label" | "unreadable">;

/** Keys of changed values that knowingly replace an unreadable stored row. */
export const unreadableReplacements = (updates: Record<string, unknown>, entries: Record<string, UnreadableEntry | undefined>) =>
  Object.keys(updates).filter((key) => entries[key]?.unreadable === true);

export function UnreadableSettingBadge() {
  const locale = useLocale();
  const t = () => settingsMessages.resolve([locale()]).t;
  return <StatusBadge tone="warning" label={t().unreadableValue} />;
}

export function UnreadableSettingsNotice(props: {
  entries: readonly UnreadableEntry[];
  canUseDefault: (key: string) => boolean;
  onUseDefault: (key: string) => void;
}) {
  const locale = useLocale();
  const t = () => settingsMessages.resolve([locale()]).t;
  const unreadable = () => props.entries.filter((entry) => entry.unreadable);
  return (
    <Show when={unreadable().length > 0}>
      <NoticeCard tone="warning" title={t().unreadableTitle({ count: unreadable().length })} detail={t().unreadableDetail}>
        <ul class="flex flex-col gap-2">
          <For each={unreadable()}>
            {(entry) => (
              <li class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1" data-setting={entry.key}>
                <span class="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <span class="font-medium text-primary">{entry.label}</span>
                  <code class="text-[10px] text-dimmed">{entry.key}</code>
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={!props.canUseDefault(entry.key)}
                  onClick={() => props.onUseDefault(entry.key)}
                  aria-label={t().useDefaultFor({ label: entry.label })}
                >
                  <i class="ti ti-arrow-back-up" /> {t().useDefault}
                </Button>
              </li>
            )}
          </For>
        </ul>
      </NoticeCard>
    </Show>
  );
}
