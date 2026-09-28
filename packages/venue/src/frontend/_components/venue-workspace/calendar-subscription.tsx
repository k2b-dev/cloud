import { mutation } from "@k2b/stdlib/solid";
import { Button, ButtonLink, CopyButton, InlineGuidance, PanelDialog, prompts, TextInput, toast, useLocale } from "@k2b/ui";
import { createSignal, onCleanup } from "solid-js";
import { apiClient } from "../../../api/client";
import { venueMessages } from "../../../messages";
import { readError } from "./utils";

/** A `webcal://` link asks the device's calendar app to subscribe to the feed instead of downloading it once. */
export const webcalUrl = (url: string): string => url.replace(/^https?:\/\//, "webcal://");

/**
 * The viewer's personal calendar feed: copy it, hand it to a calendar app, or renew it. Renewing replaces the
 * token on the server, so the old URL stops working; `onRenewed` hands the new URL to whoever opened the dialog.
 */
export function CalendarSubscriptionDialog(props: { url: string; onRenewed: (url: string) => void; close: () => void }) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const [url, setUrl] = createSignal(props.url);
  const [confirming, setConfirming] = createSignal(false);

  const renew = mutation.create<string, void>({
    mutation: async (_input, { abortSignal }) => {
      const res = await apiClient.calendar.my.renew.$post({}, { init: { signal: abortSignal } });
      if (!res.ok) throw new Error(await readError(res, t().renewCalendarLinkFailed));
      return (await res.json()).href;
    },
    onSuccess: (href) => {
      setUrl(href);
      props.onRenewed(href);
      toast.success(t().calendarLinkRenewed);
    },
    onError: (err) => prompts.error(err.message),
  });
  onCleanup(() => renew.abort());

  const confirmRenew = async () => {
    if (confirming() || renew.loading()) return;
    setConfirming(true);
    try {
      const confirmed = await prompts.confirm(t().renewCalendarLinkQuestion, {
        title: t().renewCalendarLink,
        variant: "danger",
        confirmText: t().renewLink,
      });
      if (confirmed) await renew.mutate();
    } finally {
      setConfirming(false);
    }
  };

  return (
    <PanelDialog>
      <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <PanelDialog.Header title={t().subscribeCalendar} icon="ti ti-calendar-share" close={props.close} />
        <PanelDialog.Body>
          <div class="grid gap-3">
            <p class="text-sm text-dimmed">{t().subscribeCalendarDescription}</p>
            <TextInput label={t().calendarLink} value={url} readOnly onFocus={(event) => event.currentTarget.select()} />
            <div class="flex flex-wrap gap-2">
              <ButtonLink href={webcalUrl(url())}>
                <i class="ti ti-calendar-plus" aria-hidden="true" /> {t().openInCalendarApp}
              </ButtonLink>
              <CopyButton
                value={url()}
                label={t().copyLink}
                variant="secondary"
                onCopyError={() => toast.error(t().copyCalendarLinkFailed)}
              />
            </div>
            <InlineGuidance tone="warning" icon="ti ti-lock">
              {t().calendarLinkPersonal}
            </InlineGuidance>
          </div>
        </PanelDialog.Body>
        <PanelDialog.Footer>
          <Button type="button" variant="secondary" size="sm" loading={renew.loading()} disabled={confirming()} onClick={confirmRenew}>
            {t().renewLink}
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={props.close}>
            {t().close}
          </Button>
        </PanelDialog.Footer>
      </div>
    </PanelDialog>
  );
}
