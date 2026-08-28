import { type DateContext, dates } from "@k2b/stdlib";
import { Button, DateTimePicker, prompts } from "@k2b/ui";
import { createMemo, createSignal, Show } from "solid-js";
import { mailRemainingMessages } from "./mail-remaining-messages";

const nextQuarterHour = (): string => {
  const date = new Date(Date.now() + 60 * 60_000);
  date.setUTCSeconds(0, 0);
  date.setUTCMinutes(Math.ceil(date.getUTCMinutes() / 15) * 15);
  return date.toISOString();
};

export const chooseScheduledSendTime = (dateConfig: DateContext): Promise<string | null | undefined> =>
  prompts.dialog<string | null>(
    (close) => {
      const messages = createMemo(() => mailRemainingMessages.resolve([dateConfig.locale ?? "en"]).t);
      const [value, setValue] = createSignal<string | null>(nextQuarterHour());
      const error = createMemo(() => {
        const instant = value() ? Date.parse(value()!) : Number.NaN;
        if (!Number.isFinite(instant)) return messages().chooseDeliveryTime;
        if (instant < Date.now() + 60_000) return messages().deliveryTimeInFuture;
        return null;
      });
      const schedule = () => {
        if (!value() || error()) return;
        close(value());
      };

      return (
        <div class="flex flex-col gap-4">
          <p class="text-sm text-secondary">{messages().scheduledMessageDescription}</p>
          <DateTimePicker
            label={messages().deliveryTime}
            placeholder={messages().chooseDateAndTime}
            value={value}
            onValueChange={setValue}
            dateConfig={dateConfig}
          />
          <Show
            when={error()}
            fallback={<p class="text-xs text-dimmed">{messages().timeZone({ timeZone: dateConfig.timeZone ?? "UTC" })}</p>}
          >
            {(message) => (
              <p class="text-xs text-red-600" role="alert">
                {message()}
              </p>
            )}
          </Show>
          <Show when={value() && !error()}>
            <div class="rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] px-3 py-2 text-sm text-secondary">
              <i class="ti ti-clock mr-2" aria-hidden="true" />
              {messages().scheduledFor({ date: dates.formatDateTime(value()!, dateConfig) })}
            </div>
          </Show>
          <div class="flex items-center justify-end gap-2">
            <Button variant="secondary" size="sm" type="button" onClick={() => close(null)}>
              {messages().cancel}
            </Button>
            <Button size="sm" type="button" disabled={Boolean(error())} onClick={schedule}>
              <i class="ti ti-calendar-time" aria-hidden="true" />
              {messages().schedule}
            </Button>
          </div>
        </div>
      );
    },
    { title: mailRemainingMessages.resolve([dateConfig.locale ?? "en"]).t.scheduleDelivery, icon: "ti ti-calendar-time", size: "medium" },
  );
