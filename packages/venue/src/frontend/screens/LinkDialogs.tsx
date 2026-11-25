import { clipboard } from "@k2b/stdlib/browser";
import { Button, Check, Choice, Dialog, Facts, Field, Notice, Text, useToast } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { apiClient } from "../../api/client";
import { webcalUrl } from "../_components/venue-workspace/calendar-subscription";
import { readError } from "../_components/venue-workspace/utils";
import { buildPublicVenueUrl, VENUE_PUBLIC_REFRESH_SECONDS, type VenuePublicDisplayHeight } from "../public-runtime";
import { useVenueWords } from "./messages";

/** The person's own calendar link: open it in a calendar app, copy it, or renew it so the old one stops working. */
export function CalendarSubscriptionDialog(props: { open: boolean; url: string; onRenewed: (url: string) => void; close: () => void }) {
  const { t } = useVenueWords();
  const toast = useToast();
  const [busy, setBusy] = createSignal(false);
  const renew = async () => {
    const agreed = await Dialog.confirm({
      title: t().renewCalendarLink,
      description: t().renewCalendarLinkQuestion,
      confirm: t().renewLink,
      cancel: t().cancel,
    });
    if (!agreed) return;
    setBusy(true);
    try {
      const response = await apiClient.calendar.my.renew.$post({});
      if (!response.ok) throw new Error(await readError(response, t().renewCalendarLinkFailed));
      props.onRenewed((await response.json()).href);
      toast(t().calendarLinkRenewed, { status: "ok" });
    } catch (failure) {
      toast(failure instanceof Error ? failure.message : t().renewCalendarLinkFailed, { status: "bad" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t().subscribeCalendar}
      open={props.open}
      onOpenChange={(open) => {
        if (!open && !busy()) props.close();
      }}
      foot={
        <>
          <Button busy={busy()} onClick={() => void renew()}>
            {t().renewLink}
          </Button>
          <Button variant="primary" icon="calendar-plus" href={webcalUrl(props.url)}>
            {t().openInCalendarApp}
          </Button>
        </>
      }
    >
      <Text>{t().subscribeCalendarDescription}</Text>
      <Facts items={[{ label: t().calendarLink, value: props.url, mono: true, copy: props.url }]} />
      <Notice tone="warn" icon="lock">
        {t().calendarLinkPersonal}
      </Notice>
    </Dialog>
  );
}

/** The public page's link for staff: a scrollable page or the full-height display for a monitor, live or not. */
export function PublicLinkDialog(props: { open: boolean; venueId: string; publicEnabled: boolean; close: () => void }) {
  const { t } = useVenueWords();
  const toast = useToast();
  const [height, setHeight] = createSignal<VenuePublicDisplayHeight>("scroll");
  const [refresh, setRefresh] = createSignal(false);
  const link = () => buildPublicVenueUrl(window.location.origin, props.venueId, { height: height(), refresh: refresh() });
  const copy = () =>
    void clipboard.copy(link()).then(
      () => toast(t().publicPageLinkCopied, { status: "ok" }),
      () => toast(t().copyPublicPageFailed, { status: "bad" }),
    );
  return (
    <Dialog
      title={t().publicPage}
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.close();
      }}
      foot={
        <>
          <Button icon="copy" onClick={copy}>
            {t().copyLink}
          </Button>
          <Button
            variant="primary"
            icon="external-link"
            onClick={() => {
              window.open(link(), "_blank", "noopener,noreferrer");
              props.close();
            }}
          >
            {t().openPage}
          </Button>
        </>
      }
    >
      <Text>{t().displayIntro}</Text>
      <Show when={!props.publicEnabled}>
        <Notice tone="note" icon="world-off">
          {t().publicPageOffForStaff}
        </Notice>
      </Show>
      <Field name="layout" label={t().pageLayout} hint={t().fullDisplayDescription}>
        <Choice
          name="layout"
          options={[
            { value: "scroll", label: t().scrollablePage },
            { value: "full", label: t().fullDisplay },
          ]}
          value={height()}
          onChange={(value) => {
            const next = value === "full" ? "full" : "scroll";
            setHeight(next);
            if (next === "full") setRefresh(true);
          }}
        />
      </Field>
      <Field name="refresh" label={t().liveUpdates} hint={t().liveUpdatesDescription({ seconds: VENUE_PUBLIC_REFRESH_SECONDS })}>
        <Check switch label={t().autoRefresh} checked={refresh()} onChange={setRefresh} />
      </Field>
    </Dialog>
  );
}
