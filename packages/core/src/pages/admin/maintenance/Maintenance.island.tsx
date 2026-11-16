import { MAINTENANCE_MESSAGE_MAX_LENGTH, type MaintenanceStatus } from "@k2b/cloud/contracts/maintenance";
import type { DateContext } from "@k2b/stdlib";
import { Button, DateTimePicker, DescriptionList, NoticeCard, prompts, Section, StatusBadge, TextInput, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { bypassHref, maintenanceApi, waitForGatewayMaintenance } from "./client";
import { maintenanceAdminMessages } from "./messages";
import { openMoveEndDialog } from "./move-end-dialog";
import { activeRows } from "./rows";
import { isFutureEnd, todayKey } from "./time";

/** While maintenance runs, the apps line follows the apps as they come back. */
const REFRESH_MS = 10_000;

type Busy = "start" | "stop" | null;
type Failure = { message: string; retry?: () => void };

export default function Maintenance(props: {
  initial: MaintenanceStatus;
  /** App names by id, for apps that are still starting and so are not in the registry. */
  appNames: Record<string, string>;
  dateConfig: DateContext;
  /** This page's path; the bypass link brings the browser back here. */
  path: string;
  /** The planned end the start form suggests, chosen by the server so both renders show the same field. */
  suggestedEnd: string;
}) {
  const locale = useLocale();
  const t = () => maintenanceAdminMessages.resolve([locale()]).t;
  const timeZone = () => props.dateConfig.timeZone ?? "UTC";
  /** The pickers commit instants in the viewer's zone and name it; without a zone they would commit wall times. */
  const pickerConfig = () => ({ ...props.dateConfig, timeZone: timeZone(), locale: locale() });
  const [status, setStatus] = createSignal(props.initial);
  const [message, setMessage] = createSignal("");
  // A planned end is suggested; clearing the field means none.
  const [until, setUntil] = createSignal<string | null>(props.suggestedEnd);
  const [untilError, setUntilError] = createSignal<string>();
  const [busy, setBusy] = createSignal<Busy>(null);
  const [failure, setFailure] = createSignal<Failure | null>(null);
  const [now, setNow] = createSignal(Date.now());

  onMount(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      if (!status().active || busy() !== null || document.visibilityState === "hidden") return;
      maintenanceApi.status().then(
        (next) => {
          setStatus(next);
          setFailure((current) => (current?.message === t().refreshFailed ? null : current));
        },
        () => setFailure((current) => current ?? { message: t().refreshFailed }),
      );
    }, REFRESH_MS);
    onCleanup(() => clearInterval(timer));
  });

  /** Lets this browser past the wall it just raised: the gateway turns the link into a cookie and comes back here. */
  const enter = async () => {
    setBusy("start");
    setFailure(null);
    try {
      const link = await maintenanceApi.bypass();
      await waitForGatewayMaintenance();
      window.location.assign(bypassHref(link.url, props.path));
    } catch {
      setFailure({ message: t().startedNoLink, retry: () => void enter() });
      setBusy(null);
    }
  };

  const start = async () => {
    const end = until() ?? undefined;
    if (end && !isFutureEnd(end)) {
      setUntilError(t().timePassed);
      return;
    }
    setUntilError(undefined);
    setFailure(null);
    setBusy("start");
    try {
      setStatus(await maintenanceApi.on({ ...(message().trim() ? { message: message() } : {}), ...(end ? { until: end } : {}) }));
    } catch {
      setFailure({ message: t().startFailed });
      setBusy(null);
      return;
    }
    // From here on everyone else sees the maintenance page; the button stays busy until this browser is let in.
    await enter();
  };

  const moveEnd = async () => {
    setFailure(null);
    const next = await openMoveEndDialog(status().until, pickerConfig());
    if (next) setStatus(next);
  };

  const stop = async () => {
    const confirmed = await prompts.confirm(t().stopText, { title: t().stopTitle, icon: "ti ti-barrier-block-off", confirmText: t().stop });
    if (!confirmed) return;
    setFailure(null);
    setBusy("stop");
    try {
      await maintenanceApi.off();
      window.location.reload();
    } catch {
      setFailure({ message: t().stopFailed, retry: () => void stop() });
      setBusy(null);
    }
  };

  const failureNotice = () => (
    <Show when={failure()}>
      {(current) => (
        <NoticeCard
          tone="danger"
          icon="ti ti-alert-circle"
          role="alert"
          actions={
            <Show when={current().retry}>
              {(retry) => (
                <Button type="button" size="sm" variant="secondary" onClick={() => retry()()}>
                  {t().retry}
                </Button>
              )}
            </Show>
          }
        >
          {current().message}
        </NoticeCard>
      )}
    </Show>
  );

  return (
    <Section
      size="md"
      title={t().title}
      data-maintenance-admin={status().active ? "active" : "off"}
      meta={
        <StatusBadge
          tone={status().active ? "warning" : "neutral"}
          variant={status().active ? "text" : "dot"}
          icon={status().active ? "ti ti-barrier-block" : null}
          label={status().active ? t().active : t().off}
          labels={[t().active, t().off]}
        />
      }
      description={status().active ? t().activeDescription : t().offDescription}
      footer={
        <Show
          when={status().active}
          fallback={
            <>
              <span class="me-auto min-w-40 flex-1 text-xs text-dimmed">
                {t().cliHintBefore}
                <code>cld admin maintenance off</code>
                {t().cliHintAfter}
              </span>
              <Button type="button" variant="primary" loading={busy() === "start"} loadingLabel={t().starting} onClick={() => void start()}>
                {t().start}
              </Button>
            </>
          }
        >
          <Button
            type="button"
            variant="secondary"
            class="ms-auto"
            disabled={busy() !== null}
            onClick={() => void moveEnd()}
          >
            {t().moveEnd}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={busy() === "start"}
            loading={busy() === "stop" || busy() === "start"}
            loadingLabel={t().stopping}
            onClick={() => void stop()}
          >
            {t().stop}
          </Button>
        </Show>
      }
    >
      <div class="flex flex-col gap-4">
        <Show
          when={status().active}
          fallback={
            <>
              <TextInput
                multiline
                lines={2}
                label={t().message}
                description={t().messageHint}
                maxLength={MAINTENANCE_MESSAGE_MAX_LENGTH}
                value={message}
                disabled={busy() !== null}
                onValueChange={setMessage}
              />
              <DateTimePicker
                class="sm:max-w-sm"
                label={t().until}
                description={t().untilHint}
                placeholder={t().endPlaceholder}
                value={until}
                dateConfig={pickerConfig()}
                min={todayKey(timeZone())}
                clearable
                error={untilError}
                disabled={busy() !== null}
                onValueChange={(value) => {
                  setUntil(value);
                  setUntilError(value && !isFutureEnd(value) ? t().timePassed : undefined);
                }}
              />
            </>
          }
        >
          <DescriptionList
            layout="rows"
            items={activeRows(status(), { t: t(), locale: locale(), dateConfig: props.dateConfig, appNames: props.appNames, now: now() })}
          />
        </Show>
        {failureNotice()}
      </div>
    </Section>
  );
}
